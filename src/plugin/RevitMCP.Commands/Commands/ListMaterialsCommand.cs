using System.Text.Json;
using Autodesk.Revit.DB;
using RevitMCP.Bridge;
using RevitMCP.Commands.Dispatch;

namespace RevitMCP.Commands;

/// <summary>
/// Lists the materials of the active document as <c>[{ id, name, materialClass, color, transparency }]</c>. The names
/// are Revit's own text. The sort uses the ordinal order, so it does not depend on the culture of the machine.
/// <c>color</c> is <c>{ r, g, b }</c>, or null when the material has no valid colour, as Revit throws on reading one.
/// </summary>
public sealed class ListMaterialsCommand : ICommand
{
    public string Method => MethodNames.ListMaterials;

    public bool NeedsDocument => true;

    public JsonElement Execute(CommandContext context, JsonElement parameters) =>
        JsonSerializer.SerializeToElement(
            new FilteredElementCollector(context.Document!)
                .OfClass(typeof(Material))
                .Cast<Material>()
                .OrderBy(material => material.Name, StringComparer.Ordinal)
                .ThenBy(material => material.Id.Value)
                .Select(material => new
                {
                    id = material.Id.ToString(),
                    name = material.Name,
                    materialClass = material.MaterialClass,
                    color = ColorOf(material),
                    transparency = material.Transparency,
                })
                .ToList());

    private static object? ColorOf(Material material) =>
        material.Color is { IsValid: true } color ? new { r = color.Red, g = color.Green, b = color.Blue } : null;
}
