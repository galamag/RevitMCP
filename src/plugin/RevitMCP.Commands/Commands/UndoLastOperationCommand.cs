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
            throw new RequestFailedException(JsonRpcCodes.InvalidParams, $"{Refused}: {Explain(decision, active.Title)}");
        }

        var undo = RevitCommandId.LookupPostableCommandId(PostableCommand.Undo)
            ?? throw new RequestFailedException(JsonRpcCodes.InternalError, $"{Method}: Revit names no Undo command, so nothing was posted.");

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

    private static string Explain(UndoDecision decision, string activeTitle) => decision switch
    {
        { Verdict: UndoVerdict.Unconfirmed, Step: { } step } =>
            $"an earlier undo of '{step.Name}' in '{step.DocumentTitle}' is still unconfirmed, and two must not overlap. Nothing was undone by this call. "
            + "Ask get_last_undo_result what became of it. If it stays not_confirmed, undo is possible again one minute after that undo was posted.",
        { Verdict: UndoVerdict.OtherDocument, Step: { } step } =>
            $"the last operation of these tools, '{step.Name}', lies in '{step.DocumentTitle}', and the active project is '{activeTitle}'. Undo acts on the active project only. "
            + "Nothing was undone. Use open_project to make that project active first.",
        { Verdict: UndoVerdict.NotOurs, Step: { } step } =>
            $"the last change in '{step.DocumentTitle}' is '{step.Name}', which did not come from these tools, and Undo would take that. Nothing was undone. "
            + "Only the user can undo that, in Revit, so ask them to and then try again.",
        _ => $"there is nothing to undo in '{activeTitle}': no operation of these tools is in its history. A project opened or created in this Revit session starts with an empty history.",
    };
}
