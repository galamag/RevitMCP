using System.Text.Json;
using Autodesk.Revit.DB;
using RevitMCP.Bridge;

namespace RevitMCP.Commands;

/// <summary>
/// What the project commands share. They change no model, so they do not use <see cref="Operation"/>, and the dialogs
/// it would report are theirs to read before the dialog guard drops them.
/// </summary>
internal static class ProjectSupport
{
    private static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web);

    /// <summary>Reads the required <c>name</c> parameter, without judging it: <see cref="TestFolder.Resolve"/> does.</summary>
    public static string ReadName(JsonElement parameters, string method) =>
        parameters.TryGetProperty("name", out var name) && name.ValueKind == JsonValueKind.String
            ? name.GetString()!
            : throw new RequestFailedException(JsonRpcCodes.InvalidParams, $"{method} needs a text name.");

    /// <summary>
    /// Runs the Revit calls of a command and builds its result. <paramref name="describe"/> gets the dialogs, for the
    /// key <c>dialogs</c> in the shape of <see cref="OperationOutcome.Dialogs"/>. A dialog the guard refused is often
    /// why Revit failed, so a failure carries them in its message instead of losing them with the exception.
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
        catch (Exception e)
        {
            var dialogs = TakeDialogs();
            if (dialogs.Count == 0)
            {
                throw;
            }

            Log.Error($"{method} failed after Revit raised dialogs.", e);

            var refused = string.Join("; ", dialogs.Select(dialog => $"{dialog.DialogId}: {dialog.Message}"));
            throw new RequestFailedException(
                JsonRpcCodes.InternalError,
                $"{method} failed: {e.Message} Revit raised dialogs, and they were refused: {refused}");
        }

        return JsonSerializer.SerializeToElement(describe(document, TakeDialogs()), Options);
    }

    private static IReadOnlyList<DialogRecord> TakeDialogs() => DialogGuard.Active?.TakeRecorded() ?? [];
}
