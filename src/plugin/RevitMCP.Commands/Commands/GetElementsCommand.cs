using System.Text.Json;
using Autodesk.Revit.DB;
using RevitMCP.Bridge;
using RevitMCP.Commands.Dispatch;

namespace RevitMCP.Commands;

/// <summary>
/// Reads elements of the active document by ID. Text that cannot be an ID refuses the call, as the caller has a bug,
/// while an ID with no element is listed under <c>notFound</c>, as a deleted element is an ordinary answer. Both keys
/// are always present. <c>boundingBoxMm</c> is the model box, aligned to the model axes, and null when Revit knows none.
/// </summary>
public sealed class GetElementsCommand : ICommand
{
    public string Method => MethodNames.GetElements;

    public bool NeedsDocument => true;

    public JsonElement Execute(CommandContext context, JsonElement parameters)
    {
        var document = context.Document!;
        var elements = new List<object>();
        var notFound = new List<string>();

        foreach (var (text, id) in ReadIds(parameters))
        {
            if (document.GetElement(id) is { } element)
            {
                elements.Add(Describe(document, element));
            }
            else
            {
                notFound.Add(text);
            }
        }

        return JsonSerializer.SerializeToElement(new { elements, notFound });
    }

    /// <summary>All of it is read before Revit is asked anything. An ID asked twice is answered once.</summary>
    private List<(string Text, ElementId Id)> ReadIds(JsonElement parameters)
    {
        if (!parameters.TryGetProperty("ids", out var ids) || ids.ValueKind != JsonValueKind.Array || ids.GetArrayLength() == 0)
        {
            throw new RequestFailedException(JsonRpcCodes.InvalidParams, $"{Method} needs a list of ids in ids.");
        }

        return ids.EnumerateArray()
            .Select(id => id.ValueKind == JsonValueKind.String
                ? id.GetString()!
                : throw new RequestFailedException(JsonRpcCodes.InvalidParams, $"{Method}: ids are strings, and {id.GetRawText()} is not one."))
            .Select(text => (Text: text, Id: ElementIds.Parse(text, Method)))
            .DistinctBy(entry => entry.Id.Value)
            .ToList();
    }

    private static object Describe(Document document, Element element)
    {
        var levelId = element.LevelId;

        return new
        {
            id = element.Id.ToString(),
            category = CategoryMap.KeyOf(element.Category),
            typeName = document.GetElement(element.GetTypeId())?.Name,
            levelId = levelId == ElementId.InvalidElementId ? null : levelId.ToString(),
            boundingBoxMm = BoxMm(element.get_BoundingBox(null)),
        };
    }

    private static object? BoxMm(BoundingBoxXYZ? box) =>
        box is null ? null : new { min = PointMm(box.Min), max = PointMm(box.Max) };

    private static object PointMm(XYZ point) => new
    {
        x = Units.InternalToMm(point.X),
        y = Units.InternalToMm(point.Y),
        z = Units.InternalToMm(point.Z),
    };
}
