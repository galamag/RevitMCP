using System.Text.Json;
using Autodesk.Revit.DB;
using RevitMCP.Bridge;
using RevitMCP.Commands.Dispatch;

namespace RevitMCP.Commands;

/// <summary>
/// Deletes elements as one transaction, or runs the same delete and rolls it back to show what it would take with it.
/// A dry run ends in <see cref="OperationScope.Abort"/> on purpose, so its uncommitted outcome is no failure, and this
/// command reads that outcome itself because it reports no items. A delete that did not land reports nothing as affected.
/// </summary>
public sealed class DeleteElementsCommand : ICommand
{
    /// <summary>The reason a dry run gives <see cref="OperationScope.Abort"/>. The caller never sees it as an error.</summary>
    private const string DryRunEnd = "A dry run rolls back.";

    public string Method => MethodNames.DeleteElements;

    public bool NeedsDocument => true;

    public JsonElement Execute(CommandContext context, JsonElement parameters)
    {
        var document = context.Document!;
        var ids = ReadIds(document, parameters);
        var dryRun = new ItemReader(parameters, Method).FlagOr("dryRun", true);

        ICollection<ElementId>? deleted = null;
        var outcome = Operation.Run(document, Method, scope =>
        {
            deleted = document.Delete(ids);

            if (dryRun)
            {
                scope.Abort(DryRunEnd);
            }
        });

        var errors = outcome.Errors.Where(error => error != DryRunEnd).ToList();
        var passed = dryRun ? deleted is not null && errors.Count == 0 : outcome.Committed;
        var allAffected = passed ? deleted!.Select(id => id.ToString()).ToList() : [];
        var requested = ids.Select(id => id.ToString()).ToList();

        return JsonSerializer.SerializeToElement(
            new
            {
                dryRun,
                committed = outcome.Committed,
                summary = Summarize(dryRun, passed, allAffected.Count),
                requested,
                allAffected,
                dependents = allAffected.Except(requested).ToList(),
                warnings = outcome.Warnings,
                errors,
                dialogs = outcome.Dialogs,
            },
            ProjectSupport.Options);
    }

    private static string Summarize(bool dryRun, bool passed, int count) => (dryRun, passed) switch
    {
        (true, true) => $"Dry run: nothing was deleted. Elements a real delete would take: {count}. Pass dryRun false to delete.",
        (true, false) => "Dry run: nothing was deleted, and Revit refused the delete, see errors. A real delete would be refused too.",
        (false, true) => $"Elements deleted: {count}, as one Undo step.",
        (false, false) => "Nothing was deleted: Revit rolled the delete back, see errors.",
    };

    /// <summary>
    /// All of it is read before the transaction opens, so a refusal keeps its code and nothing is half done. Revit would
    /// throw on the same cases, but only with one sentence about the whole list, while this names the ids. Live Revit:
    /// each id can pass here and the list still fail in <see cref="Document.Delete(ICollection{ElementId})"/>, as every
    /// wall type at once does, so that failure stays possible and lands in the errors of the outcome.
    /// </summary>
    private List<ElementId> ReadIds(Document document, JsonElement parameters)
    {
        var ids = ElementIds.ReadList(parameters, Method).Select(entry => entry.Id).ToList();

        var notFound = ids.Where(id => document.GetElement(id) is null).ToList();
        if (notFound.Count > 0)
        {
            throw new RequestFailedException(
                JsonRpcCodes.InvalidParams,
                $"{Method}: no element has the id {string.Join(", ", notFound)}, so nothing was deleted. They may be gone already: read them with get_elements.");
        }

        var undeletable = ids.Where(id => !DocumentValidation.CanDeleteElement(document, id)).ToList();
        if (undeletable.Count > 0)
        {
            throw new RequestFailedException(
                JsonRpcCodes.InvalidParams,
                $"{Method}: Revit cannot delete {string.Join(", ", undeletable)}, so nothing was deleted. It refuses this for the view open in its window, for the level of that view, and for its own internal elements.");
        }

        return ids;
    }
}
