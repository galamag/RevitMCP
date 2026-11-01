using System.Text.Json;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitMCP.Bridge;

namespace RevitMCP.Commands;

/// <summary>
/// What the commands that call Revit outside a transaction share. They change no model, so they do not use
/// <see cref="Operation"/>, and the dialogs it would report are theirs to read before the dialog guard drops them.
/// </summary>
internal static class ProjectSupport
{
    /// <summary>Gives a <see cref="DialogRecord"/> the camelCase keys of the contract.</summary>
    public static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web);

    /// <summary>
    /// Reads the required <c>name</c> parameter, or another text parameter named by <paramref name="key"/>, without judging
    /// it. The caller judges it: the project commands pass it to <see cref="TestFolder.Resolve"/> or
    /// <see cref="TestFolder.ResolveTemplate"/>, and <c>create_3d_view</c> checks it as a view name.
    /// </summary>
    public static string ReadName(JsonElement parameters, string method, string key = "name") =>
        parameters.TryGetProperty(key, out var name) && name.ValueKind == JsonValueKind.String
            ? name.GetString()!
            : throw new RequestFailedException(JsonRpcCodes.InvalidParams, $"{method} needs a text {key}.");

    /// <summary>
    /// Runs the Revit calls of a command and builds its result. <paramref name="describe"/> gets the dialogs, for the
    /// key <c>dialogs</c> in the shape of <see cref="OperationOutcome.Dialogs"/>. A dialog the guard refused is often
    /// why Revit failed, so a failure carries them in its message instead of losing them with the exception.
    /// A <see cref="RequestFailedException"/> from <paramref name="revitCalls"/> already says what happened and keeps its code.
    /// </summary>
    public static JsonElement Run(
        string method,
        Func<Document> revitCalls,
        Func<Document, IReadOnlyList<DialogRecord>, object> describe)
    {
        Document document;
        try
        {
            document = revitCalls();
        }
        catch (RequestFailedException e)
        {
            throw WithDialogs(e.Code, e.Message);
        }
        catch (Exception e)
        {
            Log.Error($"{method} failed.", e);
            throw WithDialogs(JsonRpcCodes.InternalError, $"{method} failed: {e.Message}");
        }

        return JsonSerializer.SerializeToElement(describe(document, TakeDialogs()), Options);
    }

    /// <summary>
    /// The document of what <c>OpenAndActivateDocument</c> returned. Live Revit returns null, and does not throw, when the
    /// dialog guard refused a dialog of the open, such as the wait for a file another process holds. That is a failed
    /// open, and the refused dialogs, which <see cref="Run"/> adds, say why.
    /// </summary>
    public static Document OpenedDocument(UIDocument? opened) =>
        opened?.Document
        ?? throw new RequestFailedException(
            JsonRpcCodes.InternalError,
            "Revit did not open the file, so it is not open and the active project did not change.");

    private static RequestFailedException WithDialogs(int code, string message)
    {
        var dialogs = TakeDialogs();
        var refused = string.Join("; ", dialogs.Select(dialog => $"{dialog.DialogId}: {dialog.Message}"));

        return new RequestFailedException(
            code,
            dialogs.Count == 0 ? message : $"{message} Revit raised dialogs, and they were refused: {refused}");
    }

    private static IReadOnlyList<DialogRecord> TakeDialogs() => DialogGuard.Active?.TakeRecorded() ?? [];
}
