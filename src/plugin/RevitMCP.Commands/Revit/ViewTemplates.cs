using Autodesk.Revit.DB;

namespace RevitMCP.Commands;

/// <summary>
/// The 3D view templates of a document. They are views, not types, so they sit beside <see cref="CategoryMap"/> and not
/// in it. Their names are localized, so the plugin never picks one itself: a client reads them and passes an ID.
/// </summary>
internal static class ViewTemplates
{
    /// <summary>The word of <c>list_types</c> that asks for these templates.</summary>
    public const string Category = "view_templates";

    /// <summary>Sorted by name, then ID. The ordinal order does not depend on the culture of the machine.</summary>
    public static List<View> List(Document document) =>
        new FilteredElementCollector(document)
            .OfClass(typeof(View))
            .Cast<View>()
            .Where(view => view.IsTemplate && view.ViewType == ViewType.ThreeD)
            .OrderBy(view => view.Name, StringComparer.Ordinal)
            .ThenBy(view => view.Id.Value)
            .ToList();
}
