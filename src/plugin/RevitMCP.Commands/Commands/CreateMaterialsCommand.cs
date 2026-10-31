using System.Text.Json;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Visual;
using RevitMCP.Bridge;
using RevitMCP.Commands.Dispatch;

namespace RevitMCP.Commands;

/// <summary>
/// Creates materials as one transaction, with a colour that shows in Realistic as well as in Shading. A new material gets
/// a copy of a plain generic appearance asset, see <see cref="AppearanceAssets"/>. A material made from a base is
/// duplicated together with a copy of its asset, as a duplicate shares the asset of its base, and a colour set on that
/// would recolour the base too. An existing material is never changed: its name, matched exactly, gives
/// <see cref="ItemStatus.AlreadyExisted"/> and what it really is, with a warning where that is not what the caller asked for.
/// </summary>
public sealed class CreateMaterialsCommand : ICommand
{
    private const int MaxChannel = 255;

    private const int MaxTransparency = 100;

    public string Method => MethodNames.CreateMaterials;

    public bool NeedsDocument => true;

    public JsonElement Execute(CommandContext context, JsonElement parameters)
    {
        var document = context.Document!;
        var materials = new FilteredElementCollector(document).OfClass(typeof(Material)).Cast<Material>().ToList();
        var plain = new Lazy<AppearanceAssetElement?>(() => AppearanceAssets.FindPlainGeneric(document));
        var assetNames = new Lazy<HashSet<string>>(() => AppearanceAssets.Names(document));
        var entries = ItemBatch.ReadItems(parameters, Method)
            .Select((item, index) => ReadMaterial(document, materials, plain, assetNames, item, index))
            .ToList();

        RefuseRepeatedNames(entries);

        return ItemBatch.Run(document, Method, entries, input => Build(document, input), element => Describe(document, (Material)element));
    }

    private static Material Build(Document document, MaterialInput input)
    {
        var material = input.Base is { } baseMaterial
            ? baseMaterial.Duplicate(input.Name) ?? throw new InvalidOperationException($"Revit could not duplicate material {baseMaterial.Id}.")
            : (Material)document.GetElement(Material.Create(document, input.Name));

        if (input.Colour is { } colour)
        {
            // Off, because on it the material takes its Shading colour from the asset and this colour is lost.
            material.UseRenderAppearanceForShading = false;
            material.Color = new Color((byte)colour.R, (byte)colour.G, (byte)colour.B);
        }

        material.Transparency = input.Transparency;

        if (input.AssetSource is { } source)
        {
            var copy = source.Duplicate(input.AssetName!);
            material.AppearanceAssetId = copy.Id;
            EditAsset(document, copy.Id, input);
        }

        return material;
    }

    private static void EditAsset(Document document, ElementId assetId, MaterialInput input)
    {
        using var scope = new AppearanceAssetEditScope(document);

        try
        {
            var asset = scope.Start(assetId);

            if (input.Colour is { } colour)
            {
                var diffuse = AppearanceAssets.DiffuseOf(asset)
                    ?? throw new InvalidOperationException("The copy of the appearance asset has no colour to set.");

                // A texture on the colour would draw over it.
                if (diffuse.NumberOfConnectedProperties > 0)
                {
                    diffuse.RemoveConnectedAsset();
                }

                diffuse.SetValueAsColor(new Color((byte)colour.R, (byte)colour.G, (byte)colour.B));
            }

            if (AppearanceAssets.TransparencyOf(asset) is { } transparency)
            {
                transparency.Value = input.Transparency / (double)MaxTransparency;
            }

            scope.Commit(true);
        }
        finally
        {
            if (scope.IsActive)
            {
                scope.Cancel();
            }
        }
    }

    private BatchEntry<MaterialInput> ReadMaterial(
        Document document,
        List<Material> materials,
        Lazy<AppearanceAssetElement?> plain,
        Lazy<HashSet<string>> assetNames,
        JsonElement item,
        int index)
    {
        var reader = new ItemReader(item, $"{Method} item {index}");
        var name = reader.Name("name", "a material");
        var baseMaterial = reader.Has("baseMaterialId") ? reader.Material(document, "baseMaterialId") : null;
        (int R, int G, int B)? colour = reader.Has("colorRgb") ? ReadColour(reader) : null;
        var transparency = reader.Has("transparency")
            ? reader.WholeNumber("transparency", item.GetProperty("transparency"), 0, MaxTransparency)
            : 0;

        if (colour is null && baseMaterial is null)
        {
            throw reader.Refuse("give colorRgb, or baseMaterialId to take the colour of a material that exists.");
        }

        var input = new MaterialInput(name, baseMaterial, colour, transparency, null, null);
        var existing = materials.FirstOrDefault(material => material.Name == name);

        if (existing is not null)
        {
            return new BatchEntry<MaterialInput>(index, item, input, ReportExisting(document, existing, input, index, item));
        }

        if (!Material.IsNameUnique(document, name))
        {
            throw reader.Refuse($"Revit does not take '{name}' as the name of a new material, as it counts it equal to the name of one that exists. Use another name.");
        }

        var source = SourceAsset(document, reader, plain, baseMaterial, colour, transparency);
        var assetName = source is null ? null : AppearanceAssets.UniqueName(name, assetNames.Value);

        return new BatchEntry<MaterialInput>(index, item, input with { AssetSource = source, AssetName = assetName });
    }

    /// <summary>
    /// The appearance asset to copy for the new material, checked to take what is asked of it, or null for a copy of a base
    /// that has no asset and is asked for nothing that needs one.
    /// </summary>
    private static AppearanceAssetElement? SourceAsset(
        Document document,
        ItemReader reader,
        Lazy<AppearanceAssetElement?> plain,
        Material? baseMaterial,
        (int R, int G, int B)? colour,
        int transparency)
    {
        if (baseMaterial is null)
        {
            return plain.Value
                ?? throw reader.Refuse("this project has no plain generic appearance asset to copy, so no colour can be made to show in Realistic. Give baseMaterialId of a material whose appearance has a colour.");
        }

        if (document.GetElement(baseMaterial.AppearanceAssetId) is not AppearanceAssetElement baseAsset)
        {
            return colour is null && transparency == 0
                ? null
                : throw reader.Refuse(
                    $"baseMaterialId {baseMaterial.Id} ('{baseMaterial.Name}') has no appearance asset, so a colour or transparency on its copy would not show in Realistic. Leave baseMaterialId out and give colorRgb.");
        }

        var rendering = AppearanceAssets.Rendering(baseAsset);

        if (colour is not null && (rendering is null || AppearanceAssets.DiffuseOf(rendering) is null))
        {
            throw reader.Refuse(
                $"baseMaterialId {baseMaterial.Id} ('{baseMaterial.Name}') has an appearance with no plain colour to set, such as brick or wood, so its copy could not be given the colour in Realistic. "
                + "Leave colorRgb out to copy it as it is, or leave baseMaterialId out and give colorRgb.");
        }

        if (transparency > 0 && (rendering is null || AppearanceAssets.TransparencyOf(rendering) is null))
        {
            throw reader.Refuse(
                $"baseMaterialId {baseMaterial.Id} ('{baseMaterial.Name}') has an appearance with no transparency to set, so its copy would not be see-through in Realistic. "
                + "Leave transparency out, or leave baseMaterialId out.");
        }

        return baseAsset;
    }

    private static (int R, int G, int B) ReadColour(ItemReader reader)
    {
        var colour = reader.Item.GetProperty("colorRgb");

        if (colour.ValueKind != JsonValueKind.Object)
        {
            throw reader.Refuse($"colorRgb must be {{ r, g, b }}, each a whole number from 0 to {MaxChannel}, not {colour.GetRawText()}.");
        }

        int Channel(string key) =>
            colour.TryGetProperty(key, out var value)
                ? reader.WholeNumber($"colorRgb.{key}", value, 0, MaxChannel)
                : throw reader.Refuse($"colorRgb must be {{ r, g, b }}, each a whole number from 0 to {MaxChannel}, and {key} is missing.");

        return (Channel("r"), Channel("g"), Channel("b"));
    }

    private static ItemResult ReportExisting(Document document, Material material, MaterialInput input, int index, JsonElement requested)
    {
        var warnings = new List<string>();

        if (input.Colour is { } colour)
        {
            var shading = AppearanceAssets.ShadingColour(material);
            var realistic = AppearanceAssets.RealisticColour(document, material);

            if (shading != colour)
            {
                warnings.Add($"Material '{material.Name}' shows {Rgb(shading)} in Shading, not the {Rgb(colour)} asked for. It was not changed.");
            }

            if (realistic != colour)
            {
                warnings.Add($"Material '{material.Name}' shows {Rgb(realistic)} in Realistic, not the {Rgb(colour)} asked for. It was not changed.");
            }
        }

        if (material.Transparency != input.Transparency)
        {
            warnings.Add($"Material '{material.Name}' has transparency {material.Transparency}, not the {input.Transparency} asked for. It was not changed.");
        }

        return new ItemResult(
            index,
            ItemStatus.AlreadyExisted,
            material.Id.ToString(),
            requested,
            JsonSerializer.SerializeToElement(Describe(document, material), ProjectSupport.Options),
            warnings,
            null);
    }

    private static string Rgb((int R, int G, int B)? colour) =>
        colour is { } found ? $"({found.R}, {found.G}, {found.B})" : "no single colour";

    private void RefuseRepeatedNames(List<BatchEntry<MaterialInput>> entries)
    {
        var repeated = entries.GroupBy(entry => entry.Input.Name, StringComparer.Ordinal).FirstOrDefault(group => group.Count() > 1);

        if (repeated is not null)
        {
            throw new RequestFailedException(
                JsonRpcCodes.InvalidParams,
                $"{Method}: items {string.Join(" and ", repeated.Select(entry => entry.Index))} both name '{repeated.Key}'. A material name is unique, so keep one.");
        }
    }

    private static object Describe(Document document, Material material) => new
    {
        name = material.Name,
        materialClass = material.MaterialClass,
        colorRgb = AppearanceAssets.Json(AppearanceAssets.ShadingColour(material)),
        appearanceColorRgb = AppearanceAssets.Json(AppearanceAssets.RealisticColour(document, material)),
        transparency = material.Transparency,
        appearanceAssetId = material.AppearanceAssetId == ElementId.InvalidElementId ? null : material.AppearanceAssetId.ToString(),
        useRenderAppearanceForShading = material.UseRenderAppearanceForShading,
    };

    private sealed record MaterialInput(
        string Name,
        Material? Base,
        (int R, int G, int B)? Colour,
        int Transparency,
        AppearanceAssetElement? AssetSource,
        string? AssetName);
}
