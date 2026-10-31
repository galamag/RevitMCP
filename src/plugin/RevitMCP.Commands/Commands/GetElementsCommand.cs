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

        foreach (var (text, id) in ElementIds.ReadList(parameters, Method))
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

    private static object Describe(Document document, Element element)
    {
        var levelId = element.LevelId;
        var description = new Dictionary<string, object?>
        {
            ["id"] = element.Id.ToString(),
            ["category"] = CategoryMap.KeyOf(element.Category),
            ["typeName"] = document.GetElement(element.GetTypeId())?.Name,
            ["levelId"] = levelId == ElementId.InvalidElementId ? null : levelId.ToString(),
            ["boundingBoxMm"] = ElementJson.BoxMm(element.get_BoundingBox(null)),
        };

        // Only a wall has a top that differs from its box: the box keeps the old height of a wall cut down to a roof.
        if (element is Wall wall)
        {
            description["topMm"] = WallGeometry.TopMm(wall);
        }

        return description;
    }
}
