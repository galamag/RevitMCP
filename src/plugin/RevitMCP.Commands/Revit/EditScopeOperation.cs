using Autodesk.Revit.DB;

namespace RevitMCP.Commands;

/// <summary>
/// Builds one new stairs in a <see cref="StairsEditScope"/>, so that it is one Undo step, named <c>MCP: name</c> like the
/// step of an <see cref="Operation"/>. A scope cannot start inside a transaction, so <see cref="Operation.Run"/> cannot hold
/// it: here the scope holds an operation, which brings the failure handling and the status check of the transaction inside.
/// The edit mode must not outlive the call, because external events do not run in it and only a person can end one that has
/// lost its scope, so every way out commits the scope or cancels it. Live Revit (probe, step 3): cancelling is safe after a
/// failure before the transaction, inside it and after it, and disposing the scope does the same.
/// Check the input before calling this, as with <see cref="Operation.Run"/>. All else that can go wrong must be found by the
/// body, inside the scope, because what Revit does with an error when the scope commits is not known: no safe way to raise one
/// was found. Callers must read <see cref="OperationOutcome.Committed"/>, which comes from the model, as committing a scope
/// returns nothing and can drop what it held in silence.
/// </summary>
public static class EditScopeOperation
{
    public static OperationOutcome Run(Document doc, string name, ElementId baseLevelId, ElementId topLevelId, Action<OperationScope, ElementId> body)
    {
        ArgumentNullException.ThrowIfNull(doc);
        ArgumentException.ThrowIfNullOrEmpty(name);
        ArgumentNullException.ThrowIfNull(baseLevelId);
        ArgumentNullException.ThrowIfNull(topLevelId);
        ArgumentNullException.ThrowIfNull(body);

        // A dialog in edit mode that nobody closes holds up everything, the end of the scope included.
        if (DialogGuard.Active is not { } guard)
        {
            return new OperationOutcome(false, [], ["No dialog guard is active, so the edit mode was not started."], []);
        }

        var scopeName = $"MCP: {name}";
        var closing = new ClosingFailures();
        var problems = new List<string>();
        var stairsId = ElementId.InvalidElementId;
        OperationOutcome? inner = null;
        var landed = false;

        // Around the whole scope, so that the history sees its last commit and the rollback of its disposal as part of it.
        using (UndoTracker.Attached?.MarkScope(doc, scopeName))
        {
            try
            {
                using var scope = new StairsEditScope(doc, scopeName);

                try
                {
                    if (scope.IsPermitted)
                    {
                        stairsId = scope.Start(baseLevelId, topLevelId);
                        inner = Operation.Run(doc, $"{name} inner", operation => body(operation, stairsId));

                        if (inner.Committed)
                        {
                            scope.Commit(closing);
                            landed = HoldsStairs(doc, stairsId, problems);
                        }
                    }
                    else
                    {
                        problems.Add("Revit does not permit an edit mode now: the document is read-only or being modified, or another edit mode is active.");
                    }
                }
                catch (Exception e)
                {
                    Log.Error($"Edit scope '{name}' failed.", e);
                    problems.Add(e.Message);
                }

                CancelIfActive(scope, name, problems);
            }
            catch (Exception e)
            {
                Log.Error($"Edit scope '{name}' could not be opened or closed.", e);
                problems.Add(e.Message);
            }
        }

        if (!landed && stairsId != ElementId.InvalidElementId && doc.GetElement(stairsId) is not null)
        {
            Log.Error($"Edit scope '{name}' failed, and stairs {stairsId} is still in the model.");
            problems.Add($"Stairs {stairsId} is still in the model after this failure, so do not take it as rolled back: read the model, and ask the user to look at Revit, which may be left in edit mode.");
        }

        return new OperationOutcome(
            landed,
            [.. inner?.Warnings ?? [], .. closing.Warnings],
            [.. inner?.Errors ?? [], .. closing.Errors, .. problems],
            [.. inner?.Dialogs ?? [], .. guard.TakeRecorded()]);
    }

    /// <summary>Live Revit: a scope that ends with nothing to keep raises nothing and leaves no stairs.</summary>
    private static bool HoldsStairs(Document doc, ElementId stairsId, List<string> problems)
    {
        if (doc.GetElement(stairsId) is not null)
        {
            return true;
        }

        problems.Add($"Revit dropped stairs {stairsId} when its edit mode closed and did not say why, so nothing landed.");
        return false;
    }

    /// <summary>Ends an edit mode that a failure left open. Disposing the scope would do the same, but only this reports what went wrong.</summary>
    private static void CancelIfActive(StairsEditScope scope, string name, List<string> problems)
    {
        try
        {
            if (scope.IsActive)
            {
                scope.Cancel();
            }
        }
        catch (Exception e)
        {
            Log.Error($"Could not cancel edit scope '{name}'.", e);
            problems.Add($"Could not cancel the edit mode: {e.Message}");
        }
    }

    /// <summary>
    /// Takes over the failures of the end of a scope, so that none reaches the user: warnings are recorded and deleted, and
    /// errors are recorded and left to Revit. This is no <see cref="FailureCollector"/>, as it must never answer
    /// <see cref="FailureProcessingResult.ProceedWithRollBack"/>. Live Revit (probe, step 3): that answer here throws
    /// <c>InternalException</c>, opens a dialog after the command has ended, and leaves an edit mode with no scope, which
    /// stopped the bridge until a person pressed Cancel Edit Mode.
    /// </summary>
    private sealed class ClosingFailures : IFailuresPreprocessor
    {
        private readonly List<string> _warnings = [];
        private readonly List<string> _errors = [];

        public IReadOnlyList<string> Warnings => _warnings;

        public IReadOnlyList<string> Errors => _errors;

        public FailureProcessingResult PreprocessFailures(FailuresAccessor failuresAccessor)
        {
            foreach (var failure in failuresAccessor.GetFailureMessages())
            {
                if (failure.GetSeverity() == FailureSeverity.Warning)
                {
                    _warnings.Add(failure.GetDescriptionText());
                    failuresAccessor.DeleteWarning(failure);
                }
                else
                {
                    _errors.Add(failure.GetDescriptionText());
                }
            }

            return FailureProcessingResult.Continue;
        }
    }
}
