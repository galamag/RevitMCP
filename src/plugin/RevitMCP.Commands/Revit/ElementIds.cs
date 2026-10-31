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
    /// <exception cref="RequestFailedException">With <see cref="JsonRpcCodes.InvalidParams"/>, when the text is no element ID.</exception>
    public static ElementId Parse(string text, string method) =>
        ElementId.TryParse(text, out var id) && id.ToString() == text
            ? id
            : throw new RequestFailedException(JsonRpcCodes.InvalidParams, $"{method}: '{text}' is not an element id.");
}
