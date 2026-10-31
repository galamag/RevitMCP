using Autodesk.Revit.DB;
using RevitMCP.Bridge;

namespace RevitMCP.Commands;

/// <summary>Reads the IDs of the contract, which are strings. An ID string says nothing about whether the element exists.</summary>
internal static class ElementIds
{
    /// <exception cref="RequestFailedException">With <see cref="JsonRpcCodes.InvalidParams"/>, when the text is no element ID.</exception>
    public static ElementId Parse(string text, string method) =>
        ElementId.TryParse(text, out var id)
            ? id
            : throw new RequestFailedException(JsonRpcCodes.InvalidParams, $"{method}: '{text}' is not an element id.");
}
