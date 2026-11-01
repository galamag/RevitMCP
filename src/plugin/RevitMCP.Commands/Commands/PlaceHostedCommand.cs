using System.Text.Json;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Structure;
using RevitMCP.Bridge;
using RevitMCP.Commands.Dispatch;

namespace RevitMCP.Commands;

/// <summary>
/// Places doors and windows in straight walls as one transaction. Live Revit (probe, step 7): the point is put on the axis of
/// the wall whatever side it is on; its Z, and not the sill of the family, sets the sill, for a door too; the opening faces the
/// left of the direction of the wall, and only <c>flipFacing</c> changes that; and Revit accepts, with no warning and a
/// <c>committed</c> true, an opening that runs past the end of the wall by half its width, a sill and a head that reach past the top
/// of the wall, and openings on top of each other. So everything knowable is checked before the transaction and refused naming
/// the item: where the opening lies along the wall and in height, what it overlaps (inserts already on the wall and earlier items
/// of the list, in both extents), and the kind of type and wall. Whether a type can flip as asked is a fact of an instance and not of the
/// type, so it is known only once an instance exists: the flip is done inside the transaction, and one that cannot be done fails its item.
/// <c>offsetAlongWallMm</c> counts from the start of the axis of the wall to the centre of the opening, and <c>sillHeightMm</c>
/// from the base level of the wall, whatever the base offset of the wall is. Width and height are those of the type, or its rough ones
/// when it reads none (<see cref="FamilySizes.OpeningMm"/>). The top of the wall is read where the opening stands: a wall that follows a roof is
/// lower than its highest point at all but one place, and Revit takes a window through the slope with no warning. A symbol that
/// is not active is activated and the document regenerated first, as without that the first instance of a type silently does not
/// cut its wall. After the instance is made and regenerated, its host, place, level, sill and flips are read from the model and
/// compared with the request, and the wall's <see cref="HostObject.FindInserts"/> must list it, or the item fails.
/// </summary>
public sealed class PlaceHostedCommand : ICommand
{
    /// <summary>A position closer than this to the one asked for is the same one: the noise of converting units.</summary>
    private const double SamePositionMm = 0.1;

    /// <summary>
    /// How far an opening may stick out of its wall and still lie in it, and how deep two openings may reach into each other and
    /// still only touch. Far above the noise of units, and far below any real overlap.
    /// </summary>
    private const double EdgeToleranceMm = 0.01;

    /// <summary>
    /// How far in from an edge of the opening, and from the end of the wall, the top of the wall is read. On the edge itself the line
    /// can lie on the face of a cut next to it, or on the end face of the wall, and meet nothing, or the face. It leans towards the
    /// middle of the opening, where a wall that rises towards its ridge is higher, so it errs by at most a millimetre of slope.
    /// </summary>
    private const double TopInsetMm = 1;

    public string Method => MethodNames.PlaceHosted;

    public bool NeedsDocument => true;

    public JsonElement Execute(CommandContext context, JsonElement parameters)
    {
        var document = context.Document!;
        var entries = ItemBatch.ReadItems(parameters, Method)
            .Select((item, index) => ReadHosted(document, item, index))
            .ToList();

        RefuseOverlaps(document, entries);

        // Kept for the read-back, which comes after the commit and gets the element only.
        var notes = new Dictionary<ElementId, string>();

        return ItemBatch.Run(
            document,
            Method,
            entries,
            input => Place(document, input, notes),
            element => Describe((FamilyInstance)element),
            element => notes.TryGetValue(element.Id, out var note) ? [note] : []);
    }

    private static FamilyInstance Place(Document document, HostedInput input, Dictionary<ElementId, string> notes)
    {
        var instance = Create(document, input);

        // Whether a type can flip is a fact of an instance, and an instance is what exists only now. A flip that cannot be done fails the item, and the batch rolls back.
        if (input.FlipFacing && (!instance.CanFlipFacing || !instance.flipFacing()))
        {
            throw new InvalidOperationException(
                $"Type '{instance.Symbol.FamilyName}: {instance.Symbol.Name}' cannot flip its facing: Revit says so for an instance of it, so flipFacing cannot be done. Leave flipFacing out or false.");
        }

        if (input.FlipHand && (!instance.CanFlipHand || !instance.flipHand()))
        {
            throw new InvalidOperationException(
                $"Type '{instance.Symbol.FamilyName}: {instance.Symbol.Name}' cannot flip its hand: Revit says so for an instance of it, as for a fixed window, so flipHand cannot be done. Leave flipHand out or false.");
        }

        document.Regenerate();
        Verify(instance, input);

        if (input.SizeNote is { } note)
        {
            notes[instance.Id] = note;
        }

        return instance;
    }

    /// <summary>Makes the instance, after activating its symbol and regenerating, which the first instance of a type needs to cut its wall.</summary>
    private static FamilyInstance Create(Document document, HostedInput input)
    {
        var symbol = (FamilySymbol)document.GetElement(input.SymbolId);
        var wall = (Wall)document.GetElement(input.WallId);
        var level = (Level)document.GetElement(input.LevelId);

        if (!symbol.IsActive)
        {
            symbol.Activate();
            document.Regenerate();
        }

        return document.Create.NewFamilyInstance(input.Point, symbol, wall, level, StructuralType.NonStructural)
            ?? throw new InvalidOperationException($"Revit gave no instance of type {input.SymbolId} in wall {input.WallId}.");
    }

    /// <summary>Compares the instance with the request. What Revit put elsewhere, or did not cut, is not a success, however silently it did.</summary>
    private static void Verify(FamilyInstance instance, HostedInput input)
    {
        if (instance.Host is not Wall host || host.Id != input.WallId)
        {
            throw new InvalidOperationException(
                $"Revit made the instance, but it is hosted by {(instance.Host is null ? "nothing" : $"element {instance.Host.Id}")} and not by wall {input.WallId}, so it is not in that wall.");
        }

        if (instance.Location is not LocationPoint location)
        {
            throw new InvalidOperationException($"Revit placed instance {instance.Id} without a point location, so where it stands cannot be checked.");
        }

        var expected = input.Point;
        var actual = location.Point;

        if (Math.Abs(Units.InternalToMm(actual.X - expected.X)) > SamePositionMm || Math.Abs(Units.InternalToMm(actual.Y - expected.Y)) > SamePositionMm)
        {
            throw new InvalidOperationException($"Revit placed the instance at {Format(actual)} mm and not at {Format(expected)} mm, which is where offsetAlongWallMm {Units.FormatNumber(input.OffsetMm)} lies on the axis of the wall.");
        }

        if (Math.Abs(Units.InternalToMm(actual.Z - expected.Z)) > SamePositionMm)
        {
            throw new InvalidOperationException(
                $"Revit placed the instance {Units.FormatNumber(Units.InternalToMm(actual.Z) - input.LevelMm)} mm above the level of the wall and not the {Units.FormatNumber(input.SillMm)} mm asked for in sillHeightMm.");
        }

        if (instance.LevelId != input.LevelId)
        {
            throw new InvalidOperationException($"Revit put the instance on level {instance.LevelId} and not on level {input.LevelId}, the base level of the wall, so sillHeightMm is not measured from it.");
        }

        var alongMm = Units.InternalToMm(instance.HostParameter);

        if (Math.Abs(alongMm - input.OffsetMm) > SamePositionMm)
        {
            throw new InvalidOperationException($"Revit put the instance {Units.FormatNumber(alongMm)} mm along the wall and not the {Units.FormatNumber(input.OffsetMm)} mm asked for in offsetAlongWallMm.");
        }

        var sillMm = SillMm(instance);

        if (sillMm is null || Math.Abs(sillMm.Value - input.SillMm) > SamePositionMm)
        {
            throw new InvalidOperationException(
                $"Revit gives the instance a sill height of {(sillMm is { } read ? $"{Units.FormatNumber(read)} mm" : "none")} and not the {Units.FormatNumber(input.SillMm)} mm asked for in sillHeightMm.");
        }

        if (instance.FacingFlipped != input.FlipFacing || instance.HandFlipped != input.FlipHand)
        {
            throw new InvalidOperationException(
                $"Revit holds the instance with facing flipped {instance.FacingFlipped} and hand flipped {instance.HandFlipped}, and flipFacing {input.FlipFacing} and flipHand {input.FlipHand} were asked for.");
        }

        if (!CutsWall(host, instance.Id))
        {
            // Live Revit: an instance made right after Activate, with no regeneration between, is committed with no warning and does not cut.
            throw new InvalidOperationException(
                $"Revit made the instance, but wall {input.WallId} does not list it among its inserts, so it does not cut the wall: the wall is whole where it stands.");
        }
    }

    private BatchEntry<HostedInput> ReadHosted(Document document, JsonElement item, int index)
    {
        var reader = new ItemReader(item, $"{Method} item {index}");
        var symbol = reader.FamilyType(document, "typeId");
        var wall = reader.Instance<Wall>(document, "wallId", "walls");
        var offsetMm = reader.Number("offsetAlongWallMm");
        var flipFacing = reader.FlagOr("flipFacing", false);
        var flipHand = reader.FlagOr("flipHand", false);

        var typeName = $"typeId {item.GetProperty("typeId").GetRawText()} ('{symbol.FamilyName}: {symbol.Name}')";
        var wallName = $"wallId {item.GetProperty("wallId").GetRawText()}";

        var isWindow = CheckKind(reader, symbol, typeName);
        var sillMm = reader.Has("sillHeightMm")
            ? reader.Number("sillHeightMm")
            : isWindow
                ? throw reader.Refuse($"{typeName} is a window, so sillHeightMm is required: the height of the bottom of the opening above the base level of the wall, in millimetres. A door takes 0 when it is left out.")
                : 0;

        var (widthMm, heightMm, sizeNote) = ReadSize(reader, symbol, typeName);
        var axis = ReadAxis(reader, wall, wallName);
        var level = document.GetElement(wall.get_Parameter(BuiltInParameter.WALL_BASE_CONSTRAINT)?.AsElementId() ?? ElementId.InvalidElementId) as Level
            ?? throw reader.Refuse($"{wallName} has no base level, so sillHeightMm has nothing to be measured from.");
        var levelMm = Units.InternalToMm(level.ProjectElevation);
        var footMm = levelMm + Units.InternalToMm(wall.get_Parameter(BuiltInParameter.WALL_BASE_OFFSET)?.AsDouble() ?? 0);

        var lengthMm = Units.InternalToMm(axis.Length);
        var extent = new Extent(offsetMm - widthMm / 2, offsetMm + widthMm / 2, levelMm + sillMm, levelMm + sillMm + heightMm);
        var start = axis.GetEndPoint(0);
        var end = axis.GetEndPoint(1);

        if (extent.AlongFromMm < -EdgeToleranceMm || extent.AlongToMm > lengthMm + EdgeToleranceMm)
        {
            throw reader.Refuse(
                $"the opening would run from {Units.FormatNumber(extent.AlongFromMm)} mm to {Units.FormatNumber(extent.AlongToMm)} mm along {wallName}, which is {Units.FormatNumber(lengthMm)} mm long "
                + $"(offsetAlongWallMm {Units.FormatNumber(offsetMm)} is the distance from the start of the wall to the centre of the opening, and {typeName} is {Units.FormatNumber(widthMm)} mm wide). "
                + $"The wall runs from {Format(start)} mm to {Format(end)} mm, and the opening has to lie wholly between 0 and {Units.FormatNumber(lengthMm)}.");
        }

        // The top of the wall at the edge of the opening nearer the start of the wall, in its middle, and at the edge nearer its end, on the axis: the lowest of them
        // counts. A wall cut by a roof is lower than its highest point everywhere but at the ridge, and the highest point is no limit for a window.
        var along = new[] { extent.AlongFromMm + TopInsetMm, offsetMm, extent.AlongToMm - TopInsetMm }
            .Select(position => Math.Clamp(position, TopInsetMm, lengthMm - TopInsetMm))
            .ToArray();
        var tops = WallGeometry.TopsAtMm(
            wall,
            along.Select(position => new XYZ(start.X + (axis.Direction.X * Units.MmToInternal(position)), start.Y + (axis.Direction.Y * Units.MmToInternal(position)), start.Z)).ToList());

        if (tops.All(top => top is null))
        {
            throw reader.Refuse($"{wallName} has no solid where the opening would stand, so its top cannot be read and nothing can be checked against it.");
        }

        var topMm = tops.Min()!.Value;

        if (extent.TopMm > topMm + EdgeToleranceMm)
        {
            var varies = tops.Any(top => top is null || Math.Abs(top.Value - topMm) > EdgeToleranceMm);

            throw reader.Refuse(
                $"the opening would run from {Units.FormatNumber(sillMm)} mm to {Units.FormatNumber(extent.TopMm - levelMm)} mm above level '{level.Name}' (sillHeightMm {Units.FormatNumber(sillMm)} plus the {Units.FormatNumber(heightMm)} mm height of {typeName}), "
                + $"but {wallName} reaches only {Units.FormatNumber(topMm - levelMm)} mm above that level where the opening stands, so the top of the opening is {Units.FormatNumber(extent.TopMm - topMm)} mm above the top of the wall"
                + (varies
                    ? $" at its lowest. The wall is not as high everywhere, as a wall that follows a roof is not: its top is {TopText(tops[0], levelMm)} at the edge of the opening nearer the start of the wall, {TopText(tops[1], levelMm)} in the middle and {TopText(tops[2], levelMm)} at the edge nearer its end, above that level. "
                    + "Lower sillHeightMm, or move the opening along the wall to where it is higher."
                    : ". Lower sillHeightMm or take a lower type."));
        }

        if (extent.BottomMm < footMm - EdgeToleranceMm)
        {
            throw reader.Refuse(
                $"the opening would start at {Units.FormatNumber(sillMm)} mm above level '{level.Name}' (sillHeightMm), but {wallName} starts at {Units.FormatNumber(footMm - levelMm)} mm above that level, "
                + $"so the opening would start {Units.FormatNumber(footMm - extent.BottomMm)} mm below the foot of the wall. Raise sillHeightMm to at least {Units.FormatNumber(footMm - levelMm)}.");
        }

        var point = new XYZ(
            start.X + (axis.Direction.X * Units.MmToInternal(offsetMm)),
            start.Y + (axis.Direction.Y * Units.MmToInternal(offsetMm)),
            Units.MmToInternal(extent.BottomMm));

        return new BatchEntry<HostedInput>(
            index,
            item,
            new HostedInput(symbol.Id, wall.Id, level.Id, levelMm, level.Name, isWindow ? "window" : "door", point, offsetMm, sillMm, extent, flipFacing, flipHand, sizeNote));
    }

    /// <summary>Whether the type is a window. A type that is no door or window, or that does not sit in a wall, is refused.</summary>
    private static bool CheckKind(ItemReader reader, FamilySymbol symbol, string typeName)
    {
        var category = symbol.Category?.BuiltInCategory;

        if (category is not (BuiltInCategory.OST_Doors or BuiltInCategory.OST_Windows))
        {
            throw reader.Refuse(
                $"{typeName} is a type of another category than doors and windows, and this tool places only those. Take typeId from list_types with doors or windows. "
                + "What hangs on a wall without a door or a window is placed by place_instances.");
        }

        var placement = symbol.Family.FamilyPlacementType;

        if (placement != FamilyPlacementType.OneLevelBasedHosted)
        {
            throw reader.Refuse(
                $"{typeName} has the placement type {placement}, and a door or window that sits in a wall has {FamilyPlacementType.OneLevelBasedHosted}, so this tool cannot place it.");
        }

        if (PlaceInstancesCommand.HostedOnOther(symbol.Family) is { } other)
        {
            throw reader.Refuse($"{typeName} hangs on a {other.ToString().ToLowerInvariant()}, as its family says, and not on a wall, so wallId cannot host it.");
        }

        return category == BuiltInCategory.OST_Windows;
    }

    /// <summary>
    /// The width and the height of the opening the type cuts, and a note when they are the rough ones. A type that does not say them is refused:
    /// none of the checks of where the opening lies would hold.
    /// </summary>
    private static (double WidthMm, double HeightMm, string? Note) ReadSize(ItemReader reader, FamilySymbol symbol, string typeName)
    {
        var (widthMm, heightMm, fromRough) = FamilySizes.OpeningMm(symbol);

        if (widthMm is not > 0 || heightMm is not > 0)
        {
            string Read(BuiltInParameter which) => FamilySizes.ParameterMm(symbol, which) is { } mm ? Units.FormatNumber(mm) : "none";

            throw reader.Refuse(
                $"{typeName} says no width above zero or no height above zero: its Width reads {Read(BuiltInParameter.FAMILY_WIDTH_PARAM)} and its Height {Read(BuiltInParameter.FAMILY_HEIGHT_PARAM)}, "
                + $"and its Rough Width {Read(BuiltInParameter.FAMILY_ROUGH_WIDTH_PARAM)} and Rough Height {Read(BuiltInParameter.FAMILY_ROUGH_HEIGHT_PARAM)}, "
                + "so whether its opening fits the wall cannot be checked, and nothing is placed on a guess. Take another type.");
        }

        return (
            widthMm.Value,
            heightMm.Value,
            fromRough
                ? $"{typeName} reads no Width or Height above zero, so its opening is taken as its Rough Width and Rough Height: {Units.FormatNumber(widthMm.Value)} x {Units.FormatNumber(heightMm.Value)} mm. "
                    + "The wall is cut at that size, and every check of this item used it."
                : null);
    }

    /// <summary>The straight axis of the wall. A curved wall and a curtain wall are refused: offsets are measured along a straight axis, and a curtain wall takes panels, not inserts.</summary>
    private static Line ReadAxis(ItemReader reader, Wall wall, string wallName)
    {
        if (wall.WallType.Kind == WallKind.Curtain)
        {
            throw reader.Refuse($"{wallName} is a curtain wall, and this tool does not place doors and windows in one: they are panels of its grid. Use a wall of a basic type.");
        }

        return (wall.Location as LocationCurve)?.Curve switch
        {
            Line line => line,
            { } curve => throw reader.Refuse($"{wallName} is not straight (its axis is a {curve.GetType().Name}), and offsetAlongWallMm is measured along a straight axis. Use a straight wall."),
            _ => throw reader.Refuse($"{wallName} is a wall with no axis, so nothing can be measured along it."),
        };
    }

    /// <summary>
    /// Refuses an opening that overlaps another in both extents: along the wall and in height. Openings that only touch do not overlap,
    /// and a window above a door does not. The others are the doors and windows already on the wall and the earlier items of the list.
    /// </summary>
    private void RefuseOverlaps(Document document, List<BatchEntry<HostedInput>> entries)
    {
        var onWall = new Dictionary<ElementId, List<Existing>>();

        foreach (var entry in entries)
        {
            var input = entry.Input;
            var reader = new ItemReader(entry.Requested, $"{Method} item {entry.Index}");

            if (!onWall.TryGetValue(input.WallId, out var existing))
            {
                existing = ReadInserts(document, (Wall)document.GetElement(input.WallId), reader);
                onWall[input.WallId] = existing;
            }

            if (existing.FirstOrDefault(insert => insert.Extent.Overlaps(input.Extent)) is { } hit)
            {
                throw reader.Refuse(
                    $"the {input.Kind} ({Words(input.Extent, input.LevelMm, input.LevelName)}) overlaps the {hit.Kind} {hit.Id} that is in wall {input.WallId} already ({Words(hit.Extent, input.LevelMm, input.LevelName)}). "
                    + "Openings may touch but not overlap: move this one along the wall, or put it above or below the other.");
            }

            var earlier = entries.Take(entry.Index).FirstOrDefault(other => other.Input.WallId == input.WallId && other.Input.Extent.Overlaps(input.Extent));

            if (earlier is not null)
            {
                throw reader.Refuse(
                    $"the {input.Kind} ({Words(input.Extent, input.LevelMm, input.LevelName)}) overlaps item {earlier.Index} of this list, a {earlier.Input.Kind} in the same wall ({Words(earlier.Input.Extent, input.LevelMm, input.LevelName)}). "
                    + "Openings may touch but not overlap: move one along the wall, or put it above or below the other.");
            }
        }
    }

    /// <summary>The doors and windows in the wall, with the place each takes. One that cannot be measured refuses the item that asked, as no overlap with it can be ruled out.</summary>
    private static List<Existing> ReadInserts(Document document, Wall wall, ItemReader reader)
    {
        var axis = (Line)((LocationCurve)wall.Location).Curve;
        var found = new List<Existing>();

        foreach (var id in wall.FindInserts(false, false, false, false))
        {
            if (document.GetElement(id) is not FamilyInstance instance || KindOf(instance) is not { } kind)
            {
                continue;
            }

            var extent = ExtentOf(instance, axis)
                ?? throw reader.Refuse(
                    $"the {kind} {id} that is in wall {wall.Id} already has no point location or no width and height above zero in its type, so whether the new opening overlaps it cannot be checked. "
                    + "Delete it, or give it a size.");
            found.Add(new Existing(id, kind, extent));
        }

        return found;
    }

    private static string? KindOf(Element element) => element.Category?.BuiltInCategory switch
    {
        BuiltInCategory.OST_Doors => "door",
        BuiltInCategory.OST_Windows => "window",
        _ => null,
    };

    /// <summary>The place an instance takes in its wall: its point is on the axis, at the sill, and its type gives the width and the height.</summary>
    private static Extent? ExtentOf(FamilyInstance instance, Line axis)
    {
        if (instance.Location is not LocationPoint location || instance.Symbol is not { } symbol)
        {
            return null;
        }

        var (widthMm, heightMm, _) = FamilySizes.OpeningMm(symbol);

        if (widthMm is not > 0 || heightMm is not > 0)
        {
            return null;
        }

        var alongMm = Units.InternalToMm((location.Point - axis.GetEndPoint(0)).DotProduct(axis.Direction));
        var bottomMm = Units.InternalToMm(location.Point.Z);

        return new Extent(alongMm - (widthMm.Value / 2), alongMm + (widthMm.Value / 2), bottomMm, bottomMm + heightMm.Value);
    }

    private static object Describe(FamilyInstance instance) => new
    {
        hostId = instance.Host?.Id.ToString(),
        offsetAlongWallMm = Units.InternalToMm(instance.HostParameter),
        sillHeightMm = SillMm(instance),
        facingFlipped = instance.FacingFlipped,
        handFlipped = instance.HandFlipped,
        fromRoomId = instance.FromRoom?.Id.ToString(),
        toRoomId = instance.ToRoom?.Id.ToString(),
        cutsWall = instance.Host is Wall wall && CutsWall(wall, instance.Id),
    };

    private static bool CutsWall(Wall wall, ElementId instanceId) => wall.FindInserts(false, false, false, false).Contains(instanceId);

    /// <summary>The sill height of an instance in millimetres, above its level, or <c>null</c> when it has none.</summary>
    private static double? SillMm(FamilyInstance instance) =>
        instance.get_Parameter(BuiltInParameter.INSTANCE_SILL_HEIGHT_PARAM) is { StorageType: StorageType.Double } parameter ? Units.InternalToMm(parameter.AsDouble()) : null;

    /// <summary>A height of the wall as the caller measures it, above the base level, or that there is no wall there.</summary>
    private static string TopText(double? topMm, double levelMm) => topMm is { } top ? $"{Units.FormatNumber(top - levelMm)} mm" : "no wall";

    /// <summary>An extent as the caller measures it: along the wall from its start, and above the base level of the wall.</summary>
    private static string Words(Extent extent, double levelMm, string levelName) =>
        $"{Units.FormatNumber(extent.AlongFromMm)} to {Units.FormatNumber(extent.AlongToMm)} mm along the wall, "
        + $"{Units.FormatNumber(extent.BottomMm - levelMm)} to {Units.FormatNumber(extent.TopMm - levelMm)} mm above level '{levelName}'";

    private static string Format(XYZ point) => $"({Units.FormatNumber(Units.InternalToMm(point.X))}, {Units.FormatNumber(Units.InternalToMm(point.Y))})";

    /// <summary>The room an opening takes in its wall: along the axis from its start, and in height in the model, both in millimetres.</summary>
    private readonly record struct Extent(double AlongFromMm, double AlongToMm, double BottomMm, double TopMm)
    {
        /// <summary>Whether two extents share an area. Sharing an edge is not.</summary>
        public bool Overlaps(Extent other) =>
            Math.Min(AlongToMm, other.AlongToMm) - Math.Max(AlongFromMm, other.AlongFromMm) > EdgeToleranceMm
            && Math.Min(TopMm, other.TopMm) - Math.Max(BottomMm, other.BottomMm) > EdgeToleranceMm;
    }

    /// <summary>A door or window that is in the wall already.</summary>
    private sealed record Existing(ElementId Id, string Kind, Extent Extent);

    /// <param name="Point">Where Revit is asked to put it: on the axis of the wall at the offset, at the height of the sill in the model.</param>
    /// <param name="LevelMm">The height of the base level of the wall in the model, the zero of sillHeightMm.</param>
    private sealed record HostedInput(
        ElementId SymbolId,
        ElementId WallId,
        ElementId LevelId,
        double LevelMm,
        string LevelName,
        string Kind,
        XYZ Point,
        double OffsetMm,
        double SillMm,
        Extent Extent,
        bool FlipFacing,
        bool FlipHand,
        string? SizeNote);
}
