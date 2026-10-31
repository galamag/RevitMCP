using System.Text.Json;
using Autodesk.Revit.DB;
using RevitMCP.Bridge;
using RevitMCP.Commands.Dispatch;

namespace RevitMCP.Commands;

/// <summary>
/// Lists the persistent warnings of the active document, the list Review Warnings shows, as
/// <c>[{ definitionId, text, elementIds, additionalElementIds }]</c> in the order Revit gives them. <c>definitionId</c> is the
/// GUID of the kind of warning, which does not change with the language of Revit, while <c>text</c> keeps Revit's own
/// language. The IDs inside a warning are sorted, as Revit hands them over as a set.
/// </summary>
public sealed class GetWarningsCommand : ICommand
{
    public string Method => MethodNames.GetWarnings;

    public bool NeedsDocument => true;

    public JsonElement Execute(CommandContext context, JsonElement parameters) =>
        JsonSerializer.SerializeToElement(
            context.Document!.GetWarnings()
                .Select(warning => new
                {
                    definitionId = warning.GetFailureDefinitionId().Guid.ToString("D"),
                    text = warning.GetDescriptionText(),
                    elementIds = Ids(warning.GetFailingElements()),
                    additionalElementIds = Ids(warning.GetAdditionalElements()),
                })
                .ToList());

    private static List<string> Ids(ICollection<ElementId> ids) =>
        ids.OrderBy(id => id.Value).Select(id => id.ToString()).ToList();
}
