using System.Text.Json;
using Autodesk.Revit.DB;
using RevitMCP.Bridge;
using RevitMCP.Commands.Dispatch;

namespace RevitMCP.Commands;

/// <summary>
/// Changes elements that exist, as one transaction: moves them, turns them, gives them another type and writes their parameters. Within an item
/// the order is the move, the turn, the type and then the parameters, so a parameter written last wins over what a move did to it. Everything
/// knowable is checked before the transaction and refused naming the item: that the element is in the model and is no type, that a move or a
/// turn has a point or a line to act on and the element is not pinned, that <see cref="Element.IsValidType(ElementId)"/> holds before
/// <see cref="Element.ChangeTypeId(ElementId)"/>, and that each parameter is a <see cref="BuiltInParameter"/> the element has, can write,
/// and is given a value of its kind. What Revit does with it is then read back from the model and compared with the request, after each
/// stage and again after the commit (the type and the parameters), and an item that Revit took and did not land fails and rolls the batch back.
/// <para>
/// Live Revit (the tests of this command): MoveElement accepts, with no warning and no exception, a wall moved up or down, a door moved across its
/// wall, and the part of a move along a wall that is joined to others at its ends, and in each case leaves the element where it was. So the first two are
/// refused before the transaction, and the third, which depends on the joins, fails its item with the real place in the message. A door moved along its
/// wall past the end of it is refused only by the commit, and lands as rolled back with the reason in errors. A pin is the parameter
/// <c>ELEMENT_LOCKED_PARAM</c> (true pins), and a pinned element is refused a move and a turn and nothing else.
/// </para>
/// <para>
/// Only a length is converted, from millimetres, through <see cref="Units"/>. A double parameter can hold an angle, a plain number, an area, a volume
/// or a slope as well, and each has its own unit (<see cref="Definition.GetDataType"/> says which), so a double whose data type is no length is refused
/// naming its spec, and nothing is guessed. An element-id value must name an element that exists. The parameter of an element is looked up on the element
/// itself, and a parameter of its type is not found there, so it reads as one the element does not have; if Revit ever hands back a parameter whose
/// <see cref="Parameter.Element"/> is another element, it is refused as the type's.
/// </para>
/// <para>
/// A turn is about the vertical through the point of an element with a point location, which is how place_instances turns it, and through the
/// middle of the two ends of the axis of an element with a line location, such as a wall. <c>rotateDeg</c> is added to the turn the element has,
/// counter-clockwise seen from above, as <c>moveMm</c> is added to its place. A hosted instance takes its direction from its host, so it is not turned.
/// A move and a turn are compared with where the element was when its own stage began, so the items of one call are each judged against the model as
/// the earlier ones left it: a wall and its door can be moved in one call. The status of an item is <see cref="ItemStatus.Updated"/> when it
/// changed something, and <see cref="ItemStatus.Unchanged"/>, with no transaction, when the element held all of it already.
/// </para>
/// </summary>
public sealed class UpdateElementsCommand : ICommand
{
    /// <summary>A position or a length closer than this to the one asked for is the same one: the noise of converting units.</summary>
    private const double SamePositionMm = 0.1;

    /// <summary>The same for an angle.</summary>
    private const double SameAngleDeg = 0.01;

    private const double FullTurnDeg = 360;

    /// <summary>An angle read back from Revit carries noise in the 13th place, which <c>actual</c> does not show.</summary>
    private const int RotationDecimals = 6;

    /// <summary>The most choices a refusal lists, so a type with hundreds of valid types does not bury the message.</summary>
    private const int MaxListed = 50;

    private static readonly string[] ItemKeys = ["id", "moveMm", "rotateDeg", "typeId", "parameters"];

    private static readonly string[] ParameterKeys = ["builtIn", "value"];

    /// <summary>Every name of <see cref="BuiltInParameter"/>, case-sensitive. Parsing a number would also succeed, and a number is no name.</summary>
    private static readonly HashSet<string> BuiltInNames = new(Enum.GetNames<BuiltInParameter>(), StringComparer.Ordinal);

    public string Method => MethodNames.UpdateElements;

    public bool NeedsDocument => true;

    public JsonElement Execute(CommandContext context, JsonElement parameters)
    {
        var document = context.Document!;
        var entries = ItemBatch.ReadItems(parameters, Method)
            .Select((item, index) => ReadUpdate(document, item, index))
            .ToList();

        RefuseRepeatedElements(entries);

        // Kept for the read-back, which comes after the commit and gets the element only.
        var asked = entries.ToDictionary(entry => entry.Input.Id, entry => entry.Input);

        return ItemBatch.Run(
            document,
            Method,
            entries,
            input => Apply(document, input),
            element => Describe(document, element, asked[element.Id]),
            problemAfterCommit: element => ProblemAfterCommit(element, asked[element.Id]),
            landedStatus: ItemStatus.Updated);
    }

    private static Element Apply(Document document, UpdateInput input)
    {
        var element = document.GetElement(input.Id) ?? throw new InvalidOperationException($"Element {input.Id} is not in the model.");

        if (input.Move is { } move && !IsZero(move))
        {
            MoveBy(document, element, move);
        }

        if (input.TurnDeg is { } turn && Normalize(turn) != 0)
        {
            Turn(document, element, turn);
        }

        if (input.TypeId is { } typeId && !SameId(element.GetTypeId(), typeId))
        {
            Retype(document, element, typeId);
        }

        foreach (var wanted in input.Parameters)
        {
            Write(document, element, wanted);
        }

        return document.GetElement(input.Id) ?? throw new InvalidOperationException($"Element {input.Id} is not in the model after the change.");
    }

    private static void MoveBy(Document document, Element element, XYZ by)
    {
        var before = ReadPlacement(element) ?? throw new InvalidOperationException($"{What(element)} has no point or line location now, so a move cannot be checked.");
        var host = HostOf(element);
        var joined = JoinedEnds(element);

        ElementTransformUtils.MoveElement(document, element.Id, by);
        document.Regenerate();

        var after = document.GetElement(element.Id);
        var expected = before.Moved(by);

        if (ReadPlacement(after) is not { } found)
        {
            throw new InvalidOperationException($"After the move {What(element)} has no point or line location, so the move cannot be checked.");
        }

        if (found.Differs(expected) is { } difference)
        {
            throw new InvalidOperationException(
                $"Revit took the move by ({Units.FormatNumber(Units.InternalToMm(by.X))}, {Units.FormatNumber(Units.InternalToMm(by.Y))}, {Units.FormatNumber(Units.InternalToMm(by.Z))}) mm, "
                + $"but {What(element)} {difference}. It was {before.Describe()}."
                + (joined > 0
                    ? $" The wall is joined to other walls at its ends ({joined} joins), and Revit keeps a joined end on its neighbour, so the part of the move that runs along the wall is not applied; a move across the wall is."
                    : string.Empty));
        }

        RequireSameHost(element, host, after);
    }

    private static void Turn(Document document, Element element, double degrees)
    {
        var before = ReadPlacement(element) ?? throw new InvalidOperationException($"{What(element)} has no point or line location now, so a turn cannot be checked.");
        var about = before.AxisPoint;
        var angle = Units.DegToRad(degrees);
        var host = HostOf(element);

        ElementTransformUtils.RotateElement(document, element.Id, Line.CreateBound(about, about + XYZ.BasisZ), angle);
        document.Regenerate();

        var after = document.GetElement(element.Id);
        var expected = before.Turned(angle, about);

        if (ReadPlacement(after) is not { } found)
        {
            throw new InvalidOperationException($"After the turn {What(element)} has no point or line location, so the turn cannot be checked.");
        }

        if (found.Differs(expected) is { } difference)
        {
            throw new InvalidOperationException(
                $"Revit took the turn by {Units.FormatNumber(degrees)} degrees about the vertical through ({Units.FormatNumber(Units.InternalToMm(about.X))}, {Units.FormatNumber(Units.InternalToMm(about.Y))}) mm, "
                + $"but {What(element)} {difference}. It was {before.Describe()}.");
        }

        RequireSameHost(element, host, after);
    }

    private static void Retype(Document document, Element element, ElementId typeId)
    {
        var replacement = element.ChangeTypeId(typeId);

        if (!SameId(replacement, ElementId.InvalidElementId))
        {
            // Revit's own words: this happens for a normal wall type given to a curtain panel, and the old element becomes invalid.
            throw new InvalidOperationException(
                $"Revit did not change the type of {What(element)} in place: it made a new element {replacement} and the old one is gone. Nothing of this call stays.");
        }

        document.Regenerate();

        if (!SameId(document.GetElement(element.Id)?.GetTypeId(), typeId))
        {
            throw new InvalidOperationException($"Revit took the new type {typeId} for {What(element)}, but the element does not hold it.");
        }
    }

    private static void Write(Document document, Element element, Wanted wanted)
    {
        var parameter = element.get_Parameter(wanted.Parameter)
            ?? throw new InvalidOperationException($"{What(element)} has no parameter {wanted.Name} now, so {wanted.Show} cannot be written.");

        if (wanted.Holds(parameter))
        {
            return;
        }

        if (parameter.IsReadOnly)
        {
            throw new InvalidOperationException($"Parameter {wanted.Name} of {What(element)} is read-only now, so {wanted.Show} cannot be written.");
        }

        if (!wanted.Set(parameter))
        {
            throw new InvalidOperationException($"Revit refused {wanted.Show} for parameter {wanted.Name} of {What(element)}: its Set returned false, so the value is not one the parameter takes.");
        }

        document.Regenerate();

        var written = document.GetElement(element.Id)?.get_Parameter(wanted.Parameter);

        if (written is null || !wanted.Holds(written))
        {
            throw new InvalidOperationException(
                $"Revit took {wanted.Show} for parameter {wanted.Name} of {What(element)}, but the parameter holds {wanted.ReadText(written)}.");
        }
    }

    /// <summary>A hosted instance has to stay in its host: a move that Revit answers by taking it out is not a move.</summary>
    private static void RequireSameHost(Element element, ElementId? before, Element after)
    {
        if (!SameId(HostOf(after), before))
        {
            throw new InvalidOperationException(
                $"After the change {What(element)} is hosted by {(HostOf(after) is { } host ? $"element {host}" : "nothing")} and not by element {(before is { } was ? was.ToString() : "none")}, so it left its host.");
        }
    }

    /// <summary>How many walls are joined to the ends of a wall; 0 for anything else.</summary>
    private static int JoinedEnds(Element element) =>
        element is Wall { Location: LocationCurve curve } ? (curve.get_ElementsAtJoin(0)?.Size ?? 0) + (curve.get_ElementsAtJoin(1)?.Size ?? 0) : 0;

    private static ElementId? HostOf(Element element) => (element as FamilyInstance)?.Host?.Id;

    /// <summary>Two IDs are the same when their values are, and both being absent is the same too.</summary>
    private static bool SameId(ElementId? first, ElementId? second) => first is null ? second is null : second is not null && first.Value == second.Value;

    /// <summary>What an item can no longer be taken for after the commit: the type and the parameters, which no later item changes. Where an element stands may be moved by the item of its host, so that is not judged here.</summary>
    private static string? ProblemAfterCommit(Element element, UpdateInput input)
    {
        if (input.TypeId is { } typeId && !SameId(element.GetTypeId(), typeId))
        {
            return $"After the commit the element holds type {element.GetTypeId()} and not the {typeId} asked for.";
        }

        foreach (var wanted in input.Parameters)
        {
            var parameter = element.get_Parameter(wanted.Parameter);

            if (parameter is null || !wanted.Holds(parameter))
            {
                return $"After the commit parameter {wanted.Name} holds {wanted.ReadText(parameter)} and not the {wanted.Show} asked for.";
            }
        }

        return null;
    }

    private BatchEntry<UpdateInput> ReadUpdate(Document document, JsonElement item, int index)
    {
        var reader = new ItemReader(item, $"{Method} item {index}");

        RefuseUnknownKeys(reader, item, ItemKeys, "an item");

        var element = ReadElement(document, reader);
        var what = What(element);

        var move = reader.Has("moveMm") ? ReadMove(reader) : null;
        double? turn = reader.Has("rotateDeg") ? reader.Number("rotateDeg") : null;
        var typeId = reader.Has("typeId") ? ReadType(document, reader, element, what) : null;
        var wanted = reader.Has("parameters") ? ReadParameters(document, reader, element, what) : [];

        if (move is null && turn is null && typeId is null && wanted.Count == 0)
        {
            throw reader.Refuse("it asks for no change. An item needs at least one of moveMm, rotateDeg, typeId and parameters (a list with at least one entry).");
        }

        if (move is not null || turn is not null)
        {
            CheckCanMoveOrTurn(reader, element, what, move, turn is not null);
        }

        // Live Revit: a wall moved up or down by MoveElement is committed with no warning and stays where it was. Its height is a base offset and a base level.
        if (move is not null && move.Z != 0 && element is Wall)
        {
            throw reader.Refuse(
                $"moveMm.z is {Units.FormatNumber(Units.InternalToMm(move.Z))}, and a wall does not move up or down by a move: Revit takes the move and leaves the wall where it was. "
                + "Raise or lower it with parameters instead: WALL_BASE_OFFSET is its base offset from its base level, and WALL_BASE_CONSTRAINT is its base level. A move of a wall in the plan takes z 0.");
        }

        var input = new UpdateInput(element.Id, move, turn, typeId, wanted);

        // Everything asked for is true already: nothing is changed, and no transaction is made for it.
        var settled = IsSettled(element, input)
            ? new ItemResult(index, ItemStatus.Unchanged, element.Id.ToString(), item, JsonSerializer.SerializeToElement(Describe(document, element, input), ProjectSupport.Options), [], null)
            : null;

        return new BatchEntry<UpdateInput>(index, item, input, settled);
    }

    private static Element ReadElement(Document document, ItemReader reader)
    {
        if (!reader.Item.TryGetProperty("id", out var value) || value.ValueKind != JsonValueKind.String)
        {
            throw reader.Refuse("id must be an element id, as text.");
        }

        var text = value.GetString()!;

        if (!ElementIds.TryParse(text, out var id))
        {
            throw reader.Refuse($"id '{text}' is not an element id.");
        }

        var element = document.GetElement(id)
            ?? throw reader.Refuse($"no element has the id {text}, so nothing was changed. It may be gone already: read it with get_elements.");

        return element is ElementType type
            ? throw reader.Refuse(
                $"element {text} is a type ('{type.FamilyName}: {type.Name}'), and this tool changes the elements of the model and not their types. "
                + "To give an element another type use its typeId; to make a type with other layers or sizes use create_type or load_family.")
            : element;
    }

    private static XYZ ReadMove(ItemReader reader)
    {
        var value = reader.Item.GetProperty("moveMm");

        if (value.ValueKind != JsonValueKind.Object || !value.TryGetProperty("x", out var x) || !value.TryGetProperty("y", out var y) || !value.TryGetProperty("z", out var z))
        {
            throw reader.Refuse("moveMm must be a vector with x, y and z in millimetres in model coordinates, such as { \"x\": 500, \"y\": 0, \"z\": 0 }.");
        }

        RefuseUnknownKeys(reader, value, ["x", "y", "z"], "moveMm");

        return Units.PointMm(reader.Number("moveMm.x", x), reader.Number("moveMm.y", y), reader.Number("moveMm.z", z));
    }

    /// <summary>What a move or a turn needs of an element, so that neither is attempted where Revit would refuse it or where it cannot be checked.</summary>
    private static void CheckCanMoveOrTurn(ItemReader reader, Element element, string what, XYZ? move, bool turns)
    {
        var placement = ReadPlacement(element);

        if (placement is null)
        {
            throw reader.Refuse(
                $"{what} has no point or line location, so it cannot be moved or turned here: this tool moves and turns what Revit places at a point or along a line, such as walls, doors, windows and furniture. "
                + "A floor, a roof, a ceiling or a railing takes its place from a sketch or a path: make it again with create_floors, create_roof, create_ceilings or create_railings.");
        }

        if (element.Pinned)
        {
            // Live Revit: writing true to ELEMENT_LOCKED_PARAM pins an element, and false unpins it. An element is pinned on purpose, so the user decides.
            throw reader.Refuse(
                $"{what} is pinned, and Revit does not move or turn a pinned element. A pin is put on purpose, so ask the user before taking it off. "
                + "Taking it off is a call of its own with the parameter ELEMENT_LOCKED_PARAM set to false, and the move or the turn comes after it.");
        }

        // Live Revit: a door moved across its wall is committed with no warning and stays on the axis of the wall, where it was. Along the wall and up it moves.
        if (move is not null && element is FamilyInstance { Host: Wall { Location: LocationCurve { Curve: Line axis } } wall })
        {
            var across = Units.InternalToMm(Math.Abs((move.X * axis.Direction.Y) - (move.Y * axis.Direction.X)));

            if (across > SamePositionMm)
            {
                throw reader.Refuse(
                    $"{what} stands in wall {wall.Id} on its axis, and moveMm has {Units.FormatNumber(across)} mm across the wall: Revit takes that move and leaves the instance where it was. "
                    + $"Move it along the wall, which runs in the direction ({Units.FormatNumber(axis.Direction.X)}, {Units.FormatNumber(axis.Direction.Y)}), or up with z, or move the wall and take it along.");
            }
        }

        if (!turns)
        {
            return;
        }

        if (element is FamilyInstance { Host: { } host })
        {
            throw reader.Refuse(
                $"{what} is hosted by {(host is Wall ? "wall" : "element")} {host.Id}, so it takes its direction from that host and rotateDeg does not apply. To turn a wall, turn the wall: what it hosts goes with it.");
        }

        if (placement.Point is not null && placement.Rotation is null)
        {
            throw reader.Refuse($"{what} has a point location, but Revit reports no rotation for it, so a turn cannot be checked and is not attempted.");
        }
    }

    private static ElementId ReadType(Document document, ItemReader reader, Element element, string what)
    {
        var value = reader.Item.GetProperty("typeId");

        if (value.ValueKind != JsonValueKind.String)
        {
            throw reader.Refuse("typeId must be an element id, as text.");
        }

        if (!ElementIds.TryParse(value.GetString()!, out var id) || document.GetElement(id) is not ElementType type)
        {
            throw reader.Refuse($"typeId {value.GetRawText()} is not a type of this model. Take it from list_types, or from actual.typeIds of load_family.");
        }

        var typeText = $"type {id} ('{type.FamilyName}: {type.Name}')";

        if (!element.CanHaveTypeAssigned())
        {
            throw reader.Refuse($"{what} cannot be given another type: Revit says it can have none assigned.");
        }

        if (!SameId(element.GroupId, ElementId.InvalidElementId))
        {
            throw reader.Refuse($"{what} is a member of group {element.GroupId}, and Revit forbids a change of type for a member of a group outside the edit mode of the group.");
        }

        if (!element.IsValidType(id))
        {
            var valid = element.GetValidTypes()
                .Select(validId => document.GetElement(validId) as ElementType)
                .OfType<ElementType>()
                .OrderBy(valid => valid.FamilyName, StringComparer.Ordinal)
                .ThenBy(valid => valid.Name, StringComparer.Ordinal)
                .ThenBy(valid => valid.Id.Value)
                .Select(valid => $"{valid.Id} ('{valid.FamilyName}: {valid.Name}')")
                .ToList();

            throw reader.Refuse(
                $"{typeText} cannot be given to {what}: Revit says it is not valid for it. The types that can be: "
                + (valid.Count == 0 ? "none" : string.Join(", ", valid.Take(MaxListed)) + (valid.Count > MaxListed ? $", and {valid.Count - MaxListed} more, see list_types" : string.Empty))
                + ".");
        }

        return id;
    }

    private static List<Wanted> ReadParameters(Document document, ItemReader reader, Element element, string what)
    {
        if (reader.Item.GetProperty("parameters") is not { ValueKind: JsonValueKind.Array } list)
        {
            throw reader.Refuse("parameters must be a list of { builtIn, value } entries.");
        }

        var wanted = new List<Wanted>();

        foreach (var (entry, position) in list.EnumerateArray().Select((entry, position) => (entry, position)))
        {
            var where = $"parameters[{position}]";

            if (entry.ValueKind != JsonValueKind.Object)
            {
                throw reader.Refuse($"{where} is an object with builtIn and value, not {entry.GetRawText()}.");
            }

            RefuseUnknownKeys(reader, entry, ParameterKeys, where);

            var name = ReadBuiltInName(reader, entry, where);

            if (wanted.FindIndex(earlier => earlier.Name == name) is >= 0 and var first)
            {
                throw reader.Refuse($"{where} names {name} twice, which parameters[{first}] names too. Keep one.");
            }

            wanted.Add(ReadWanted(document, reader, element, what, entry, name, where));
        }

        return wanted;
    }

    private static string ReadBuiltInName(ItemReader reader, JsonElement entry, string where)
    {
        if (!entry.TryGetProperty("builtIn", out var value) || value.ValueKind != JsonValueKind.String)
        {
            throw reader.Refuse($"{where}: builtIn must be text, the name of a BuiltInParameter.");
        }

        var name = value.GetString()!;

        return BuiltInNames.Contains(name) && name != nameof(BuiltInParameter.INVALID)
            ? name
            : throw reader.Refuse(
                $"{where} '{name}' is not the name of a BuiltInParameter. A name is written as Revit's enum writes it, in capitals and with the underscores, such as WALL_USER_HEIGHT_PARAM, and a number is not a name.");
    }

    private static Wanted ReadWanted(Document document, ItemReader reader, Element element, string what, JsonElement entry, string name, string where)
    {
        var builtIn = Enum.Parse<BuiltInParameter>(name);
        var parameter = element.get_Parameter(builtIn)
            ?? throw reader.Refuse(
                $"{where} {name} is a BuiltInParameter, but {what} has no such parameter. A parameter of the type of an element is not its own, and is not written here.");

        if (parameter.Element is { } owner && !SameId(owner.Id, element.Id))
        {
            throw reader.Refuse(
                $"{where} {name} belongs to the type of {what}, and writing it would change every element of that type. This tool writes the parameters of the elements themselves; "
                + "a type of other layers or sizes is made with create_type or load_family.");
        }

        if (parameter.IsReadOnly)
        {
            throw reader.Refuse($"{where} {name} is read-only on {what}: Revit works it out and does not take a value for it.");
        }

        if (!entry.TryGetProperty("value", out var value) || value.ValueKind == JsonValueKind.Null)
        {
            throw reader.Refuse($"{where} {name} needs a value.");
        }

        var spec = parameter.Definition.GetDataType();

        switch (parameter.StorageType)
        {
            case StorageType.Double:
                // Only a length has a unit this tool converts: an angle, an area, a volume or a slope would be wrong by a factor if it were read as millimetres.
                if (!spec.Equals(SpecTypeId.Length))
                {
                    throw reader.Refuse(
                        $"{where} {name} holds a number that is not a length (its spec is '{(spec.Empty() ? "none" : spec.TypeId)}'), and only a length, in millimetres, is converted here. "
                        + "An angle, an area, a volume or a plain number would be written wrong by a factor, so it is refused. Leave it out.");
                }

                return value.ValueKind == JsonValueKind.Number && double.IsFinite(value.GetDouble())
                    ? new WantedLength(builtIn, name, value.GetDouble())
                    : throw reader.Refuse($"{where} {name} is a length, so value must be a number of millimetres, not {value.GetRawText()}.");

            case StorageType.Integer:
                var yesNo = spec.Equals(SpecTypeId.Boolean.YesNo);

                if (yesNo && value.ValueKind is JsonValueKind.True or JsonValueKind.False)
                {
                    return new WantedWhole(builtIn, name, value.ValueKind == JsonValueKind.True ? 1 : 0, true);
                }

                return value.ValueKind == JsonValueKind.Number && value.TryGetInt32(out var whole)
                    ? new WantedWhole(builtIn, name, whole, yesNo)
                    : throw reader.Refuse($"{where} {name} holds a whole number, so value must be a whole number{(yesNo ? " or true or false" : string.Empty)}, not {value.GetRawText()}.");

            case StorageType.String:
                return value.ValueKind == JsonValueKind.String
                    ? new WantedText(builtIn, name, value.GetString()!)
                    : throw reader.Refuse($"{where} {name} holds text, so value must be text, not {value.GetRawText()}.");

            case StorageType.ElementId:
                if (value.ValueKind != JsonValueKind.String)
                {
                    throw reader.Refuse($"{where} {name} holds an element, so value must be an element id, as text, not {value.GetRawText()}.");
                }

                return ElementIds.TryParse(value.GetString()!, out var id) && document.GetElement(id) is not null
                    ? new WantedReference(builtIn, name, id)
                    : throw reader.Refuse($"{where} {name}: no element has the id {value.GetString()}. The value of an element parameter is the id of an element that exists.");

            default:
                throw reader.Refuse($"{where} {name} has the storage type {parameter.StorageType}, which this tool does not write.");
        }
    }

    private static void RefuseUnknownKeys(ItemReader reader, JsonElement value, string[] allowed, string what)
    {
        if (value.ValueKind != JsonValueKind.Object)
        {
            return;
        }

        if (value.EnumerateObject().Select(property => property.Name).FirstOrDefault(key => !allowed.Contains(key, StringComparer.Ordinal)) is { } unknown)
        {
            throw reader.Refuse($"{what} has the key '{unknown}', which this tool does not know. It takes {string.Join(", ", allowed)}.");
        }
    }

    /// <summary>The same element twice in one list: the second would be judged against what the first left, and the two requests cannot both be the final state.</summary>
    private void RefuseRepeatedElements(List<BatchEntry<UpdateInput>> entries)
    {
        foreach (var entry in entries)
        {
            var earlier = entries.Take(entry.Index).FirstOrDefault(other => SameId(other.Input.Id, entry.Input.Id));

            if (earlier is not null)
            {
                throw new ItemReader(entry.Requested, $"{Method} item {entry.Index}")
                    .Refuse($"it changes element {entry.Input.Id}, which item {earlier.Index} changes too. Put what is wanted for one element in one item.");
            }
        }
    }

    /// <summary>Whether the element holds all of the item already, by its state now: no move, no turn, the type asked for, and every parameter at its value.</summary>
    private static bool IsSettled(Element element, UpdateInput input) =>
        (input.Move is null || IsZero(input.Move))
        && (input.TurnDeg is null || Normalize(input.TurnDeg.Value) == 0)
        && (input.TypeId is null || SameId(element.GetTypeId(), input.TypeId))
        && input.Parameters.All(wanted => element.get_Parameter(wanted.Parameter) is { } parameter && wanted.Holds(parameter));

    private static bool IsZero(XYZ vector) => vector.X == 0 && vector.Y == 0 && vector.Z == 0;

    /// <summary>The element as the model holds it now: its type, where it stands and how it is turned, and the parameters the item asked for in the units of the contract.</summary>
    private static object Describe(Document document, Element element, UpdateInput input)
    {
        var placement = ReadPlacement(element);

        return new
        {
            typeId = element.CanHaveTypeAssigned() ? element.GetTypeId().ToString() : null,
            typeName = (document.GetElement(element.GetTypeId()) as ElementType)?.Name,
            pointMm = placement?.Point is { } point ? ElementJson.PointMm(point) : null,
            rotationDeg = placement?.Rotation is { } rotation ? Normalize(Math.Round(Units.RadToDeg(rotation), RotationDecimals)) : (double?)null,
            startMm = placement?.Start is { } start ? ElementJson.PointMm(start) : null,
            endMm = placement?.End is { } end ? ElementJson.PointMm(end) : null,
            parameters = input.Parameters.Select(wanted => new { builtIn = wanted.Name, value = wanted.Read(element.get_Parameter(wanted.Parameter)) }).ToList(),
        };
    }

    /// <summary>Where an element stands, or <c>null</c> when it has no point or bound line location. A rotation Revit does not report for it (a room, a group) is left out.</summary>
    private static Placement? ReadPlacement(Element element)
    {
        switch (element.Location)
        {
            case LocationPoint point:
                double? rotation;

                try
                {
                    rotation = point.Rotation;
                }
                catch (Exception e) when (e is Autodesk.Revit.Exceptions.InvalidOperationException or InvalidOperationException)
                {
                    rotation = null;
                }

                return new Placement(point.Point, rotation, null, null);

            case LocationCurve { Curve: { IsBound: true } curve }:
                return new Placement(null, null, curve.GetEndPoint(0), curve.GetEndPoint(1));

            default:
                return null;
        }
    }

    private static string What(Element element) => $"element {element.Id} ({CategoryMap.KeyOf(element.Category) ?? "no category"})";

    /// <summary>An angle in degrees from 0 up to, not including, a full turn.</summary>
    private static double Normalize(double degrees)
    {
        var turned = degrees % FullTurnDeg;

        return turned < 0 ? turned + FullTurnDeg : turned;
    }

    /// <summary>The smaller angle between two directions, in degrees from 0 to half a turn.</summary>
    private static double AngleBetween(double first, double second)
    {
        var difference = Math.Abs(Normalize(first) - Normalize(second));

        return Math.Min(difference, FullTurnDeg - difference);
    }

    private static string Format(XYZ point) =>
        $"({Units.FormatNumber(Units.InternalToMm(point.X))}, {Units.FormatNumber(Units.InternalToMm(point.Y))}, {Units.FormatNumber(Units.InternalToMm(point.Z))})";

    /// <summary>
    /// Where an element stands: the point and the rotation of one with a point location, or the two ends of the axis of one with a line location.
    /// The expected place after a move or a turn is worked out from the place before, and compared with the place found.
    /// </summary>
    private sealed record Placement(XYZ? Point, double? Rotation, XYZ? Start, XYZ? End)
    {
        /// <summary>The point of the vertical axis of a turn: the point of the element, or the middle of the two ends of its axis.</summary>
        public XYZ AxisPoint => Point ?? (Start! + End!) / 2;

        public Placement Moved(XYZ by) => new(Point?.Add(by), Rotation, Start?.Add(by), End?.Add(by));

        public Placement Turned(double radians, XYZ about)
        {
            var turn = Transform.CreateRotationAtPoint(XYZ.BasisZ, radians, about);

            return new Placement(Point, Rotation + radians, Start is null ? null : turn.OfPoint(Start), End is null ? null : turn.OfPoint(End));
        }

        /// <summary>How this differs from <paramref name="expected"/>, in words that fit "the element ...", or <c>null</c> when it does not.</summary>
        public string? Differs(Placement expected)
        {
            if (Point is { } point && expected.Point is { } wanted && Units.InternalToMm(point.DistanceTo(wanted)) > SamePositionMm)
            {
                return $"is at {Format(point)} mm and not at {Format(wanted)} mm";
            }

            if (Start is { } start && expected.Start is { } wantedStart && End is { } end && expected.End is { } wantedEnd
                && (Units.InternalToMm(start.DistanceTo(wantedStart)) > SamePositionMm || Units.InternalToMm(end.DistanceTo(wantedEnd)) > SamePositionMm))
            {
                return $"has its axis from {Format(start)} to {Format(end)} mm and not from {Format(wantedStart)} to {Format(wantedEnd)} mm";
            }

            if (Rotation is { } rotation && expected.Rotation is { } wantedRotation && AngleBetween(Units.RadToDeg(rotation), Units.RadToDeg(wantedRotation)) > SameAngleDeg)
            {
                return $"is turned {Units.FormatNumber(Normalize(Units.RadToDeg(rotation)))} degrees and not {Units.FormatNumber(Normalize(Units.RadToDeg(wantedRotation)))}";
            }

            return null;
        }

        public string Describe() =>
            Point is { } point
                ? $"at {Format(point)} mm"
                : $"with its axis from {Format(Start!)} to {Format(End!)} mm";
    }

    /// <summary>A parameter to write: what it is called, how a value is set, compared and read back in the units of the contract.</summary>
    private abstract record Wanted(BuiltInParameter Parameter, string Name)
    {
        /// <summary>The value as the caller wrote it, for a message.</summary>
        public abstract string Show { get; }

        public abstract bool Holds(Parameter parameter);

        public abstract bool Set(Parameter parameter);

        public abstract object? Read(Parameter? parameter);

        public string ReadText(Parameter? parameter) => Read(parameter) is { } value ? JsonSerializer.Serialize(value) : "no value";
    }

    private sealed record WantedLength(BuiltInParameter Parameter, string Name, double Mm) : Wanted(Parameter, Name)
    {
        public override string Show => $"{Units.FormatNumber(Mm)} mm";

        public override bool Holds(Parameter parameter) => Math.Abs(Units.InternalToMm(parameter.AsDouble()) - Mm) <= SamePositionMm;

        public override bool Set(Parameter parameter) => parameter.Set(Units.MmToInternal(Mm));

        public override object? Read(Parameter? parameter) => parameter is null ? null : Units.InternalToMm(parameter.AsDouble());
    }

    private sealed record WantedWhole(BuiltInParameter Parameter, string Name, int Value, bool YesNo) : Wanted(Parameter, Name)
    {
        public override string Show => YesNo ? (Value != 0 ? "true" : "false") : Value.ToString(System.Globalization.CultureInfo.InvariantCulture);

        public override bool Holds(Parameter parameter) => parameter.AsInteger() == Value;

        public override bool Set(Parameter parameter) => parameter.Set(Value);

        public override object? Read(Parameter? parameter) =>
            parameter is null ? null : YesNo ? parameter.AsInteger() != 0 : parameter.AsInteger();
    }

    private sealed record WantedText(BuiltInParameter Parameter, string Name, string Value) : Wanted(Parameter, Name)
    {
        public override string Show => $"'{Value}'";

        public override bool Holds(Parameter parameter) => string.Equals(parameter.AsString() ?? string.Empty, Value, StringComparison.Ordinal);

        public override bool Set(Parameter parameter) => parameter.Set(Value);

        public override object? Read(Parameter? parameter) => parameter is null ? null : parameter.AsString() ?? string.Empty;
    }

    private sealed record WantedReference(BuiltInParameter Parameter, string Name, ElementId Value) : Wanted(Parameter, Name)
    {
        public override string Show => $"element {Value}";

        public override bool Holds(Parameter parameter) => SameId(parameter.AsElementId(), Value);

        public override bool Set(Parameter parameter) => parameter.Set(Value);

        public override object? Read(Parameter? parameter) => parameter?.AsElementId().ToString();
    }

    /// <param name="Move">The vector of the move, in feet, or null.</param>
    /// <param name="TurnDeg">The turn to add to the one the element has, in degrees, or null.</param>
    /// <param name="TypeId">The type to give, or null.</param>
    /// <param name="Parameters">The parameters to write, in the order of the request.</param>
    private sealed record UpdateInput(ElementId Id, XYZ? Move, double? TurnDeg, ElementId? TypeId, IReadOnlyList<Wanted> Parameters);
}
