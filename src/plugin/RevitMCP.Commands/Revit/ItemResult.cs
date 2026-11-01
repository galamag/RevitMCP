using System.Text.Json;

namespace RevitMCP.Commands;

/// <summary>The values of <see cref="ItemResult.Status"/>.</summary>
public static class ItemStatus
{
    public const string Created = "created";
    public const string Updated = "updated";
    public const string Unchanged = "unchanged";
    public const string AlreadyExisted = "already_existed";
    public const string Failed = "failed";
    public const string RolledBack = "rolled_back";
}

/// <summary>
/// The report on one requested item. <see cref="ElementId"/> is a string, like every ID in the contract. This file uses no Revit
/// type, so the test project compiles it in by a link.
/// </summary>
public sealed record ItemResult(
    int Index,
    string Status,
    string? ElementId,
    JsonElement? Requested,
    JsonElement? Actual,
    IReadOnlyList<string> Warnings,
    string? Error)
{
    /// <summary>
    /// The report of an item that was created and then found not to hold once the batch had committed: <see cref="ItemStatus.Failed"/>,
    /// with no element and no actual, and <paramref name="error"/> saying why. The rest of the batch has landed.
    /// </summary>
    public ItemResult FailedAfterCommit(string error) =>
        this with { Status = ItemStatus.Failed, ElementId = null, Actual = null, Error = error };
}
