using System.Text.Json;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Structure;
using RevitMCP.Bridge;
using RevitMCP.Commands.Dispatch;

namespace RevitMCP.Commands;

/// <summary>
/// Places instances of loaded family types as one transaction: furniture, fixtures and plants that stand on a level, and
/// fixtures that hang on a wall. The placement type is read from the family and not guessed from a name. Live Revit: a
/// <see cref="FamilyPlacementType.OneLevelBasedHosted"/> family placed with no host is committed with no warning at a
/// wrong place and with no geometry, so it is refused before the transaction, and so is every placement type this command does
/// not handle. The height of an instance is the elevation of its level plus <c>elevationMm</c>. Live Revit takes the Z of the point as the
/// height above the level for a free-standing family (a toilet on a level at 4000 asked for Z 4000 stood at 8000) and as the height in the model for a hosted one (a sink asked for Z 0
/// stood at 0 on a wall of the level at 4000), so each gets the one it takes. A bed takes neither and stands on its level. A hosted
/// instance goes to the point of the axis of its wall nearest to the point asked for, and takes its direction from the wall:
/// <c>flipFacing</c> puts it on the other side. A symbol that is not active is activated and the document regenerated before the
/// first instance, as without that the first instance of a type does not cut its wall. After the instance is made and
/// regenerated, where it stands, how it is turned and its level are read from the model and compared with the request, and an
/// instance that Revit put somewhere else fails the item.
/// </summary>
public sealed class PlaceInstancesCommand : ICommand
{
    /// <summary>A position closer than this to the one asked for is the same one: the noise of converting units.</summary>
    private const double SamePositionMm = 0.1;

    /// <summary>The same for a rotation.</summary>
    private const double SameAngleDeg = 0.01;

    private const double FullTurnDeg = 360;

    /// <summary>An angle read back from Revit carries noise in the 13th place, which <c>actual</c> does not show.</summary>
    private const int RotationDecimals = 6;

    /// <summary>How far above the top or below the foot of a wall a height may be and still count as on it.</summary>
    private const double WallReachMm = 1;

    public string Method => MethodNames.PlaceInstances;

    public bool NeedsDocument => true;

    public JsonElement Execute(CommandContext context, JsonElement parameters)
    {
        var document = context.Document!;
        var entries = ItemBatch.ReadItems(parameters, Method)
            .Select((item, index) => ReadInstance(document, item, index))
            .ToList();

        // Kept for the read-back, which comes after the commit and gets the element only.
        var placed = new Dictionary<ElementId, PlaceInput>();

        return ItemBatch.Run(
            document,
            Method,
            entries,
            input => Place(document, input, placed),
            element => Describe(document, (FamilyInstance)element),
            element => placed.TryGetValue(element.Id, out var input) ? MovedWarnings((FamilyInstance)element, input) : []);
    }

    private static FamilyInstance Place(Document document, PlaceInput input, Dictionary<ElementId, PlaceInput> placed)
    {
        var symbol = (FamilySymbol)document.GetElement(input.SymbolId);
        var level = (Level)document.GetElement(input.LevelId);

        if (!symbol.IsActive)
        {
            // Without the regeneration the first instance of a type does not cut its wall, and nothing says so.
            symbol.Activate();
            document.Regenerate();
        }

        var instance = (input.HostId is { } hostId
            ? document.Create.NewFamilyInstance(input.Point, symbol, document.GetElement(hostId), level, StructuralType.NonStructural)
            : document.Create.NewFamilyInstance(input.Point, symbol, level, StructuralType.NonStructural))
            ?? throw new InvalidOperationException($"Revit gave no instance of type {input.SymbolId} at the point asked for.");

        if (input.HostId is null && input.RotationDeg != 0)
        {
            ElementTransformUtils.RotateElement(
                document,
                instance.Id,
                Line.CreateBound(input.Point, input.Point + XYZ.BasisZ),
                Units.DegToRad(input.RotationDeg));
        }

        if (input.FlipFacing && (!instance.CanFlipFacing || !instance.flipFacing()))
        {
            throw new InvalidOperationException($"Revit cannot flip the facing of this instance of type {input.SymbolId}, so flipFacing cannot be done.");
        }

        document.Regenerate();
        placed[instance.Id] = input;
        Verify(instance, input, level);

        return instance;
    }

    /// <summary>Compares the instance with the request. What Revit put elsewhere is not a success, however silently it did.</summary>
    private static void Verify(FamilyInstance instance, PlaceInput input, Level level)
    {
        if (instance.Location is not LocationPoint location)
        {
            throw new InvalidOperationException($"Revit placed instance {instance.Id} without a point location, so where it stands cannot be checked.");
        }

        var actual = location.Point;
        var expected = input.Expected;

        if (Math.Abs(Units.InternalToMm(actual.X - expected.X)) > SamePositionMm || Math.Abs(Units.InternalToMm(actual.Y - expected.Y)) > SamePositionMm)
        {
            throw new InvalidOperationException(
                $"Revit placed the instance at {Format(actual)} mm and not at {Format(expected)} mm, where {(input.HostId is null ? "pointMm" : "the axis of the wall nearest to pointMm")} put it.");
        }

        if (Math.Abs(Units.InternalToMm(actual.Z - expected.Z)) > SamePositionMm)
        {
            // Live Revit: a bed takes the height of its level whatever the Z of the point is, and a light fitting the mounting height of its family.
            throw new InvalidOperationException(
                $"Revit placed the instance {Units.FormatNumber(Units.InternalToMm(actual.Z - level.ProjectElevation))} mm above level '{level.Name}' and not the {Units.FormatNumber(input.ElevationMm)} mm asked for in elevationMm, "
                + "so the family does not take that height. The height it keeps is the elevationMm to ask for.");
        }

        if (input.HostId is null && AngleBetween(Units.RadToDeg(location.Rotation), input.RotationDeg) > SameAngleDeg)
        {
            throw new InvalidOperationException(
                $"Revit turned the instance by {Units.FormatNumber(Normalize(Units.RadToDeg(location.Rotation)))} degrees and not by the {Units.FormatNumber(Normalize(input.RotationDeg))} asked for.");
        }

        if (instance.LevelId != level.Id)
        {
            throw new InvalidOperationException($"Revit put the instance on level {instance.LevelId} and not on level {level.Id} ('{level.Name}').");
        }
    }

    private BatchEntry<PlaceInput> ReadInstance(Document document, JsonElement item, int index)
    {
        var reader = new ItemReader(item, $"{Method} item {index}");
        var symbol = reader.FamilyType(document, "typeId");
        var point = reader.Point("pointMm");
        var level = reader.Level(document, "levelId");
        var elevationMm = reader.NumberOr("elevationMm", 0);
        var rotationDeg = reader.NumberOr("rotationDeg", 0);
        var flipFacing = reader.FlagOr("flipFacing", false);
        var host = reader.Has("hostWallId") ? reader.Instance<Wall>(document, "hostWallId", "walls") : null;

        CheckPlacementType(reader, symbol, host, rotationDeg, flipFacing);

        var heightMm = Units.InternalToMm(level.ProjectElevation) + elevationMm;
        var requested = Units.PointMm(point.X, point.Y, heightMm);
        var expected = host is null ? requested : OnAxis(reader, host, requested, level, elevationMm, heightMm);

        return new BatchEntry<PlaceInput>(
            index,
            item,
            new PlaceInput(symbol.Id, level.Id, host?.Id, host is null ? Units.PointMm(point.X, point.Y, elevationMm) : requested, expected, elevationMm, rotationDeg, flipFacing));
    }

    /// <summary>The placement types this command handles, and what each one needs.</summary>
    private static void CheckPlacementType(ItemReader reader, FamilySymbol symbol, Wall? host, double rotationDeg, bool flipFacing)
    {
        var name = $"typeId {reader.Item.GetProperty("typeId").GetRawText()} ('{symbol.FamilyName}: {symbol.Name}')";

        switch (symbol.Family.FamilyPlacementType)
        {
            case FamilyPlacementType.OneLevelBased:
                if (host is not null)
                {
                    throw reader.Refuse($"{name} stands on a level and has no host, so hostWallId does not apply. Leave hostWallId out.");
                }

                if (flipFacing)
                {
                    throw reader.Refuse($"{name} has no host to face away from, so flipFacing does not apply. Turn it with rotationDeg.");
                }

                break;

            case FamilyPlacementType.OneLevelBasedHosted:
                if (host is null)
                {
                    throw reader.Refuse(
                        $"{name} is hosted, so it needs the wall it hangs on in hostWallId: without a host Revit puts it at a wrong place with no geometry and says nothing.");
                }

                if (rotationDeg != 0)
                {
                    throw reader.Refuse($"{name} is hosted, so it takes its direction from the wall and rotationDeg does not apply. Use flipFacing for the other side of the wall.");
                }

                break;

            default:
                throw reader.Refuse(
                    $"{name} has the placement type {symbol.Family.FamilyPlacementType}, which this tool does not handle. "
                    + $"It places families of the types {FamilyPlacementType.OneLevelBased} and {FamilyPlacementType.OneLevelBasedHosted}.");
        }
    }

    /// <summary>
    /// Where a hosted instance will stand: the point of the axis of the wall nearest to the point asked for, at the height asked
    /// for. The height must be one the wall has, or the wall is the wrong one for the level.
    /// </summary>
    private static XYZ OnAxis(ItemReader reader, Wall host, XYZ requested, Level level, double elevationMm, double heightMm)
    {
        var axis = (host.Location as LocationCurve)?.Curve
            ?? throw reader.Refuse($"hostWallId {reader.Item.GetProperty("hostWallId").GetRawText()} is a wall with no axis, so nothing can hang on it.");

        if (host.get_BoundingBox(null) is { } box && WallGeometry.TopMm(host) is { } topMm)
        {
            var footMm = Units.InternalToMm(box.Min.Z);

            if (heightMm < footMm - WallReachMm || heightMm > topMm + WallReachMm)
            {
                throw reader.Refuse(
                    $"the point is at {Units.FormatNumber(heightMm)} mm (level '{level.Name}' at {Units.FormatNumber(Units.InternalToMm(level.ProjectElevation))} mm plus elevationMm {Units.FormatNumber(elevationMm)}), "
                    + $"but wall {host.Id} runs from {Units.FormatNumber(footMm)} mm to {Units.FormatNumber(topMm)} mm, so it does not reach that height. levelId may name the wrong level for this wall.");
            }
        }

        var nearest = axis.Project(new XYZ(requested.X, requested.Y, axis.GetEndPoint(0).Z))?.XYZPoint
            ?? throw reader.Refuse($"pointMm cannot be projected on the axis of wall {host.Id}.");

        return new XYZ(nearest.X, nearest.Y, requested.Z);
    }

    /// <summary>A hosted instance stands on the axis of its wall, so one asked for off the axis is not where it was asked for.</summary>
    private static IReadOnlyList<string> MovedWarnings(FamilyInstance instance, PlaceInput input)
    {
        if (input.HostId is null || instance.Location is not LocationPoint location)
        {
            return [];
        }

        var movedMm = Units.InternalToMm(new XYZ(location.Point.X - input.Point.X, location.Point.Y - input.Point.Y, 0).GetLength());

        return movedMm > SamePositionMm
            ? [$"The instance stands on the axis of wall {input.HostId}, {Units.FormatNumber(movedMm)} mm from pointMm: a hosted instance goes to the point of the axis nearest to the point asked for, and actual.pointMm is where it stands."]
            : [];
    }

    private static object Describe(Document document, FamilyInstance instance)
    {
        var location = (LocationPoint)instance.Location;
        var level = document.GetElement(instance.LevelId) as Level;

        return new
        {
            typeId = instance.GetTypeId().ToString(),
            pointMm = new { x = Units.InternalToMm(location.Point.X), y = Units.InternalToMm(location.Point.Y) },
            elevationMm = level is null ? (double?)null : Units.InternalToMm(location.Point.Z - level.ProjectElevation),
            rotationDeg = Normalize(Math.Round(Units.RadToDeg(location.Rotation), RotationDecimals)),
            levelId = level?.Id.ToString(),
            hostWallId = instance.Host is Wall wall ? wall.Id.ToString() : null,
            facingFlipped = instance.FacingFlipped,
        };
    }

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

    /// <param name="Point">Where Revit is asked to put it: pointMm and a Z that Revit takes as the height above the level for a free-standing family and as the height in the model for a hosted one.</param>
    /// <param name="Expected">Where it has to stand in the model: the height is the elevation of the level plus the one asked for, and a hosted one is on the axis of its wall.</param>
    private sealed record PlaceInput(
        ElementId SymbolId,
        ElementId LevelId,
        ElementId? HostId,
        XYZ Point,
        XYZ Expected,
        double ElevationMm,
        double RotationDeg,
        bool FlipFacing);
}
