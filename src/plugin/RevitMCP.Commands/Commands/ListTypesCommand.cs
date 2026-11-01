using System.Text.Json;
using Autodesk.Revit.DB;
using RevitMCP.Bridge;
using RevitMCP.Commands.Dispatch;

namespace RevitMCP.Commands;

/// <summary>
/// Lists the types of one category of the active document as <c>[{ id, family, name }]</c>, or its 3D view templates in
/// the same shape with an empty <c>family</c>. The names are Revit's own text. The sort uses the ordinal order, so it
/// does not depend on the culture of the machine. The stairs category lists <c>StairsType</c> only, the types
/// <c>create_stairs</c> takes, and leaves out the component <c>Stair</c> families that share the category.
/// </summary>
public sealed class ListTypesCommand : ICommand
{
    public string Method => MethodNames.ListTypes;

    public bool NeedsDocument => true;

    public JsonElement Execute(CommandContext context, JsonElement parameters)
    {
        var document = context.Document!;
        var word = parameters.TryGetProperty("category", out var category) && category.ValueKind == JsonValueKind.String
            ? category.GetString()!
            : string.Empty;

        if (word == ViewTemplates.Category)
        {
            return JsonSerializer.SerializeToElement(
                ViewTemplates.List(document).ConvertAll(view => new { id = view.Id.ToString(), family = string.Empty, name = view.Name }));
        }

        if (!CategoryMap.TryFind(word, out var found))
        {
            throw new RequestFailedException(
                JsonRpcCodes.InvalidParams,
                $"'{word}' is not a category of {Method}. Use one of: {string.Join(", ", CategoryMap.Keys.Append(ViewTemplates.Category))}.");
        }

        return JsonSerializer.SerializeToElement(
            new FilteredElementCollector(document)
                .OfCategory(found)
                .WhereElementIsElementType()
                .Cast<ElementType>()
                .Where(type => found != BuiltInCategory.OST_Stairs || type is Autodesk.Revit.DB.Architecture.StairsType)
                .OrderBy(type => type.FamilyName, StringComparer.Ordinal)
                .ThenBy(type => type.Name, StringComparer.Ordinal)
                .ThenBy(type => type.Id.Value)
                .Select(type => new { id = type.Id.ToString(), family = type.FamilyName, name = type.Name })
                .ToList());
    }
}
