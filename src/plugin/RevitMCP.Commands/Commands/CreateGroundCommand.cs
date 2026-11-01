using System.Text.Json;
using Autodesk.Revit.DB;
using RevitMCP.Bridge;
using RevitMCP.Commands.Dispatch;

namespace RevitMCP.Commands;

/// <summary>
/// Creates ground, as toposolids, from outlines of straight edges as one transaction. The ground is flat: its top lies
/// <c>topOffsetMm</c> above the level, written through <see cref="BuiltInParameter.TOPOSOLID_HEIGHTABOVELEVEL_PARAM"/>
/// and read back from the model, and the thickness of its type goes down from there. Live Revit: a toposolid whose top
/// lies above the underside of a floor gets the persistent warning "toposolid and floor overlap". It is not refused, as
/// it is no error, and it is not hidden: it is reported in the warnings of the result.
/// </summary>
public sealed class CreateGroundCommand : ICommand
{
    public string Method => MethodNames.CreateGround;

    public bool NeedsDocument => true;

    public JsonElement Execute(CommandContext context, JsonElement parameters)
    {
        var document = context.Document!;
        var entries = ItemBatch.ReadItems(parameters, Method)
            .Select((item, index) => ReadGround(document, item, index))
            .ToList();

        return ItemBatch.Run(document, Method, entries, input => Build(document, input), element => Describe((Toposolid)element));
    }

    private static Toposolid Build(Document document, GroundInput input)
    {
        var ground = Toposolid.Create(document, [input.Outline], input.TypeId, input.LevelId);
        HeightOffset.Apply(document, ground, BuiltInParameter.TOPOSOLID_HEIGHTABOVELEVEL_PARAM, input.TopOffset, "ground");

        return ground;
    }

    private BatchEntry<GroundInput> ReadGround(Document document, JsonElement item, int index)
    {
        var reader = new ItemReader(item, $"{Method} item {index}");
        var typeId = reader.Type<ToposolidType>(document, "typeId", "toposolid");
        var level = reader.Level(document, "levelId");
        var outline = reader.Outline(document, "boundaryMm", level);
        var topOffset = Units.MmToInternal(reader.Number("topOffsetMm"));

        return new BatchEntry<GroundInput>(index, item, new GroundInput(outline, typeId, level.Id, topOffset));
    }

    private static object Describe(Toposolid ground) => new
    {
        topOffsetMm = Units.InternalToMm(ground.get_Parameter(BuiltInParameter.TOPOSOLID_HEIGHTABOVELEVEL_PARAM).AsDouble()),
        typeId = ground.GetTypeId().ToString(),
        levelId = ground.LevelId.ToString(),
        boundingBoxMm = ElementJson.BoxMm(ground.get_BoundingBox(null)),
    };

    private sealed record GroundInput(CurveLoop Outline, ElementId TypeId, ElementId LevelId, double TopOffset);
}
