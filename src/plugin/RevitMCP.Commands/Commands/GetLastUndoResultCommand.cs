using System.Text.Json;
using RevitMCP.Bridge;
using RevitMCP.Commands.Dispatch;

namespace RevitMCP.Commands;

/// <summary>
/// Says what became of the last posted Undo. It goes through the queue and not through the socket thread on purpose:
/// live Revit runs a parked posted command ahead of the next external event, so this request is what lets the Undo run,
/// and by the time it runs here the event of that Undo has arrived. No Revit call, so it needs no document.
/// </summary>
public sealed class GetLastUndoResultCommand(UndoTracker tracker) : ICommand
{
    private const string None = "none";
    private const string Undone = "undone";
    private const string NotConfirmed = "not_confirmed";

    public string Method => MethodNames.GetLastUndoResult;

    public bool NeedsDocument => false;

    public JsonElement Execute(CommandContext context, JsonElement parameters)
    {
        var attempt = tracker.History.LastAttempt;

        return JsonSerializer.SerializeToElement(
            new
            {
                state = attempt is null ? None : attempt.Undone ? Undone : NotConfirmed,
                undoId = attempt?.Id,
                transactionName = attempt?.Step.Name,
                createdIds = attempt?.Step.CreatedIds ?? [],
                restoredIds = attempt?.Step.DeletedIds ?? [],
                documentTitle = attempt?.Step.DocumentTitle,
            },
            ProjectSupport.Options);
    }
}
