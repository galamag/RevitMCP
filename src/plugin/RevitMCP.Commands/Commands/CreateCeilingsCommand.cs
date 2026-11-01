using System.Text.Json;
using Autodesk.Revit.DB;
using RevitMCP.Bridge;
using RevitMCP.Commands.Dispatch;

namespace RevitMCP.Commands;

/// <summary>
/// Creates ceilings from outlines of straight edges as one transaction. The height is always given, because Revit puts
/// a new ceiling 2600 mm above its level, whatever the storey holds (live Revit), and the Z of the outline moves nothing.
/// It goes through <see cref="BuiltInParameter.CEILING_HEIGHTABOVELEVEL_PARAM"/> and is read back from the model.
/// </summary>
public sealed class CreateCeilingsCommand : ICommand
{
    public string Method => MethodNames.CreateCeilings;

    public bool NeedsDocument => true;

    public JsonElement Execute(CommandContext context, JsonElement parameters)
    {
        var document = context.Document!;
        var entries = ItemBatch.ReadItems(parameters, Method)
            .Select((item, index) => ReadCeiling(document, item, index))
            .ToList();

        return ItemBatch.Run(document, Method, entries, input => Build(document, input), element => Describe((Ceiling)element));
    }

    private static Ceiling Build(Document document, CeilingInput input)
    {
        var ceiling = Ceiling.Create(document, [input.Outline], input.TypeId, input.LevelId);
        HeightOffset.Apply(document, ceiling, BuiltInParameter.CEILING_HEIGHTABOVELEVEL_PARAM, input.HeightOffset, "ceiling");

        return ceiling;
    }

    private BatchEntry<CeilingInput> ReadCeiling(Document document, JsonElement item, int index)
    {
        var reader = new ItemReader(item, $"{Method} item {index}");
        var typeId = reader.Type<CeilingType>(document, "typeId", "ceilings");
        var level = reader.Level(document, "levelId");
        var outline = reader.Outline(document, "boundaryMm", level);
        var heightOffset = Units.MmToInternal(reader.Number("heightOffsetMm"));

        return new BatchEntry<CeilingInput>(index, item, new CeilingInput(outline, typeId, level.Id, heightOffset));
    }

    private static object Describe(Ceiling ceiling) => new
    {
        areaM2 = ceiling.get_Parameter(BuiltInParameter.HOST_AREA_COMPUTED) is { } area ? Units.InternalToSquareMetres(area.AsDouble()) : (double?)null,
        heightOffsetMm = Units.InternalToMm(ceiling.get_Parameter(BuiltInParameter.CEILING_HEIGHTABOVELEVEL_PARAM).AsDouble()),
        typeId = ceiling.GetTypeId().ToString(),
        levelId = ceiling.LevelId.ToString(),
        boundingBoxMm = ElementJson.BoxMm(ceiling.get_BoundingBox(null)),
    };

    private sealed record CeilingInput(CurveLoop Outline, ElementId TypeId, ElementId LevelId, double HeightOffset);
}
