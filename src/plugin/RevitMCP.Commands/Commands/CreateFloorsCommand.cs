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

        return new BatchEntry<FloorInput>(index, item, new FloorInput(reader.Outline(document, "boundaryMm", level), typeId, level.Id));
    }

    private static object Describe(Floor floor) => new
    {
        areaM2 = Units.InternalToSquareMetres(floor.get_Parameter(BuiltInParameter.HOST_AREA_COMPUTED).AsDouble()),
        heightOffsetMm = Units.InternalToMm(floor.get_Parameter(BuiltInParameter.FLOOR_HEIGHTABOVELEVEL_PARAM).AsDouble()),
        typeId = floor.GetTypeId().ToString(),
        levelId = floor.LevelId.ToString(),
        boundingBoxMm = ElementJson.BoxMm(floor.get_BoundingBox(null)),
    };

    private sealed record FloorInput(CurveLoop Outline, ElementId TypeId, ElementId LevelId);
}
