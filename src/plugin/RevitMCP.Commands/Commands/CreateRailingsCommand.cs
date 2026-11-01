using System.Text.Json;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Architecture;
using RevitMCP.Bridge;
using RevitMCP.Commands.Dispatch;

namespace RevitMCP.Commands;

/// <summary>
/// Makes railings as one transaction, on a stairs or along a path. Live Revit (probe, step 9): Revit adds railings to every new
/// stairs by itself when the stairs edit mode closes, and <c>Railing.Create</c> on stairs that have railings is refused, so the usual
/// answer for a stairs is <see cref="ItemStatus.AlreadyExisted"/>, with the ids and the real type of the railings that are there.
/// A type asked for that differs from theirs is a warning that says how to change it, and not a change. <c>Railing.Create</c> on a
/// stairs is for one whose railings were deleted, and makes the railings of its sides. The height of a path does not matter, as the
/// railing stands on the level. So the item that makes several railings goes through <see cref="ItemBatch.RunMany"/>, and everything
/// knowable is checked before the transaction: that the stairs are one Revit can put railings on (<see cref="Railing.IsValidHostForNewRailing"/>)
/// and that the path is one it can follow (<see cref="Railing.IsValidPathForRailing"/>). What Revit made is read back inside the
/// transaction and compared with the request, and what it did not make fails the item.
/// </summary>
public sealed class CreateRailingsCommand : ICommand
{
    /// <summary>A position closer than this to the one asked for is the same one: the noise of converting units.</summary>
    private const double SamePositionMm = 0.1;

    /// <summary>The fewest points of a path, which <c>registry.ts</c> states too: one edge.</summary>
    private const int MinPathPoints = 2;

    private const string Treads = "treads";
    private const string Stringer = "stringer";

    public string Method => MethodNames.CreateRailings;

    public bool NeedsDocument => true;

    public JsonElement Execute(CommandContext context, JsonElement parameters)
    {
        var document = context.Document!;
        var entries = ItemBatch.ReadItems(parameters, Method)
            .Select((item, index) => ReadRailing(document, item, index))
            .ToList();

        RefuseRepeatedStairs(entries);

        return ItemBatch.RunMany(document, Method, entries, input => Create(document, input), element => Describe(document, (Railing)element));
    }

    private static IReadOnlyList<Element> Create(Document document, RailingInput input) => input switch
    {
        OnStairs onStairs => CreateOnStairs(document, onStairs),
        AlongPath alongPath => [CreateAlongPath(document, alongPath)],
        _ => throw new InvalidOperationException($"{input.GetType().Name} is no kind of railing item."),
    };

    /// <summary>The railings of the sides of the stairs. The lowest id comes first and is the one the item reports.</summary>
    private static IReadOnlyList<Element> CreateOnStairs(Document document, OnStairs input)
    {
        var ids = Railing.Create(document, input.StairsId, input.TypeId, input.Position);

        if (ids is null || ids.Count == 0)
        {
            throw new InvalidOperationException($"Revit made no railing on stairs {input.StairsId}.");
        }

        document.Regenerate();

        var stairs = (Stairs)document.GetElement(input.StairsId);
        var associated = stairs.GetAssociatedRailings();
        var railings = new List<Element>();

        foreach (var id in ids.OrderBy(id => id.Value))
        {
            var railing = document.GetElement(id) as Railing
                ?? throw new InvalidOperationException($"Revit said it made railing {id} on stairs {input.StairsId}, and there is no railing with that id.");

            if (railing.GetTypeId() != input.TypeId)
            {
                throw new InvalidOperationException($"Revit made railing {id} of type {railing.GetTypeId()} and not of the typeId {input.TypeId} asked for.");
            }

            if (!railing.HasHost || railing.HostId != input.StairsId || !associated.Contains(id))
            {
                throw new InvalidOperationException(
                    $"Revit made railing {id}, but it is not hosted by stairs {input.StairsId} (host {(railing.HasHost ? railing.HostId.ToString() : "none")}), so it is not a railing of those stairs.");
            }

            railings.Add(railing);
        }

        return railings;
    }

    private static Railing CreateAlongPath(Document document, AlongPath input)
    {
        var railing = Railing.Create(document, input.Path, input.TypeId, input.LevelId)
            ?? throw new InvalidOperationException("Revit gave no railing for this path.");

        document.Regenerate();
        VerifyPath(railing, input);

        return railing;
    }

    /// <summary>
    /// Compares the railing with the request. Every edge asked for must be one of the edges the railing holds, in either direction, on the
    /// level of the item, and the railing holds no others, so a railing that Revit put elsewhere or shaped differently is not a success.
    /// </summary>
    private static void VerifyPath(Railing railing, AlongPath input)
    {
        if (railing.GetTypeId() != input.TypeId)
        {
            throw new InvalidOperationException($"Revit made railing {railing.Id} of type {railing.GetTypeId()} and not of the typeId {input.TypeId} asked for.");
        }

        var held = railing.GetPath().Cast<Curve>().ToList();
        var edges = input.Points.Count - 1;

        if (held.Count != edges)
        {
            throw new InvalidOperationException($"Revit made railing {railing.Id} with a path of {held.Count} edges, and pathMm has {edges}, so it does not follow the path.");
        }

        var unmatched = held.ToList();

        for (var edge = 0; edge < edges; edge++)
        {
            var from = input.Points[edge];
            var to = input.Points[edge + 1];
            var match = unmatched.FirstOrDefault(curve => Meets(curve, from, to, input.ElevationMm) || Meets(curve, to, from, input.ElevationMm));

            if (match is null)
            {
                throw new InvalidOperationException(
                    $"Revit made railing {railing.Id}, but no edge of its path runs from ({Units.FormatNumber(from.X)}, {Units.FormatNumber(from.Y)}) to ({Units.FormatNumber(to.X)}, {Units.FormatNumber(to.Y)}) at {Units.FormatNumber(input.ElevationMm)} mm, "
                    + "the height of the level, so it does not follow the path asked for.");
            }

            unmatched.Remove(match);
        }
    }

    private static bool Meets(Curve curve, PlanPointMm from, PlanPointMm to, double elevationMm) =>
        curve.IsBound && At(curve.GetEndPoint(0), from, elevationMm) && At(curve.GetEndPoint(1), to, elevationMm);

    private static bool At(XYZ point, PlanPointMm wanted, double elevationMm) =>
        Math.Abs(Units.InternalToMm(point.X) - wanted.X) <= SamePositionMm
        && Math.Abs(Units.InternalToMm(point.Y) - wanted.Y) <= SamePositionMm
        && Math.Abs(Units.InternalToMm(point.Z) - elevationMm) <= SamePositionMm;

    private BatchEntry<RailingInput> ReadRailing(Document document, JsonElement item, int index)
    {
        var reader = new ItemReader(item, $"{Method} item {index}");
        var hasStairs = reader.Has("stairsId");
        var hasPath = reader.Has("pathMm");

        if (hasStairs && hasPath)
        {
            throw reader.Refuse("it has both stairsId and pathMm. An item is railings on a stairs (stairsId, typeId, position) or a railing along a path (pathMm, typeId, levelId), and not both.");
        }

        if (!hasStairs && !hasPath)
        {
            throw reader.Refuse("it has neither stairsId nor pathMm. An item is railings on a stairs (stairsId, typeId, position) or a railing along a path (pathMm, typeId, levelId).");
        }

        return hasStairs ? ReadOnStairs(document, reader, item, index) : ReadAlongPath(document, reader, item, index);
    }

    private BatchEntry<RailingInput> ReadOnStairs(Document document, ItemReader reader, JsonElement item, int index)
    {
        var stairs = reader.Instance<Stairs>(document, "stairsId", "stairs");
        var typeId = reader.Type<RailingType>(document, "typeId", "railings");
        var position = ReadPosition(reader);

        if (reader.Has("levelId"))
        {
            throw reader.Refuse("levelId belongs to an item with pathMm. Railings on a stairs stand on the stairs, so leave levelId out.");
        }

        var existing = stairs.GetAssociatedRailings()
            .Select(id => document.GetElement(id) as Railing)
            .OfType<Railing>()
            .OrderBy(railing => railing.Id.Value)
            .ToList();

        if (existing.Count > 0)
        {
            return new BatchEntry<RailingInput>(index, item, new OnStairs(typeId, stairs.Id, position), ReportExisting(document, stairs, existing, typeId, index, item));
        }

        // Revit's own word on whether a stairs can take new railings. Its XML says: only stairs that have none and are not in edit mode.
        if (!Railing.IsValidHostForNewRailing(document, stairs.Id))
        {
            throw reader.Refuse(
                $"Revit says that stairs {stairs.Id} cannot take new railings. The Revit API allows it only for stairs that have no railings and are not in edit mode, and these have no railings, "
                + "so they are in edit mode: look at Revit, and ask the user whether a stairs edit mode is open.");
        }

        return new BatchEntry<RailingInput>(index, item, new OnStairs(typeId, stairs.Id, position));
    }

    private static RailingPlacementPosition ReadPosition(ItemReader reader)
    {
        if (!reader.Has("position"))
        {
            throw reader.Refuse($"position is required for railings on a stairs: '{Treads}' puts them on the treads, inside the run, and '{Stringer}' on the stringers, outside it.");
        }

        return reader.Text("position") switch
        {
            Treads => RailingPlacementPosition.Treads,
            Stringer => RailingPlacementPosition.Stringer,
            _ => throw reader.Refuse($"position must be '{Treads}' or '{Stringer}', not {reader.Item.GetProperty("position").GetRawText()}."),
        };
    }

    private BatchEntry<RailingInput> ReadAlongPath(Document document, ItemReader reader, JsonElement item, int index)
    {
        if (reader.Has("position"))
        {
            throw reader.Refuse("position belongs to an item with stairsId. A railing along a path has no stairs to stand on, so leave position out.");
        }

        var typeId = reader.Type<RailingType>(document, "typeId", "railings");
        var level = reader.Level(document, "levelId");
        var elevationMm = Units.InternalToMm(level.ProjectElevation);
        var points = ReadPath(reader, item, document.Application.ShortCurveTolerance);

        var loop = new CurveLoop();

        for (var edge = 0; edge < points.Count - 1; edge++)
        {
            loop.Append(Line.CreateBound(Units.PointMm(points[edge].X, points[edge].Y, elevationMm), Units.PointMm(points[edge + 1].X, points[edge + 1].Y, elevationMm)));
        }

        // Revit's own word on a path: continuous lines on one plane, with no more than two meeting at a point.
        if (!Railing.IsValidPathForRailing(loop))
        {
            throw reader.Refuse(
                "Revit does not take pathMm as a railing path. The edges join the points in order, so they are continuous and level, and Revit forbids three or more meeting at one point: "
                + "a point that appears twice in the list, other than the last being the first to close the path, makes that.");
        }

        return new BatchEntry<RailingInput>(index, item, new AlongPath(typeId, level.Id, loop, points, elevationMm));
    }

    /// <summary>Reads the points of a path, in order. The path does not close by itself: a first point repeated at the end closes it.</summary>
    private static List<PlanPointMm> ReadPath(ItemReader reader, JsonElement item, double shortest)
    {
        if (!item.TryGetProperty("pathMm", out var path) || path.ValueKind != JsonValueKind.Array || path.GetArrayLength() < MinPathPoints)
        {
            throw reader.Refuse($"pathMm must be a list of at least {MinPathPoints} points, each with x and y in millimetres.");
        }

        var points = path.EnumerateArray().Select(point => reader.Point("pathMm", point)).ToList();

        for (var index = 0; index < points.Count - 1; index++)
        {
            var from = points[index];
            var to = points[index + 1];

            if (Units.MmToInternal(double.Hypot(to.X - from.X, to.Y - from.Y)) < shortest)
            {
                throw reader.Refuse(
                    $"pathMm points {index} and {index + 1} are closer than the {Units.InternalToMm(shortest):0.###} mm Revit can draw. A path does not close by itself, and a point repeated in a row is no edge.");
            }
        }

        return points;
    }

    /// <summary>A stairs twice in one list: the second would meet the railings of the first, which Revit refuses, and only after the transaction began.</summary>
    private void RefuseRepeatedStairs(List<BatchEntry<RailingInput>> entries)
    {
        var repeated = entries
            .Where(entry => entry.Input is OnStairs)
            .GroupBy(entry => ((OnStairs)entry.Input).StairsId)
            .FirstOrDefault(group => group.Count() > 1);

        if (repeated is not null)
        {
            throw new RequestFailedException(
                JsonRpcCodes.InvalidParams,
                $"{Method}: items {string.Join(" and ", repeated.Select(entry => entry.Index))} both put railings on stairs {repeated.Key}, so keep one.");
        }
    }

    /// <summary>
    /// A stairs that has railings already: nothing changes, and the item reports them with their real type. A railing of another type
    /// than the one asked for is a warning, as the type of a railing is changed by the tool that edits elements, not by making a second one.
    /// </summary>
    private ItemResult ReportExisting(Document document, Stairs stairs, List<Railing> existing, ElementId typeId, int index, JsonElement requested)
    {
        var other = existing.Where(railing => railing.GetTypeId() != typeId).ToList();
        var warnings = new List<string>();

        if (other.Count > 0)
        {
            var asked = (RailingType)document.GetElement(typeId);

            warnings.Add(
                $"Stairs {stairs.Id} have railings already, and {string.Join(", ", other.Select(railing => $"{railing.Id} ('{TypeText(document, railing)}')"))} "
                + $"{(other.Count == 1 ? "is" : "are")} not of the typeId {typeId} ('{asked.FamilyName}: {asked.Name}') asked for. Nothing was changed: railings are made on stairs that have none. "
                + "To change the type of the railings that exist, use update_elements with their ids and the typeId: Revit's ChangeTypeId works on railings. position was not compared either.");
        }

        return new ItemResult(
            index,
            ItemStatus.AlreadyExisted,
            existing[0].Id.ToString(),
            requested,
            JsonSerializer.SerializeToElement(DescribeOnStairs(document, stairs), ProjectSupport.Options),
            warnings,
            null);
    }

    private static string TypeText(Document document, Element railing) =>
        document.GetElement(railing.GetTypeId()) is ElementType type ? $"{type.FamilyName}: {type.Name}" : "no type";

    /// <summary>What the model holds for the railing the item reports: all railings of its stairs, or the one railing and its path.</summary>
    private static RailingActual Describe(Document document, Railing railing) =>
        railing.HasHost && document.GetElement(railing.HostId) is Stairs stairs
            ? DescribeOnStairs(document, stairs)
            : DescribeAlongPath(document, railing);

    private static RailingActual DescribeOnStairs(Document document, Stairs stairs) =>
        new(stairs.Id.ToString(), Rows(document, stairs.GetAssociatedRailings()), null, null);

    private static RailingActual DescribeAlongPath(Document document, Railing railing)
    {
        var curves = railing.GetPath().Cast<Curve>().ToList();
        var points = curves.Select(curve => curve.GetEndPoint(0)).Append(curves[^1].GetEndPoint(1)).ToList();

        return new RailingActual(
            null,
            Rows(document, [railing.Id]),
            points.Select(point => new PathPoint(Units.InternalToMm(point.X), Units.InternalToMm(point.Y))).ToList(),
            Units.InternalToMm(points[0].Z));
    }

    private static List<RailingRow> Rows(Document document, IEnumerable<ElementId> ids) =>
        ids.Select(id => document.GetElement(id))
            .OfType<Railing>()
            .OrderBy(railing => railing.Id.Value)
            .Select(railing => new RailingRow(railing.Id.ToString(), railing.GetTypeId().ToString(), (document.GetElement(railing.GetTypeId()) as ElementType)?.Name))
            .ToList();

    /// <summary>The item as the model holds it. <paramref name="HostId"/> is the stairs, and null for a path; the last two are only for a path.</summary>
    private sealed record RailingActual(string? HostId, List<RailingRow> Railings, List<PathPoint>? PathMm, double? ElevationMm);

    private sealed record RailingRow(string Id, string TypeId, string? TypeName);

    private sealed record PathPoint(double X, double Y);

    private abstract record RailingInput(ElementId TypeId);

    private sealed record OnStairs(ElementId TypeId, ElementId StairsId, RailingPlacementPosition Position) : RailingInput(TypeId);

    /// <param name="ElevationMm">The height of the level in the model, where Revit puts the path whatever height it is given.</param>
    private sealed record AlongPath(ElementId TypeId, ElementId LevelId, CurveLoop Path, IReadOnlyList<PlanPointMm> Points, double ElevationMm) : RailingInput(TypeId);
}
