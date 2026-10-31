using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Visual;

namespace RevitMCP.Commands;

/// <summary>
/// What the material commands know about appearance assets, which are what the Realistic display style draws. Live
/// Revit: it draws the asset only, so a colour set on the material alone shows in Shading and not in Realistic. A plain
/// colour lives in the <c>generic_diffuse</c> property of an asset of the base schema <c>GenericSchema</c>. Assets of other
/// schemas, such as brick or wood, have no such property. An asset is found by this schema and never by a name, as names
/// are localized.
/// </summary>
internal static class AppearanceAssets
{
    private const string GenericSchema = "GenericSchema";

    private const int MaxChannel = 255;

    /// <summary>
    /// The first plain generic asset by ID, which is one whose colour is a colour and not a texture, and which has a
    /// transparency to set. Null when the project holds none.
    /// </summary>
    public static AppearanceAssetElement? FindPlainGeneric(Document document) =>
        new FilteredElementCollector(document)
            .OfClass(typeof(AppearanceAssetElement))
            .Cast<AppearanceAssetElement>()
            .OrderBy(element => element.Id.Value)
            .FirstOrDefault(IsPlainGeneric);

    /// <summary>Whether the colour of this asset can be set: it has a <c>generic_diffuse</c>, with no texture connected to it.</summary>
    public static bool IsPlainGeneric(AppearanceAssetElement element) =>
        Rendering(element) is { } asset
        && asset.FindByName(SchemaCommon.BaseSchema) is AssetPropertyString { Value: GenericSchema }
        && DiffuseOf(asset) is { NumberOfConnectedProperties: 0 }
        && TransparencyOf(asset) is not null;

    /// <summary>The asset itself, or null when Revit gives none.</summary>
    public static Asset? Rendering(AppearanceAssetElement element) => element.GetRenderingAsset();

    public static AssetPropertyDoubleArray4d? DiffuseOf(Asset asset) => asset.FindByName(Generic.GenericDiffuse) as AssetPropertyDoubleArray4d;

    public static AssetPropertyDouble? TransparencyOf(Asset asset) => asset.FindByName(Generic.GenericTransparency) as AssetPropertyDouble;

    /// <summary>
    /// The colour the Realistic style draws for this material, as three channels from 0 to 255. Null when the asset has no
    /// plain colour to give, either for want of a <c>generic_diffuse</c> or because a texture is connected to it, and the
    /// texture is then what is drawn.
    /// </summary>
    public static (int R, int G, int B)? RealisticColour(Document document, Material material)
    {
        if (document.GetElement(material.AppearanceAssetId) is not AppearanceAssetElement element
            || Rendering(element) is not { } asset
            || DiffuseOf(asset) is not { NumberOfConnectedProperties: 0 } diffuse)
        {
            return null;
        }

        var channels = diffuse.GetValueAsDoubles();

        return (Channel(channels[0]), Channel(channels[1]), Channel(channels[2]));
    }

    /// <summary>The Shading colour of a material, or null when Revit holds no valid one.</summary>
    public static (int R, int G, int B)? ShadingColour(Material material) =>
        material.Color is { IsValid: true } color ? (color.Red, color.Green, color.Blue) : null;

    public static object? Json((int R, int G, int B)? colour) => colour is { } found ? new { r = found.R, g = found.G, b = found.B } : null;

    /// <summary>
    /// A name for a copy of an asset that no appearance asset has yet, and none of <paramref name="taken"/>. Revit refuses
    /// a name that an asset already has, and a template names assets much as it names materials.
    /// </summary>
    public static string UniqueName(string wanted, ISet<string> taken)
    {
        var candidate = wanted;

        for (var number = 2; taken.Contains(candidate); number++)
        {
            candidate = $"{wanted} {number}";
        }

        taken.Add(candidate);

        return candidate;
    }

    /// <summary>The names every appearance asset holds, compared without regard to case, as Revit may not tell such names apart.</summary>
    public static HashSet<string> Names(Document document) =>
        new FilteredElementCollector(document)
            .OfClass(typeof(AppearanceAssetElement))
            .Cast<AppearanceAssetElement>()
            .Select(element => element.Name)
            .ToHashSet(StringComparer.OrdinalIgnoreCase);

    private static int Channel(double value) => Math.Clamp((int)Math.Round(value * MaxChannel), 0, MaxChannel);
}
