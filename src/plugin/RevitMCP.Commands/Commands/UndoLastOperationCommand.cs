using System.Text.Json;
using Autodesk.Revit.UI;
using RevitMCP.Bridge;
using RevitMCP.Commands.Dispatch;

namespace RevitMCP.Commands;

/// <summary>
/// Posts Revit's own Undo, because the API has no other way to undo a committed transaction. A posted command runs only
/// after this returns, so the answer says what was posted and never that it happened: <c>get_last_undo_result</c>, which
/// the server sends next, says that. Everything that can be refused is refused before the post, by the copy of the
/// history in <see cref="UndoTracker"/>, as <c>CanPostCommand</c> tells nothing and Undo takes whatever is on top.
/// </summary>
public sealed class UndoLastOperationCommand(UndoTracker tracker) : ICommand
{
    /// <summary>The prefix of a refusal, as nothing was posted and the caller may need to act.</summary>
    private const string Refused = "undo_refused";

    public string Method => MethodNames.UndoLastOperation;

    public bool NeedsDocument => true;

    public JsonElement Execute(CommandContext context, JsonElement parameters)
    {
        var active = context.Document!;
        var decision = tracker.History.Decide(UndoTracker.KeyOf(active));
        if (decision is not { Verdict: UndoVerdict.Allowed, Step: { } step })
        {
            throw new RequestFailedException(JsonRpcCodes.InvalidParams, $"{Refused}: {decision.Explain(active.Title)}");
        }

        var undo = RevitCommandId.LookupPostableCommandId(PostableCommand.Undo)
            ?? throw new RequestFailedException(JsonRpcCodes.InternalError, $"{Method}: Revit names no Undo command, so nothing was posted.");

        // Why Revit now and then refuses a posted Undo is not known, and its journal cannot say. This line is what the next refusal gets compared with.
        Log.Info(
            $"Posting Undo: document '{Log.Clean(active.Title)}', active view '{Log.Clean(active.ActiveView?.Name ?? "none")}' ({active.ActiveView?.ViewType}), "
            + $"{context.UiApp.Application.Documents.Size} open documents, CanPostCommand {context.UiApp.CanPostCommand(undo)}, top step '{Log.Clean(step.Name)}'.");

        // Not recorded before this returns, so a post Revit refuses leaves no attempt to wait for.
        context.UiApp.PostCommand(undo);
        var attempt = tracker.History.Posted(step);

        return JsonSerializer.SerializeToElement(
            new
            {
                undoId = attempt.Id,
                transactionName = step.Name,
                createdIds = step.CreatedIds,
                restoredIds = step.DeletedIds,
                documentTitle = step.DocumentTitle,
            },
            ProjectSupport.Options);
    }
}
