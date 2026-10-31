using System.Text.Json;
using Autodesk.Revit.DB;
using RevitMCP.Bridge;
using RevitMCP.Commands.Dispatch;

namespace RevitMCP.Commands;

/// <summary>
/// Creates straight walls as one transaction. A wall has either an unconnected height or a top level, which is its top
/// constraint. Neighbouring elements are left to the defaults of Revit, including how walls join.
/// </summary>
public sealed class CreateWallsCommand : ICommand
{
    public string Method => MethodNames.CreateWalls;

    public bool NeedsDocument => true;

    public JsonElement Execute(CommandContext context, JsonElement parameters)
    {
        var document = context.Document!;
        var entries = ItemBatch.ReadItems(parameters, Method)
            .Select((item, index) => ReadWall(document, item, index))
            .ToList();

        return ItemBatch.Run(document, Method, entries, input => Build(document, input), element => Describe((Wall)element));
    }

    private static Wall Build(Document document, WallInput input)
    {
        var wall = Wall.Create(document, input.Line, input.TypeId, input.LevelId, input.Height, input.BaseOffset, false, false);

        if (input.TopLevelId is { } top && wall.get_Parameter(BuiltInParameter.WALL_HEIGHT_TYPE)?.Set(top) != true)
        {
            throw new InvalidOperationException($"Revit refused level {top} as the top constraint of the wall.");
        }

        return wall;
    }

    private BatchEntry<WallInput> ReadWall(Document document, JsonElement item, int index)
    {
        var reader = new ItemReader(item, $"{Method} item {index}");
        var typeId = reader.Type<WallType>(document, "typeId", "walls");
        var level = reader.Level(document, "levelId");
        var baseOffset = Units.MmToInternal(reader.NumberOr("baseOffsetMm", 0));
        var (height, topLevelId) = ReadTop(document, reader, level, baseOffset);

        return new BatchEntry<WallInput>(index, item, new WallInput(ReadLine(document, reader, level), typeId, level.Id, height, baseOffset, topLevelId));
    }

    private static (double Height, ElementId? TopLevelId) ReadTop(Document document, ItemReader reader, Level level, double baseOffset)
    {
        if (reader.Has("heightMm") == reader.Has("topLevelId"))
        {
            throw reader.Refuse("give exactly one of heightMm and topLevelId.");
        }

        if (!reader.Has("topLevelId"))
        {
            var heightMm = reader.Number("heightMm");

            return heightMm > 0 ? (Units.MmToInternal(heightMm), null) : throw reader.Refuse($"heightMm must be above zero, not {heightMm}.");
        }

        var top = reader.Level(document, "topLevelId");
        var height = top.ProjectElevation - level.ProjectElevation - baseOffset;

        return height > 0
            ? (height, top.Id)
            : throw reader.Refuse(
                $"level '{top.Name}' at {Units.InternalToMm(top.ProjectElevation):0.###} mm is not above the foot of the wall at {Units.InternalToMm(level.ProjectElevation + baseOffset):0.###} mm.");
    }

    /// <summary>At the height of the level, so the line is where the wall stands.</summary>
    private static Line ReadLine(Document document, ItemReader reader, Level level)
    {
        var start = PointOnLevel(reader.Point("startMm"), level);
        var end = PointOnLevel(reader.Point("endMm"), level);
        var shortest = document.Application.ShortCurveTolerance;

        return start.DistanceTo(end) >= shortest
            ? Line.CreateBound(start, end)
            : throw reader.Refuse($"the wall from startMm to endMm is shorter than the {Units.InternalToMm(shortest):0.###} mm Revit can draw.");
    }

    private static XYZ PointOnLevel(PlanPointMm point, Level level) =>
        Units.PointMm(point.X, point.Y, Units.InternalToMm(level.ProjectElevation));

    private static object Describe(Wall wall)
    {
        var curve = ((LocationCurve)wall.Location).Curve;
        var top = wall.get_Parameter(BuiltInParameter.WALL_HEIGHT_TYPE).AsElementId();

        return new
        {
            startMm = PlanPoint(curve.GetEndPoint(0)),
            endMm = PlanPoint(curve.GetEndPoint(1)),
            lengthMm = Units.InternalToMm(curve.Length),
            heightMm = Units.InternalToMm(wall.get_Parameter(BuiltInParameter.WALL_USER_HEIGHT_PARAM).AsDouble()),
            widthMm = Units.InternalToMm(wall.Width),
            baseOffsetMm = Units.InternalToMm(wall.get_Parameter(BuiltInParameter.WALL_BASE_OFFSET).AsDouble()),
            typeId = wall.GetTypeId().ToString(),
            levelId = wall.get_Parameter(BuiltInParameter.WALL_BASE_CONSTRAINT).AsElementId().ToString(),
            topLevelId = top == ElementId.InvalidElementId ? null : top.ToString(),
        };
    }

    private static object PlanPoint(XYZ point) => new { x = Units.InternalToMm(point.X), y = Units.InternalToMm(point.Y) };

    private sealed record WallInput(Line Line, ElementId TypeId, ElementId LevelId, double Height, double BaseOffset, ElementId? TopLevelId);
}
