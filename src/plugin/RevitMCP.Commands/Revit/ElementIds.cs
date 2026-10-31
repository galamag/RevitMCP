using System.Diagnostics.CodeAnalysis;
using System.Text.Json;
using Autodesk.Revit.DB;
using RevitMCP.Bridge;

namespace RevitMCP.Commands;

/// <summary>
/// Reads the IDs of the contract, which are strings. A well-formed ID says nothing about whether the element exists.
/// Live Revit: <see cref="ElementId.TryParse"/> also takes <c>" 5"</c> and <c>"+5"</c>, which no tool ever returned, so
/// only the text an ID prints as is accepted.
/// </summary>
internal static class ElementIds
{
    /// <summary>The most IDs one call takes, which <c>registry.ts</c> states too.</summary>
    private const int MaxListed = 1000;

    public static bool TryParse(string text, [NotNullWhen(true)] out ElementId? id) =>
        ElementId.TryParse(text, out id) && id.ToString() == text;

    /// <exception cref="RequestFailedException">With <see cref="JsonRpcCodes.InvalidParams"/>, when the text is no element ID.</exception>
    public static ElementId Parse(string text, string method) =>
        TryParse(text, out var id)
            ? id
            : throw new RequestFailedException(JsonRpcCodes.InvalidParams, $"{method}: '{text}' is not an element id.");

    /// <summary>
    /// Reads the list <c>ids</c> of a call. All of it is read before Revit is asked anything, and an ID asked twice counts
    /// once. The text comes along, as a caller may report it back.
    /// </summary>
    /// <exception cref="RequestFailedException">With <see cref="JsonRpcCodes.InvalidParams"/>, for anything but 1 to 1000 IDs.</exception>
    public static List<(string Text, ElementId Id)> ReadList(JsonElement parameters, string method)
    {
        if (!parameters.TryGetProperty("ids", out var ids) || ids.ValueKind != JsonValueKind.Array || ids.GetArrayLength() == 0)
        {
            throw new RequestFailedException(JsonRpcCodes.InvalidParams, $"{method} needs a list of ids in ids.");
        }

        if (ids.GetArrayLength() > MaxListed)
        {
            throw new RequestFailedException(
                JsonRpcCodes.InvalidParams,
                $"{method} takes at most {MaxListed} ids in one call, and got {ids.GetArrayLength()}. Split the list.");
        }

        return ids.EnumerateArray()
            .Select(id => id.ValueKind == JsonValueKind.String
                ? id.GetString()!
                : throw new RequestFailedException(JsonRpcCodes.InvalidParams, $"{method}: ids are strings, and {id.GetRawText()} is not one."))
            .Select(text => (Text: text, Id: Parse(text, method)))
            .DistinctBy(entry => entry.Id.Value)
            .ToList();
    }
}
