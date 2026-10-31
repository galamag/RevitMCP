using System.Diagnostics.CodeAnalysis;
using Autodesk.Revit.DB;

namespace RevitMCP.Commands;

/// <summary>
/// How one transaction ended. When <see cref="Committed"/> is false, <see cref="Errors"/> says why.
/// <see cref="Warnings"/> stay listed either way.
/// </summary>
public sealed record OperationOutcome(
    bool Committed,
    IReadOnlyList<string> Warnings,
    IReadOnlyList<string> Errors,
    IReadOnlyList<DialogRecord> Dialogs);

/// <summary>What the body of an <see cref="Operation"/> gets to steer it.</summary>
public sealed class OperationScope
{
    internal string? AbortReason { get; private set; }

    /// <summary>
    /// Leaves the body by throwing and rolls the transaction back, with <paramref name="reason"/> in the errors.
    /// The rollback holds even if the body catches the exception.
    /// </summary>
    [DoesNotReturn]
    public void Abort(string reason)
    {
        ArgumentException.ThrowIfNullOrEmpty(reason);

        AbortReason = reason;
        throw new OperationAbortedException(reason);
    }
}

/// <summary>Carries <see cref="OperationScope.Abort"/> out of the body. Nothing outside <see cref="Operation"/> sees it.</summary>
internal sealed class OperationAbortedException(string reason) : Exception(reason);

/// <summary>
/// Runs one model change as one transaction, named <c>MCP: name</c>, so that it is one Undo step. Every way a body can
/// fail ends in the outcome, and the transaction is never left open.
/// </summary>
public static class Operation
{
    public static OperationOutcome Run(Document doc, string name, Action<OperationScope> body)
    {
        ArgumentNullException.ThrowIfNull(doc);
        ArgumentException.ThrowIfNullOrEmpty(name);
        ArgumentNullException.ThrowIfNull(body);

        var failures = new FailureCollector();
        var problems = new List<string>();
        var committed = false;

        using (var transaction = new Transaction(doc, $"MCP: {name}"))
        {
            try
            {
                committed = Execute(transaction, failures, body, problems);
            }
            catch (Exception e)
            {
                Log.Error($"Operation '{name}' failed.", e);
                problems.Add(e.Message);
            }

            RollBackIfOpen(transaction, name, problems);
        }

        return new OperationOutcome(
            committed,
            failures.Warnings,
            [.. failures.Errors, .. problems],
            DialogGuard.Active?.TakeRecorded() ?? []);
    }

    private static bool Execute(
        Transaction transaction,
        FailureCollector failures,
        Action<OperationScope> body,
        List<string> problems)
    {
        var status = transaction.Start();
        if (status != TransactionStatus.Started)
        {
            problems.Add($"Revit did not start the transaction: {status}.");
            return false;
        }

        // After Start, which resets the options to their defaults.
        var options = transaction.GetFailureHandlingOptions();
        options.SetFailuresPreprocessor(failures);
        options.SetClearAfterRollback(true);
        transaction.SetFailureHandlingOptions(options);

        var scope = new OperationScope();
        try
        {
            body(scope);
        }
        catch (OperationAbortedException)
        {
            // The reason is read from the scope below, which also covers a body that caught this itself.
        }

        if (scope.AbortReason is { } reason)
        {
            problems.Add(reason);
            return false;
        }

        return Commit(transaction, failures, problems);
    }

    private static bool Commit(Transaction transaction, FailureCollector failures, List<string> problems)
    {
        var status = transaction.Commit();
        if (status == TransactionStatus.Committed)
        {
            return true;
        }

        if (status == TransactionStatus.Pending)
        {
            problems.Add("Revit left the transaction pending: its failure handling waits for a user in a dialog.");
        }
        else if (failures.Errors.Count == 0)
        {
            problems.Add($"Revit ended the transaction as {status} without reporting a failure.");
        }

        return false;
    }

    /// <summary>
    /// Ends a transaction that the body or a failed commit left behind. Rolling back is what disposal would do too,
    /// but Revit advises against relying on it, and only this reports the case where it does not work.
    /// </summary>
    private static void RollBackIfOpen(Transaction transaction, string name, List<string> problems)
    {
        try
        {
            if (transaction.GetStatus() is TransactionStatus.Started or TransactionStatus.Pending
                && transaction.RollBack() != TransactionStatus.RolledBack)
            {
                problems.Add($"Revit did not roll the transaction back: {transaction.GetStatus()}.");
            }
        }
        catch (Exception e)
        {
            Log.Error($"Could not roll back operation '{name}'.", e);
            problems.Add($"Could not roll the transaction back: {e.Message}");
        }
    }
}
