using Autodesk.Revit.DB;

namespace RevitMCP.Commands;

/// <summary>
/// The category words of the contract. They replace localized category names, so a client reads the same word
/// whatever the language of Revit. <c>registry.ts</c> offers the same words in <c>list_types</c>, plus
/// <see cref="ViewTemplates.Category"/>, which is no category of Revit and so is not here.
/// </summary>
internal static class CategoryMap
{
    private static readonly Dictionary<string, BuiltInCategory> Categories = new(StringComparer.Ordinal)
    {
        ["walls"] = BuiltInCategory.OST_Walls,
        ["floors"] = BuiltInCategory.OST_Floors,
        ["roofs"] = BuiltInCategory.OST_Roofs,
        ["ceilings"] = BuiltInCategory.OST_Ceilings,
        ["doors"] = BuiltInCategory.OST_Doors,
        ["windows"] = BuiltInCategory.OST_Windows,
        ["furniture"] = BuiltInCategory.OST_Furniture,
        ["plumbing"] = BuiltInCategory.OST_PlumbingFixtures,
        ["stairs"] = BuiltInCategory.OST_Stairs,
        ["railings"] = BuiltInCategory.OST_StairsRailing,
        ["toposolid"] = BuiltInCategory.OST_Toposolid,
    };

    private static readonly Dictionary<BuiltInCategory, string> Words =
        Categories.ToDictionary(entry => entry.Value, entry => entry.Key);

    /// <summary>The words in the order of the contract.</summary>
    public static IReadOnlyCollection<string> Keys => Categories.Keys;

    public static bool TryFind(string key, out BuiltInCategory category) => Categories.TryGetValue(key, out category);

    /// <summary>
    /// Returns the word of <paramref name="category"/>, or else its <see cref="BuiltInCategory"/> name, which is just as
    /// stable. Returns <c>null</c> for no category and for a custom one, which has no stable name.
    /// </summary>
    public static string? KeyOf(Category? category)
    {
        if (category is null || category.BuiltInCategory == BuiltInCategory.INVALID)
        {
            return null;
        }

        return Words.GetValueOrDefault(category.BuiltInCategory, category.BuiltInCategory.ToString());
    }
}
