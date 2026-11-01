using System.Text.Json;

namespace RevitMCP.Commands;

/// <summary>The per-item report of one batch. A batch is one transaction: all of it lands, or none of it.</summary>
public sealed class BatchResult
{
    private static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web);

    private readonly List<ItemResult> _items = [];

    public IReadOnlyList<ItemResult> Items => _items;

    public void Add(ItemResult item)
    {
        ArgumentNullException.ThrowIfNull(item);

        _items.Add(item);
    }

    /// <summary>
    /// Builds the command result. When <paramref name="outcome"/> did not commit, every item reported as created or updated is
    /// reported as rolled back, without the ID and state of an element that no longer exists or no longer holds the change. All keys are
    /// always present, and they are camelCase.
    /// </summary>
    public JsonElement ToJson(OperationOutcome outcome)
    {
        ArgumentNullException.ThrowIfNull(outcome);

        var items = outcome.Committed
            ? _items
            : _items.ConvertAll(item => item.Status is ItemStatus.Created or ItemStatus.Updated
                ? item with { Status = ItemStatus.RolledBack, ElementId = null, Actual = null }
                : item);

        return JsonSerializer.SerializeToElement(
            new
            {
                committed = outcome.Committed,
                items,
                warnings = outcome.Warnings,
                errors = outcome.Errors,
                dialogs = outcome.Dialogs,
            },
            Options);
    }
}
