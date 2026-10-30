namespace RevitMCP.Bridge;

/// <summary>
/// First-in first-out queue between the socket threads (producers) and the Revit main thread (consumer).
/// A request that waited longer than <see cref="Limits.QueueTtl"/> is cancelled instead of being served.
/// Requests cancelled while queued are dropped. Safe for concurrent use.
/// </summary>
public sealed class RequestQueue(TimeProvider clock)
{
    private readonly object _gate = new();
    private readonly TimeProvider _clock = clock ?? throw new ArgumentNullException(nameof(clock));
    private readonly LinkedList<PendingRequest> _items = new();

    /// <summary>Adds a request to the back of the queue.</summary>
    public void Enqueue(PendingRequest request)
    {
        ArgumentNullException.ThrowIfNull(request);

        lock (_gate)
        {
            _items.AddLast(request);
        }
    }

    /// <summary>
    /// Takes the oldest still-valid request and marks it <see cref="RequestState.Running"/>.
    /// Expired requests met on the way are cancelled with a reason containing "expired".
    /// Returns <c>null</c> when nothing is left to serve.
    /// </summary>
    public PendingRequest? TryDequeue()
    {
        lock (_gate)
        {
            ExpireStaleLocked();
            while (_items.First is { } node)
            {
                _items.RemoveFirst();

                // Fails when the request was cancelled directly while it waited; skip it then.
                if (node.Value.TryMarkRunning())
                {
                    return node.Value;
                }
            }

            return null;
        }
    }

    /// <summary>
    /// Cancels every queued request that waited longer than <see cref="Limits.QueueTtl"/> (reason contains
    /// "expired") and removes it from the queue. Returns how many requests were expired. Needs no dequeue,
    /// so it can run on a timer while the consumer is busy or blocked.
    /// </summary>
    public int ExpireStale()
    {
        lock (_gate)
        {
            return ExpireStaleLocked();
        }
    }

    /// <summary>Cancels a request that is still queued. Returns <c>false</c> if it is unknown, running or finished.</summary>
    public bool TryCancel(string id)
    {
        ArgumentNullException.ThrowIfNull(id);

        lock (_gate)
        {
            ExpireStaleLocked();
            for (var node = _items.First; node is not null; node = node.Next)
            {
                if (node.Value.Id != id)
                {
                    continue;
                }

                _items.Remove(node);
                return node.Value.Cancel("The request was cancelled while it waited in the queue.");
            }

            return false;
        }
    }

    /// <summary>Number of requests still waiting to be served.</summary>
    public int Count
    {
        get
        {
            lock (_gate)
            {
                ExpireStaleLocked();
                return _items.Count;
            }
        }
    }

    /// <summary>How long the oldest waiting request has been queued, in seconds; 0 when the queue is empty.</summary>
    public double OldestQueuedSeconds
    {
        get
        {
            lock (_gate)
            {
                ExpireStaleLocked();
                return _items.First is { } node
                    ? (_clock.GetUtcNow() - node.Value.EnqueuedAt).TotalSeconds
                    : 0;
            }
        }
    }

    /// <summary>
    /// Cancels queued requests older than the TTL and drops requests that finished (for example cancelled by
    /// their client) while they waited. Must be called with <c>_gate</c> held.
    /// </summary>
    private int ExpireStaleLocked()
    {
        var now = _clock.GetUtcNow();
        var expired = 0;
        for (var node = _items.First; node is not null;)
        {
            var next = node.Next;
            var request = node.Value;
            if (request.State != RequestState.Queued)
            {
                _items.Remove(node);
            }
            else if (now - request.EnqueuedAt > Limits.QueueTtl)
            {
                _items.Remove(node);
                if (request.Cancel($"The request expired after waiting more than {Limits.QueueTtl.TotalSeconds:0} s in the queue."))
                {
                    expired++;
                }
            }

            node = next;
        }

        return expired;
    }
}
