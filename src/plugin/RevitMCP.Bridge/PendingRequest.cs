using System.Text.Json;

namespace RevitMCP.Bridge;

/// <summary>
/// One request travelling from a socket thread to the Revit main thread and back.
/// A request is created <see cref="RequestState.Queued"/>, may become <see cref="RequestState.Running"/>,
/// and ends in exactly one of <see cref="RequestState.Succeeded"/>, <see cref="RequestState.Failed"/> or
/// <see cref="RequestState.Cancelled"/>; the first terminal transition wins, and a running request can no longer be cancelled. Safe for concurrent use.
/// </summary>
public sealed class PendingRequest(string id, string method, JsonElement @params, DateTimeOffset enqueuedAt)
{
    private readonly object _gate = new();
    private readonly TaskCompletionSource<JsonElement> _completion =
        new(TaskCreationOptions.RunContinuationsAsynchronously);

    private RequestState _state = RequestState.Queued;
    private string? _cancelReason;

    public string Id { get; } = id;

    public string Method { get; } = method;

    public JsonElement Params { get; } = @params;

    public DateTimeOffset EnqueuedAt { get; } = enqueuedAt;

    /// <summary>
    /// Resolves with the result after <see cref="Complete"/>, faults with <see cref="RequestFailedException"/>
    /// after <see cref="Fail"/>, and is cancelled after <see cref="Cancel"/>.
    /// </summary>
    public Task<JsonElement> Completion => _completion.Task;

    public RequestState State
    {
        get
        {
            lock (_gate)
            {
                return _state;
            }
        }
    }

    /// <summary>Why the request was cancelled; <c>null</c> unless <see cref="State"/> is <see cref="RequestState.Cancelled"/>.</summary>
    public string? CancelReason
    {
        get
        {
            lock (_gate)
            {
                return _cancelReason;
            }
        }
    }

    /// <summary>True once the request has succeeded, failed or been cancelled.</summary>
    public bool IsFinished
    {
        get
        {
            lock (_gate)
            {
                return IsTerminal(_state);
            }
        }
    }

    /// <summary>Marks the request as succeeded. Returns <c>false</c> if it had already finished.</summary>
    public bool Complete(JsonElement result)
    {
        if (!TryFinish(RequestState.Succeeded, null, requireQueued: false))
        {
            return false;
        }

        _completion.TrySetResult(result);
        return true;
    }

    /// <summary>Marks the request as failed. Returns <c>false</c> if it had already finished.</summary>
    public bool Fail(int code, string message)
    {
        if (!TryFinish(RequestState.Failed, null, requireQueued: false))
        {
            return false;
        }

        _completion.TrySetException(new RequestFailedException(code, message));
        return true;
    }

    /// <summary>
    /// Marks the request as cancelled. Succeeds only while the request is <see cref="RequestState.Queued"/>:
    /// once it runs, Revit may already be changing the model, so the real result must be recorded instead.
    /// Returns <c>false</c> if the request is running or has finished.
    /// </summary>
    public bool Cancel(string reason)
    {
        if (!TryFinish(RequestState.Cancelled, reason, requireQueued: true))
        {
            return false;
        }

        _completion.TrySetCanceled();
        return true;
    }

    /// <summary>Moves a queued request to running. Returns <c>false</c> if it is no longer queued.</summary>
    internal bool TryMarkRunning()
    {
        lock (_gate)
        {
            if (_state != RequestState.Queued)
            {
                return false;
            }

            _state = RequestState.Running;
            return true;
        }
    }

    private bool TryFinish(RequestState terminal, string? cancelReason, bool requireQueued)
    {
        lock (_gate)
        {
            if (IsTerminal(_state) || (requireQueued && _state != RequestState.Queued))
            {
                return false;
            }

            _state = terminal;
            _cancelReason = cancelReason;
            return true;
        }
    }

    private static bool IsTerminal(RequestState state) =>
        state is RequestState.Succeeded or RequestState.Failed or RequestState.Cancelled;
}
