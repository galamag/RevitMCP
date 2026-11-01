using System.Text.Json;
using Autodesk.Revit.DB;
using Autodesk.Revit.Exceptions;
using RevitMCP.Bridge;

namespace RevitMCP.Commands;

/// <summary>
/// One checked item of a batch. <paramref name="Settled"/> is the report of an item that needs no change in the model.
/// </summary>
internal sealed record BatchEntry<T>(int Index, JsonElement Requested, T Input, ItemResult? Settled = null);

/// <summary>
/// Runs a checked list of items as one <see cref="Operation"/>, so as one Undo step: all of it lands, or none of it.
/// Input is checked before this, because a refusal from inside the transaction would lose its code. Revit can still
/// fail an item, and then the batch stops there: that item is <see cref="ItemStatus.Failed"/>, the ones before it
/// come out as <see cref="ItemStatus.RolledBack"/>, and so do the ones after it, with an error saying they were not
/// attempted. What Revit refuses only at commit belongs to no item, so it is in the errors of the result.
/// </summary>
internal static class ItemBatch
{
    private const string NotAttempted = "Not attempted: the batch stopped before this item, and nothing landed.";

    /// <summary>The most items one call takes, which <c>registry.ts</c> states too.</summary>
    private const int MaxItems = 500;

    /// <summary>Takes the items of a call, in order. Every item is an object, so <see cref="ItemReader"/> can read it.</summary>
    public static List<JsonElement> ReadItems(JsonElement parameters, string method)
    {
        if (!parameters.TryGetProperty("items", out var items) || items.ValueKind != JsonValueKind.Array || items.GetArrayLength() == 0)
        {
            throw new RequestFailedException(JsonRpcCodes.InvalidParams, $"{method} needs a list of items in items.");
        }

        if (items.GetArrayLength() > MaxItems)
        {
            throw new RequestFailedException(
                JsonRpcCodes.InvalidParams,
                $"{method} takes at most {MaxItems} items in one call, and got {items.GetArrayLength()}. Split the list.");
        }

        return items.EnumerateArray()
            .Select((item, index) => item.ValueKind == JsonValueKind.Object
                ? item
                : throw new RequestFailedException(JsonRpcCodes.InvalidParams, $"{method} item {index}: an item is an object, not {item.GetRawText()}."))
            .ToList();
    }

    /// <summary>
    /// Creates each entry with <paramref name="create"/>. <paramref name="readBack"/> gets each new element after the
    /// commit, when Revit has finished with it, so that <c>actual</c> holds what the model holds. With nothing to create
    /// no transaction opens, as it would be an empty Undo step. <paramref name="warningsOf"/>, when given, gets each new
    /// element at the same time and returns what to warn about that item: a created item has no other way to carry a warning.
    /// <paramref name="problemAfterCommit"/>, when given, gets each new element after the commit too, and returns why it does not hold, or
    /// <c>null</c> when it does: for an element that Revit can leave in the model in a state the in-transaction check did not see.
    /// <paramref name="landedStatus"/> is the status of an item that landed: <see cref="ItemStatus.Created"/>, or <see cref="ItemStatus.Updated"/>
    /// for a batch that changes elements that exist, where "created" would be untrue. Its elements are then the ones that were changed.
    /// </summary>
    public static JsonElement Run<T>(
        Document document,
        string method,
        IReadOnlyList<BatchEntry<T>> entries,
        Func<T, Element> create,
        Func<Element, object> readBack,
        Func<Element, IReadOnlyList<string>>? warningsOf = null,
        Func<Element, string?>? problemAfterCommit = null,
        string landedStatus = ItemStatus.Created) =>
        RunMany(document, method, entries, input => [create(input)], readBack, warningsOf, problemAfterCommit, landedStatus);

    /// <summary>
    /// <see cref="Run{T}"/> for an item that makes several elements, such as the railings of a stairs. The first element is the one
    /// the item reports: its ID is the <see cref="ItemResult.ElementId"/> and <paramref name="readBack"/> gets it. Each of the others
    /// must be in the model after the commit too, or the item fails there, as one that Revit removed.
    /// </summary>
    public static JsonElement RunMany<T>(
        Document document,
        string method,
        IReadOnlyList<BatchEntry<T>> entries,
        Func<T, IReadOnlyList<Element>> create,
        Func<Element, object> readBack,
        Func<Element, IReadOnlyList<string>>? warningsOf = null,
        Func<Element, string?>? problemAfterCommit = null,
        string landedStatus = ItemStatus.Created)
    {
        var results = entries.Select(entry => entry.Settled).ToArray();
        var alsoCreated = new Dictionary<int, IReadOnlyList<ElementId>>();
        var outcome = results.All(result => result is not null)
            ? new OperationOutcome(true, [], [], [])
            : Operation.Run(document, method, scope => CreateAll(document, entries, results, create, alsoCreated, method, landedStatus, scope));

        if (outcome.Committed)
        {
            ReadBackAll(document, results, readBack, warningsOf, method, alsoCreated, problemAfterCommit, landedStatus);
        }

        var batch = new BatchResult();
        foreach (var (entry, result) in entries.Zip(results))
        {
            batch.Add(result ?? new ItemResult(entry.Index, ItemStatus.RolledBack, null, entry.Requested, null, [], NotAttempted));
        }

        return batch.ToJson(outcome);
    }

    /// <summary>
    /// Regenerates after each item. Live Revit: a wall too low to build fails only in regeneration, with the severity
    /// DocumentCorruption, which rolls the transaction back without reaching <see cref="FailureCollector"/>. At commit
    /// that leaves no reason and no item to blame, while here it is an exception on the very item.
    /// </summary>
    private static void CreateAll<T>(
        Document document,
        IReadOnlyList<BatchEntry<T>> entries,
        ItemResult?[] results,
        Func<T, IReadOnlyList<Element>> create,
        Dictionary<int, IReadOnlyList<ElementId>> alsoCreated,
        string method,
        string landedStatus,
        OperationScope scope)
    {
        foreach (var (entry, position) in entries.Select((entry, position) => (entry, position)))
        {
            if (entry.Settled is not null)
            {
                continue;
            }

            try
            {
                var elements = create(entry.Input);

                if (elements.Count == 0)
                {
                    throw new System.InvalidOperationException("Revit made no element for this item.");
                }

                document.Regenerate();
                results[position] = new ItemResult(entry.Index, landedStatus, elements[0].Id.ToString(), entry.Requested, null, [], null);

                if (elements.Count > 1)
                {
                    alsoCreated[position] = elements.Skip(1).Select(element => element.Id).ToList();
                }
            }
            catch (RegenerationFailedException e)
            {
                // Revit's own text is only "Failed to regenerate.", so say what that means for this item.
                Fail(entry.Index, $"Revit could not build this element and gave no reason: {e.Message}", e);
            }
            catch (Exception e)
            {
                Fail(entry.Index, e.Message, e);
            }

            void Fail(int index, string message, Exception e)
            {
                Log.Error($"{method} item {index} failed.", e);
                results[position] = new ItemResult(index, ItemStatus.Failed, null, entry.Requested, null, [], message);
                scope.Abort($"Item {index} failed, so nothing landed: {message}");
            }
        }
    }

    /// <summary>
    /// The batch has landed by now, so a failure here must not read as a failed call. <paramref name="alsoCreated"/>, when given, holds
    /// by position the further elements of an item that made several, and one of them that is gone fails the item.
    /// <paramref name="problemAfterCommit"/>, when given, also fails the item that it gives a reason for: the element is still in the model,
    /// so the error names it, and the rest of the batch has landed. Only the items whose status is <paramref name="landedStatus"/> are read back:
    /// the others were settled with no change and carry their report already.
    /// </summary>
    public static void ReadBackAll(
        Document document,
        ItemResult?[] results,
        Func<Element, object> readBack,
        Func<Element, IReadOnlyList<string>>? warningsOf,
        string method,
        IReadOnlyDictionary<int, IReadOnlyList<ElementId>>? alsoCreated = null,
        Func<Element, string?>? problemAfterCommit = null,
        string landedStatus = ItemStatus.Created)
    {
        for (var position = 0; position < results.Length; position++)
        {
            if (results[position] is not { ElementId: { } id } created || created.Status != landedStatus)
            {
                continue;
            }

            try
            {
                var element = document.GetElement(ElementIds.Parse(id, method));

                if (element is null)
                {
                    // Revit removed it while committing, so it is not in the model and must not read as created.
                    Log.Error($"{method} element {id} is gone after the commit.");
                    results[position] = created.FailedAfterCommit(
                        $"Revit removed this element when it committed the batch ({(landedStatus == ItemStatus.Created ? $"it was created as {id}" : $"element {id} was changed")} and is gone). The rest of the batch landed.");
                    continue;
                }

                if (alsoCreated is not null && alsoCreated.TryGetValue(position, out var others) && others.FirstOrDefault(other => document.GetElement(other) is null) is { } gone)
                {
                    Log.Error($"{method} element {gone} is gone after the commit.");
                    results[position] = created.FailedAfterCommit(
                        $"Revit removed element {gone} of this item when it committed the batch, so the item did not land whole. It made {id}, {string.Join(", ", others)}, and {gone} is gone. The rest of the batch landed.");
                    continue;
                }

                if (problemAfterCommit?.Invoke(element) is { } problem)
                {
                    // The element is in the model, so it is not "gone": the error names it, as the caller has no other way to find it.
                    Log.Error($"{method} element {id} does not hold after the commit: {problem}");
                    results[position] = created.FailedAfterCommit($"{problem} It is element {id}, and it is still in the model. The rest of the batch landed.");
                    continue;
                }

                results[position] = created with
                {
                    Actual = JsonSerializer.SerializeToElement(readBack(element), ProjectSupport.Options),
                    Warnings = warningsOf?.Invoke(element) ?? created.Warnings,
                };
            }
            catch (Exception e)
            {
                Log.Error($"{method} could not read back element {id}.", e);
                results[position] = created with { Warnings = [$"Created, but it could not be read back: {e.Message}"] };
            }
        }
    }
}
