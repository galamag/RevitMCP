using System.Text.Json;
using Autodesk.Revit.DB;
using RevitMCP.Bridge;
using RevitMCP.Commands.Dispatch;

namespace RevitMCP.Commands;

/// <summary>
/// Lists the types of one category of the active document as <c>[{ id, family, name }]</c>. The names are Revit's own
/// text. The sort uses the ordinal order, so it does not depend on the culture of the machine.
/// </summary>
public sealed class ListTypesCommand : ICommand
{
    public string Method => MethodNames.ListTypes;

    public bool NeedsDocument => true;

    public JsonElement Execute(CommandContext context, JsonElement parameters) =>
        JsonSerializer.SerializeToElement(
            new FilteredElementCollector(context.Document!)
                .OfCategory(ReadCategory(parameters))
                .WhereElementIsElementType()
                .Cast<ElementType>()
                .OrderBy(type => type.FamilyName, StringComparer.Ordinal)
                .ThenBy(type => type.Name, StringComparer.Ordinal)
                .ThenBy(type => type.Id.Value)
                .Select(type => new { id = type.Id.ToString(), family = type.FamilyName, name = type.Name })
                .ToList());

    private static BuiltInCategory ReadCategory(JsonElement parameters)
    {
        var word = parameters.TryGetProperty("category", out var category) && category.ValueKind == JsonValueKind.String
            ? category.GetString()!
            : string.Empty;

        return CategoryMap.TryFind(word, out var found)
            ? found
            : throw new RequestFailedException(
                JsonRpcCodes.InvalidParams,
                $"'{word}' is not a category of {MethodNames.ListTypes}. Use one of: {string.Join(", ", CategoryMap.Keys)}.");
    }
}
