using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace RevitMCP.Bridge;

/// <summary>What became of asking the host to serve the queue on its main thread.</summary>
public enum SignalResult
{
    Accepted,
    Denied,
}

/// <summary>Tells the consumer of the <see cref="RequestQueue"/> that a request is waiting.</summary>
public interface IEventSignal
{
    SignalResult Signal();
}

/// <summary>
/// The authenticated JSON-RPC server on 127.0.0.1. Each connection runs in its own task, and every frame
/// carries the token and is judged alone. Frames are parsed and authenticated in the read loop, so an
/// unauthenticated peer costs at most one frame per connection; only frames that pass get a task of their
/// own, so a request waiting for Revit does not hold up the frames behind it.
/// </summary>
public sealed class BridgeServer
{
    /// <summary>The protocol version this server speaks. <c>src/contract/protocol.json</c> must state the same.</summary>
    public const int ProtocolVersion = 1;

    private static readonly TimeSpan AcceptRetryDelay = TimeSpan.FromMilliseconds(100);

    private static readonly string PluginVersion =
        typeof(BridgeServer).Assembly.GetName().Version?.ToString() ?? "unknown";

    private static readonly JsonSerializerOptions StatusJson = new(JsonSerializerOptions.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    private readonly byte[] _token;
    private readonly RequestQueue _queue;
    private readonly RequestStore _store;
    private readonly IEventSignal _signal;
    private readonly TimeProvider _clock;
    private readonly CancellationTokenSource _stopping = new();

    private TcpListener? _listener;
    private ITimer? _expiryTimer;
    private Task _acceptLoop = Task.CompletedTask;

    public BridgeServer(string token, RequestQueue queue, RequestStore store, IEventSignal signal, TimeProvider clock)
    {
        ArgumentException.ThrowIfNullOrEmpty(token);

        _token = Encoding.UTF8.GetBytes(token);
        _queue = queue ?? throw new ArgumentNullException(nameof(queue));
        _store = store ?? throw new ArgumentNullException(nameof(store));
        _signal = signal ?? throw new ArgumentNullException(nameof(signal));
        _clock = clock ?? throw new ArgumentNullException(nameof(clock));
    }

    /// <summary>Starts listening on a port the system picks, and returns that port.</summary>
    public Task<int> StartAsync()
    {
        if (_listener is not null)
        {
            throw new InvalidOperationException("The server was already started.");
        }

        // Exclusive use stops another local process from binding the same port and catching tokens on Windows.
        var listener = new TcpListener(IPAddress.Loopback, 0) { ExclusiveAddressUse = true };
        listener.Start();

        _listener = listener;
        _expiryTimer = _clock.CreateTimer(
            Guarded(() => _queue.ExpireStale()),
            null,
            Limits.ExpirySweepInterval,
            Limits.ExpirySweepInterval);
        _acceptLoop = AcceptConnectionsAsync(listener);

        return Task.FromResult(((IPEndPoint)listener.LocalEndpoint).Port);
    }

    /// <summary>
    /// Stops listening and closes every connection. Requests still queued or running stay in the store,
    /// but nothing answers them. Safe to call twice.
    /// </summary>
    public async Task StopAsync()
    {
        if (_listener is null)
        {
            return;
        }

        await _expiryTimer!.DisposeAsync().ConfigureAwait(false);
        await _stopping.CancelAsync().ConfigureAwait(false);
        _listener.Stop();
        await _acceptLoop.ConfigureAwait(false);
    }

    /// <summary>
    /// Wraps a timer callback. An exception left unhandled on a timer thread terminates the process, and this
    /// process is Revit, with the user's model open. The next tick tries again.
    /// </summary>
    private static TimerCallback Guarded(Action action) => _ =>
    {
        try
        {
            action();
        }
        catch (Exception)
        {
        }
    };

    private async Task AcceptConnectionsAsync(TcpListener listener)
    {
        var connections = new List<Task>();
        while (true)
        {
            TcpClient client;
            try
            {
                client = await listener.AcceptTcpClientAsync(_stopping.Token).ConfigureAwait(false);
            }
            catch (Exception) when (_stopping.IsCancellationRequested)
            {
                break;
            }
            catch (SocketException)
            {
                // A client can reset its connection before it is accepted. That must not end the loop, and
                // the delay keeps a lasting failure, such as running out of sockets, from spinning.
                await Task.Delay(AcceptRetryDelay, _stopping.Token)
                    .ConfigureAwait(ConfigureAwaitOptions.SuppressThrowing);
                continue;
            }

            connections.RemoveAll(connection => connection.IsCompleted);
            if (connections.Count >= Limits.MaxConnections)
            {
                client.Dispose();
                continue;
            }

            connections.Add(Task.Run(() => ServeConnectionAsync(client)));
        }

        await Task.WhenAll(connections).ConfigureAwait(false);
    }

    private async Task ServeConnectionAsync(TcpClient client)
    {
        using (client)
        using (var closing = CancellationTokenSource.CreateLinkedTokenSource(_stopping.Token))
        {
            var authDeadline = _clock.CreateTimer(Guarded(closing.Cancel), null, Limits.AuthTimeout, Timeout.InfiniteTimeSpan);

            // Disposed asynchronously, which waits out a running callback, before closing goes away.
            await using (authDeadline.ConfigureAwait(false))
            {
                var frames = new List<Task>();
                try
                {
                    client.NoDelay = true;
                    var connection = new Connection(client.GetStream(), closing.Token);
                    while (await Framing.ReadAsync(connection.Stream, closing.Token).ConfigureAwait(false) is { } frame)
                    {
                        if (JsonRpcRequest.TryParse(frame) is not { } request)
                        {
                            break;
                        }

                        // Awaited here, so a peer that floods frames and never reads the answers stops being read.
                        if (Reject(request) is { } rejection)
                        {
                            await connection.SendAsync(JsonRpcResponse.Error(request.Id, rejection)).ConfigureAwait(false);
                            continue;
                        }

                        // Only an accepted frame gets this far, so rejected ones cannot extend the deadline.
                        // Disposing again after the first accepted frame does nothing.
                        await authDeadline.DisposeAsync().ConfigureAwait(false);

                        frames.RemoveAll(task => task.IsCompleted);
                        frames.Add(HandleAsync(connection, request.Id!, request.Method!, request.Params));
                    }
                }
                catch (Exception)
                {
                    // Whatever went wrong belongs to this peer: an oversized or cut frame, a reset, a missed
                    // deadline, a stop. Dropping the connection is the whole answer, and the others carry on.
                }

                // Results of requests still waiting stay in the store, where the client can fetch them.
                await closing.CancelAsync().ConfigureAwait(false);
                await Task.WhenAll(frames).ConfigureAwait(false);
            }
        }
    }

    /// <summary>Returns why the frame must be refused, checking the token before anything else about it.</summary>
    private JsonRpcError? Reject(JsonRpcRequest request)
    {
        if (request.Token is null || !CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(request.Token), _token))
        {
            return new JsonRpcError(JsonRpcCodes.Unauthorized, "The token is missing or wrong.");
        }

        if (request.ProtocolVersion != ProtocolVersion)
        {
            return new JsonRpcError(
                JsonRpcCodes.ProtocolMismatch,
                $"The plugin speaks protocol version {ProtocolVersion}, the request has {request.ProtocolVersion?.ToString() ?? "none"}.");
        }

        if (string.IsNullOrEmpty(request.Id))
        {
            return new JsonRpcError(JsonRpcCodes.InvalidParams, "The request needs a non-empty text id.");
        }

        if (request.Method is null || !MethodNames.All.Contains(request.Method))
        {
            return new JsonRpcError(JsonRpcCodes.MethodNotFound, $"Unknown method '{request.Method}'.");
        }

        if (request.Params.ValueKind != JsonValueKind.Object)
        {
            return new JsonRpcError(JsonRpcCodes.InvalidParams, "params must be an object.");
        }

        return null;
    }

    private async Task HandleAsync(Connection connection, string id, string method, JsonElement parameters)
    {
        byte[] response;
        try
        {
            response = await ExecuteAsync(id, method, parameters, connection.Closing).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (connection.Closing.IsCancellationRequested)
        {
            return;
        }
        catch (Exception e)
        {
            response = JsonRpcResponse.Error(id, new JsonRpcError(JsonRpcCodes.InternalError, $"The bridge failed: {e.Message}"));
        }

        try
        {
            await connection.SendAsync(response).ConfigureAwait(false);
        }
        catch (Exception)
        {
            // The socket is gone, or going: the read loop meets the same failure and closes the connection.
        }
    }

    private async Task<byte[]> ExecuteAsync(string id, string method, JsonElement parameters, CancellationToken closing)
    {
        switch (method)
        {
            case MethodNames.GetStatus:
                return JsonRpcResponse.Result(id, GetStatus());

            case MethodNames.GetRequestStatus:
            case MethodNames.CancelRequest:
                if (!parameters.TryGetProperty("requestId", out var requestId) || requestId.ValueKind != JsonValueKind.String)
                {
                    return JsonRpcResponse.Error(id, new JsonRpcError(JsonRpcCodes.InvalidParams, $"{method} needs a text requestId."));
                }

                var target = requestId.GetString()!;
                if (method == MethodNames.CancelRequest)
                {
                    // Refused for a running request: the status below then tells the client it still runs.
                    _queue.TryCancel(target);
                }

                return JsonRpcResponse.Result(id, await GetRequestStatusAsync(target, closing).ConfigureAwait(false));

            default:
                return await RunOnMainThreadAsync(id, method, parameters, closing).ConfigureAwait(false);
        }
    }

    private JsonElement GetStatus() => JsonSerializer.SerializeToElement(new
    {
        pluginVersion = PluginVersion,
        protocolVersion = ProtocolVersion,
        queueLength = _queue.Count,
        oldestQueuedSeconds = _queue.OldestQueuedSeconds,
    });

    private async Task<JsonElement> GetRequestStatusAsync(string requestId, CancellationToken closing)
    {
        var request = _store.Find(requestId);
        var state = request?.State ?? RequestState.Unknown;
        var outcome = request is not null && state is not (RequestState.Queued or RequestState.Running)
            ? await WaitForOutcomeAsync(request, closing).ConfigureAwait(false)
            : default;

        return JsonSerializer.SerializeToElement(
            new RequestStatus(requestId, state.ToString().ToLowerInvariant(), outcome.Result, outcome.Error),
            StatusJson);
    }

    private async Task<byte[]> RunOnMainThreadAsync(string id, string method, JsonElement parameters, CancellationToken closing)
    {
        var request = new PendingRequest(id, method, parameters, _clock.GetUtcNow());
        if (_store.TryAdd(request))
        {
            _queue.Enqueue(request);

            // Off the read loop, since raising the event may wait. The wait ends with the connection, so a
            // stuck signal cannot hold up StopAsync, while the task still fails the request if it is denied.
            await Task.Run(() => SignalOrFail(request)).WaitAsync(closing).ConfigureAwait(false);
        }
        else if (_store.Find(id) is not { } existing)
        {
            return JsonRpcResponse.Error(id, new JsonRpcError(
                JsonRpcCodes.Busy,
                "The bridge is full of unfinished requests and did not enqueue this one. Try again later."));
        }
        else if (existing.Method != method)
        {
            return JsonRpcResponse.Error(id, new JsonRpcError(
                JsonRpcCodes.InvalidParams,
                $"The id '{id}' already belongs to a {existing.Method} request."));
        }
        else
        {
            request = existing;
        }

        var outcome = await WaitForOutcomeAsync(request, closing).ConfigureAwait(false);
        return outcome.Error is { } error ? JsonRpcResponse.Error(id, error) : JsonRpcResponse.Result(id, outcome.Result!.Value);
    }

    private void SignalOrFail(PendingRequest request)
    {
        if (!TrySignal())
        {
            // Only while queued: an earlier signal may have put this request in Revit's hands already.
            request.FailIfQueued(JsonRpcCodes.InternalError, "Revit did not accept the request: its external event was denied.");
        }
    }

    private bool TrySignal()
    {
        try
        {
            return _signal.Signal() == SignalResult.Accepted;
        }
        catch (Exception)
        {
            // The host could not raise its event, which for the request is the same as a denial.
            return false;
        }
    }

    private static async Task<RequestOutcome> WaitForOutcomeAsync(PendingRequest request, CancellationToken closing)
    {
        try
        {
            return new RequestOutcome(await request.Completion.WaitAsync(closing).ConfigureAwait(false), null);
        }
        catch (RequestFailedException e)
        {
            return new RequestOutcome(null, new JsonRpcError(e.Code, e.Message));
        }
        catch (OperationCanceledException) when (request.Completion.IsCanceled)
        {
            return new RequestOutcome(null, new JsonRpcError(JsonRpcCodes.QueueExpired, request.CancelReason ?? "The request was cancelled."));
        }
    }

    /// <summary>How a finished request ended: a result, or an error.</summary>
    private readonly record struct RequestOutcome(JsonElement? Result, JsonRpcError? Error);

    /// <summary>The payload of <c>get_request_status</c> and <c>cancel_request</c>.</summary>
    private sealed record RequestStatus(string RequestId, string State, JsonElement? Result, JsonRpcError? Error);

    /// <summary>One peer's stream. Frames finish in any order, so whole frames take turns on it.</summary>
    private sealed class Connection(Stream stream, CancellationToken closing)
    {
        private readonly SemaphoreSlim _writeLock = new(1, 1);

        public Stream Stream { get; } = stream;

        public CancellationToken Closing { get; } = closing;

        public async Task SendAsync(byte[] payload)
        {
            await _writeLock.WaitAsync(Closing).ConfigureAwait(false);
            try
            {
                await Framing.WriteAsync(Stream, payload, Closing).ConfigureAwait(false);
            }
            finally
            {
                _writeLock.Release();
            }
        }
    }
}
