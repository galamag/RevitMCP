using System.Text.Json;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Architecture;
using RevitMCP.Bridge;
using RevitMCP.Commands.Dispatch;

namespace RevitMCP.Commands;

/// <summary>
/// Reads elements of the active document, either by ID or by category. Give exactly one of <c>ids</c> and
/// <c>category</c>, and <c>levelId</c> only with <c>category</c>. Text that cannot be an ID refuses the call, as the
/// caller has a bug, while an ID with no element is listed under <c>notFound</c>, as a deleted element is an ordinary
/// answer. A category lists the elements of the model, not their types, by ID, and stops at
/// <see cref="ElementIds.MaxListed"/>: <c>truncated</c> says that more matched. The keys <c>elements</c>,
/// <c>notFound</c> and <c>truncated</c> are always present. <c>boundingBoxMm</c> is the model box, aligned to the model
/// axes, and null when Revit knows none. A wall also has <c>topMm</c>, and a room <c>name</c>, <c>number</c> and <c>areaM2</c>.
/// </summary>
public sealed class GetElementsCommand : ICommand
{
    public string Method => MethodNames.GetElements;

    public bool NeedsDocument => true;

    public JsonElement Execute(CommandContext context, JsonElement parameters)
    {
        var document = context.Document!;
        var byIds = Has(parameters, "ids");
        var byCategory = Has(parameters, "category");

        if (byIds == byCategory)
        {
            throw Refuse($"{Method} needs exactly one of ids and category, and got {(byIds ? "both" : "neither")}.");
        }

        if (byIds && Has(parameters, "levelId"))
        {
            throw Refuse($"{Method} takes levelId only with category: a list of ids is not narrowed by a level.");
        }

        return byIds ? ReadByIds(document, parameters) : ReadByCategory(document, parameters);
    }

    private JsonElement ReadByIds(Document document, JsonElement parameters)
    {
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

        return JsonSerializer.SerializeToElement(new { elements, notFound, truncated = false });
    }

    private JsonElement ReadByCategory(Document document, JsonElement parameters)
    {
        var category = ReadCategory(parameters);
        var level = Has(parameters, "levelId") ? new ItemReader(parameters, Method).Level(document, "levelId") : null;

        // The level is compared as Element.LevelId, the value the answer prints, so what is asked for is what comes back.
        var found = new FilteredElementCollector(document)
            .OfCategory(category)
            .WhereElementIsNotElementType()
            .Where(element => level is null || element.LevelId == level.Id)
            .OrderBy(element => element.Id.Value)
            .ToList();

        return JsonSerializer.SerializeToElement(new
        {
            elements = found.Take(ElementIds.MaxListed).Select(element => Describe(document, element)).ToList(),
            notFound = Array.Empty<string>(),
            truncated = found.Count > ElementIds.MaxListed,
        });
    }

    private BuiltInCategory ReadCategory(JsonElement parameters)
    {
        var value = parameters.GetProperty("category");
        if (value.ValueKind != JsonValueKind.String)
        {
            throw Refuse($"{Method}: category must be text, one of: {string.Join(", ", CategoryMap.Keys)}.");
        }

        var word = value.GetString()!;

        return CategoryMap.TryFind(word, out var found)
            ? found
            : throw Refuse($"'{word}' is not a category of {Method}. Use one of: {string.Join(", ", CategoryMap.Keys)}.");
    }

    /// <summary>A key with a value. A null is as good as no key, as a client that fills every field sends one.</summary>
    private static bool Has(JsonElement parameters, string key) =>
        parameters.TryGetProperty(key, out var value) && value.ValueKind != JsonValueKind.Null;

    private static RequestFailedException Refuse(string message) => new(JsonRpcCodes.InvalidParams, message);

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

        // A room is told apart by its name and its area: a room that encloses nothing reads 0.
        if (element is Room room)
        {
            description["name"] = CreateRoomsCommand.NameOf(room);
            description["number"] = CreateRoomsCommand.NumberOf(room);
            description["areaM2"] = Units.InternalToSquareMetres(room.Area);
        }

        return description;
    }
}
