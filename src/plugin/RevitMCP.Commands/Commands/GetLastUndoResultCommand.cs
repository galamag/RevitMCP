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
    private const string Other = "other";
    private const string Unknown = "unknown";

    public string Method => MethodNames.GetLastUndoResult;

    public bool NeedsDocument => false;

    public JsonElement Execute(CommandContext context, JsonElement parameters)
    {
        var attempt = tracker.History.LastAttempt;

        // With another step gone, the ids of the one asked for still stand, and it is the ids of what went that matter.
        var gone = attempt?.Other ?? attempt?.Step;

        return JsonSerializer.SerializeToElement(
            new
            {
                state = Describe(attempt),
                undoId = attempt?.Id,
                transactionName = attempt?.Step.Name,
                createdIds = gone?.CreatedIds ?? [],
                restoredIds = gone?.DeletedIds ?? [],
                documentTitle = attempt?.Step.DocumentTitle,
                otherName = attempt?.Other?.Name,
                otherDocumentTitle = attempt?.Other?.DocumentTitle,
            },
            ProjectSupport.Options);
    }

    private static string Describe(UndoAttempt? attempt) => attempt?.Outcome switch
    {
        null => None,
        UndoOutcome.Undone => Undone,
        UndoOutcome.Other => Other,
        UndoOutcome.Unknown => Unknown,
        _ => NotConfirmed,
    };
}
