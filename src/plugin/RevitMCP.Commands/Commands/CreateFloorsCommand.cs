using System.Text.Json;
using Autodesk.Revit.DB;
using RevitMCP.Bridge;
using RevitMCP.Commands.Dispatch;

namespace RevitMCP.Commands;

/// <summary>
/// Creates floors from outlines of straight edges as one transaction. The outline closes by itself, from the last point
/// back to the first, so a first point repeated at the end is two equal neighbours, and that is refused.
/// </summary>
public sealed class CreateFloorsCommand : ICommand
{
    private const int MinPoints = 3;

    public string Method => MethodNames.CreateFloors;

    public bool NeedsDocument => true;

    public JsonElement Execute(CommandContext context, JsonElement parameters)
    {
        var document = context.Document!;
        var entries = ItemBatch.ReadItems(parameters, Method)
            .Select((item, index) => ReadFloor(document, item, index))
            .ToList();

        return ItemBatch.Run(
            document,
            Method,
            entries,
            input => Floor.Create(document, [input.Outline], input.TypeId, input.LevelId),
            element => Describe((Floor)element));
    }

    private BatchEntry<FloorInput> ReadFloor(Document document, JsonElement item, int index)
    {
        var reader = new ItemReader(item, $"{Method} item {index}");
        var typeId = reader.Type<FloorType>(document, "typeId", "floors");
        var level = reader.Level(document, "levelId");

        return new BatchEntry<FloorInput>(index, item, new FloorInput(ReadOutline(document, reader, level), typeId, level.Id));
    }

    private static CurveLoop ReadOutline(Document document, ItemReader reader, Level level)
    {
        if (!reader.Item.TryGetProperty("boundaryMm", out var boundary) || boundary.ValueKind != JsonValueKind.Array || boundary.GetArrayLength() < MinPoints)
        {
            throw reader.Refuse($"boundaryMm must be a list of at least {MinPoints} points.");
        }

        var elevationMm = Units.InternalToMm(level.ProjectElevation);
        var points = boundary.EnumerateArray()
            .Select(point => reader.Point("boundaryMm", point))
            .Select(point => Units.PointMm(point.X, point.Y, elevationMm))
            .ToList();

        var shortest = document.Application.ShortCurveTolerance;
        var outline = new CurveLoop();
        for (var index = 0; index < points.Count; index++)
        {
            var next = (index + 1) % points.Count;
            if (points[index].DistanceTo(points[next]) < shortest)
            {
                throw reader.Refuse(
                    $"boundaryMm points {index} and {next} are closer than the {Units.InternalToMm(shortest):0.###} mm Revit can draw. The outline closes by itself, so do not repeat the first point.");
            }

            outline.Append(Line.CreateBound(points[index], points[next]));
        }

        return BoundaryValidation.IsValidHorizontalBoundary([outline])
            ? outline
            : throw reader.Refuse("boundaryMm is not a valid outline, as Revit reads it: its edges must not cross.");
    }

    private static object Describe(Floor floor)
    {
        var box = floor.get_BoundingBox(null);

        return new
        {
            areaM2 = Units.InternalToSquareMetres(floor.get_Parameter(BuiltInParameter.HOST_AREA_COMPUTED).AsDouble()),
            heightOffsetMm = Units.InternalToMm(floor.get_Parameter(BuiltInParameter.FLOOR_HEIGHTABOVELEVEL_PARAM).AsDouble()),
            typeId = floor.GetTypeId().ToString(),
            levelId = floor.LevelId.ToString(),
            boundingBoxMm = box is null ? null : new { min = PointMm(box.Min), max = PointMm(box.Max) },
        };
    }

    private static object PointMm(XYZ point) => new
    {
        x = Units.InternalToMm(point.X),
        y = Units.InternalToMm(point.Y),
        z = Units.InternalToMm(point.Z),
    };

    private sealed record FloorInput(CurveLoop Outline, ElementId TypeId, ElementId LevelId);
}
