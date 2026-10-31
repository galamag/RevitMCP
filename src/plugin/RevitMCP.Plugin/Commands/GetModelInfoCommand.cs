using System.Text.Json;
using Autodesk.Revit.DB;
using RevitMCP.Bridge;
using RevitMCP.Plugin.Dispatch;

namespace RevitMCP.Plugin.Commands;

/// <summary>
/// Describes the active document and lists every open one. IDs are strings and elevations are millimetres.
/// Names may be localized, so <c>viewType</c> and <c>category</c> are the stable values to match on.
/// Works with no active document, since clients ask this to learn what is open: <c>activeDocument</c> is then
/// null and <c>levels</c>, <c>views</c> and <c>categoryCounts</c> are empty, and all five keys are always present.
/// </summary>
public sealed class GetModelInfoCommand : ICommand
{
    public string Method => MethodNames.GetModelInfo;

    public bool NeedsDocument => false;

    public JsonElement Execute(CommandContext context, JsonElement parameters)
    {
        var document = context.Document;
        var none = Array.Empty<object>();

        return JsonSerializer.SerializeToElement(new
        {
            activeDocument = document is null ? null : Describe(document),
            levels = document is null ? none : ListLevels(document),
            views = document is null ? none : ListViews(document),
            categoryCounts = document is null ? none : CountByCategory(document),
            openDocuments = context.UiApp.Application.Documents.Cast<Document>().Select(Describe).ToList(),
        });
    }

    private static object Describe(Document document) => new
    {
        title = document.Title,
        path = document.PathName,
        isModified = document.IsModified,
    };

    private static object ListLevels(Document document) =>
        new FilteredElementCollector(document)
            .OfClass(typeof(Level))
            .Cast<Level>()
            .OrderBy(level => level.ProjectElevation)
            .Select(level => new
            {
                id = level.Id.ToString(),
                name = level.Name,

                // ProjectElevation, because Elevation shifts with the level's Elevation Base setting.
                elevationMm = UnitUtils.ConvertFromInternalUnits(level.ProjectElevation, UnitTypeId.Millimeters),
            })
            .ToList();

    private static object ListViews(Document document) =>
        new FilteredElementCollector(document)
            .OfClass(typeof(View))
            .Cast<View>()
            .Where(view => !view.IsTemplate && IsOpenable(view.ViewType))
            .OrderBy(view => view.Name, StringComparer.Ordinal)
            .Select(view => new
            {
                id = view.Id.ToString(),
                name = view.Name,
                viewType = view.ViewType.ToString(),
            })
            .ToList();

    /// <summary>The browsers and internal views are elements too, but nobody can show or draw in them.</summary>
    private static bool IsOpenable(ViewType viewType) =>
        viewType is not (ViewType.ProjectBrowser or ViewType.SystemBrowser or ViewType.Internal or ViewType.Undefined);

    private static object CountByCategory(Document document) =>
        new FilteredElementCollector(document)
            .WhereElementIsNotElementType()
            .Select(element => element.Category)
            .Where(category => category is not null)
            .GroupBy(category => category.Id.Value)
            .Select(group => (Category: group.First(), Count: group.Count()))
            .OrderBy(entry => entry.Category.Name, StringComparer.Ordinal)
            .Select(entry => new
            {
                id = entry.Category.Id.ToString(),

                // Null for a category that is not built in, such as a user's subcategory.
                category = entry.Category.BuiltInCategory == BuiltInCategory.INVALID
                    ? null
                    : entry.Category.BuiltInCategory.ToString(),
                name = entry.Category.Name,
                count = entry.Count,
            })
            .ToList();
}
