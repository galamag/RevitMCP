namespace RevitMCP.Bridge;

/// <summary>
/// Remembers requests by ID so a result can be fetched after the request left the queue.
/// Holds at most <c>capacity</c> requests and makes room only by dropping the oldest finished one,
/// so a queued or running request is never lost. Safe for concurrent use.
/// </summary>
public sealed class RequestStore
{
    private readonly object _gate = new();
    private readonly int _capacity;
    private readonly Dictionary<string, LinkedListNode<PendingRequest>> _byId = new(StringComparer.Ordinal);
    private readonly LinkedList<PendingRequest> _insertionOrder = new();

    public RequestStore(int capacity)
    {
        ArgumentOutOfRangeException.ThrowIfLessThan(capacity, 1);
        _capacity = capacity;
    }

    /// <summary>
    /// Adds a request. Returns <c>false</c> when the ID is already stored (use <see cref="Find"/> to get the
    /// existing request) or when the store is full of unfinished requests and nothing can be evicted.
    /// </summary>
    public bool TryAdd(PendingRequest request)
    {
        ArgumentNullException.ThrowIfNull(request);

        lock (_gate)
        {
            if (_byId.ContainsKey(request.Id))
            {
                return false;
            }

            if (_byId.Count >= _capacity && !TryEvictOldestFinished())
            {
                return false;
            }

            _byId.Add(request.Id, _insertionOrder.AddLast(request));
            return true;
        }
    }

    /// <summary>Returns the stored request with this ID, or <c>null</c>.</summary>
    public PendingRequest? Find(string id)
    {
        ArgumentNullException.ThrowIfNull(id);

        lock (_gate)
        {
            return _byId.TryGetValue(id, out var node) ? node.Value : null;
        }
    }

    /// <summary>Returns the state of the stored request, or <see cref="RequestState.Unknown"/> for an ID not held.</summary>
    public RequestState GetState(string id) => Find(id)?.State ?? RequestState.Unknown;

    private bool TryEvictOldestFinished()
    {
        for (var node = _insertionOrder.First; node is not null; node = node.Next)
        {
            if (node.Value.IsFinished)
            {
                _byId.Remove(node.Value.Id);
                _insertionOrder.Remove(node);
                return true;
            }
        }

        return false;
    }
}
