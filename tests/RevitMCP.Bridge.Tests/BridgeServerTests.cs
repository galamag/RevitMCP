using System.Buffers.Binary;
using System.Net;
using System.Net.NetworkInformation;
using System.Text;
using System.Text.Json;
using Xunit;

namespace RevitMCP.Bridge.Tests;

public class BridgeServerTests
{
    private const string Queued = MethodNames.GetModelInfo;

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static int ErrorCode(JsonElement response) =>
        response.GetProperty("error").GetProperty("code").GetInt32();

    private static string ErrorMessage(JsonElement response) =>
        response.GetProperty("error").GetProperty("message").GetString()!;

    private static JsonElement Result(JsonElement response) => response.GetProperty("result");

    private static string State(JsonElement response) => Result(response).GetProperty("state").GetString()!;

    private static byte[] Utf8(string text) => Encoding.UTF8.GetBytes(text);

    [Fact]
    public async Task BindsToLoopbackOnly()
    {
        await using var bridge = await Bridge.StartAsync();

        var listener = Assert.Single(ListenersOn(bridge.Port));

        Assert.Equal(IPAddress.Loopback, listener.Address);
    }

    [Fact]
    public async Task RejectsWrongToken()
    {
        await using var bridge = await Bridge.StartAsync();
        await using var client = await bridge.ConnectAsync();

        var response = await client.CallAsync("bad", Queued, token: "wrong");

        Assert.Equal("bad", response.GetProperty("id").GetString());
        Assert.Equal(JsonRpcCodes.Unauthorized, ErrorCode(response));
        Assert.False(response.TryGetProperty("result", out _));
        Assert.Equal(0, bridge.Queue.Count);
        Assert.Equal(0, bridge.Signal.Calls);
    }

    [Fact]
    public async Task EveryFrameNeedsTheToken()
    {
        await using var bridge = await Bridge.StartAsync();
        await using var client = await bridge.ConnectAsync();

        var first = await client.CallAsync("good-1", MethodNames.GetStatus);
        var missing = await client.CallAsync("missing", MethodNames.GetStatus, token: null);
        var prefix = await client.CallAsync("prefix", MethodNames.GetStatus, token: BridgeTestClient.ValidToken[..^1]);
        var second = await client.CallAsync("good-2", MethodNames.GetStatus);

        Assert.True(first.TryGetProperty("result", out _));
        Assert.Equal(JsonRpcCodes.Unauthorized, ErrorCode(missing));
        Assert.Equal(JsonRpcCodes.Unauthorized, ErrorCode(prefix));
        Assert.True(second.TryGetProperty("result", out _));
    }

    [Fact]
    public void EmptyToken_IsRefusedAtConstruction()
    {
        var clock = new FakeTimeProvider();

        Assert.Throws<ArgumentException>(() => new BridgeServer(
            string.Empty,
            new RequestQueue(clock),
            new RequestStore(Limits.ResultCapacity),
            new Bridge.FakeSignal(),
            clock));
    }

    [Fact]
    public async Task RejectsWrongProtocolVersion()
    {
        await using var bridge = await Bridge.StartAsync();
        await using var client = await bridge.ConnectAsync();

        var wrong = await client.CallAsync("wrong", Queued, protocolVersion: BridgeServer.ProtocolVersion + 1);
        var missing = await client.CallAsync("missing", Queued, protocolVersion: null);

        Assert.Equal(JsonRpcCodes.ProtocolMismatch, ErrorCode(wrong));
        Assert.Equal(JsonRpcCodes.ProtocolMismatch, ErrorCode(missing));
        Assert.Equal(0, bridge.Queue.Count);
    }

    [Fact]
    public async Task WrongTokenWinsOverWrongProtocolVersion()
    {
        await using var bridge = await Bridge.StartAsync();
        await using var client = await bridge.ConnectAsync();

        var response = await client.CallAsync("bad", Queued, token: "wrong", protocolVersion: 99);

        Assert.Equal(JsonRpcCodes.Unauthorized, ErrorCode(response));
    }

    [Fact]
    public async Task RejectsUnknownMethod()
    {
        await using var bridge = await Bridge.StartAsync();
        await using var client = await bridge.ConnectAsync();

        var response = await client.CallAsync("nope", "delete_everything");

        Assert.Equal(JsonRpcCodes.MethodNotFound, ErrorCode(response));
        Assert.Equal(0, bridge.Queue.Count);
        Assert.Equal(0, bridge.Signal.Calls);
    }

    [Fact]
    public async Task RejectsRequestWithoutId()
    {
        await using var bridge = await Bridge.StartAsync();
        await using var client = await bridge.ConnectAsync();
        var request = $$"""{"method":"get_status","params":{},"token":"{{BridgeTestClient.ValidToken}}","protocolVersion":1}""";

        await client.SendRawAsync(Utf8(request));
        var response = await client.ReceiveAsync(BridgeTestClient.NullId);

        Assert.Equal(JsonValueKind.Null, response.GetProperty("id").ValueKind);
        Assert.Equal(JsonRpcCodes.InvalidParams, ErrorCode(response));
    }

    [Fact]
    public async Task RejectsParamsThatAreNotAnObject()
    {
        await using var bridge = await Bridge.StartAsync();
        await using var client = await bridge.ConnectAsync();

        var response = await client.CallAsync("array", Queued, new[] { 1, 2 });

        Assert.Equal(JsonRpcCodes.InvalidParams, ErrorCode(response));
        Assert.Equal(0, bridge.Queue.Count);
    }

    [Fact]
    public async Task MissingParams_ReachTheQueueAsAnEmptyObject()
    {
        await using var bridge = await Bridge.StartAsync();
        await using var client = await bridge.ConnectAsync();
        var request = $$"""{"id":"bare","method":"get_model_info","token":"{{BridgeTestClient.ValidToken}}","protocolVersion":1}""";

        await client.SendRawAsync(Utf8(request));
        var dequeued = await bridge.DequeueAsync();

        Assert.Equal(JsonValueKind.Object, dequeued.Params.ValueKind);
    }

    [Theory]
    [InlineData(MethodNames.GetRequestStatus)]
    [InlineData(MethodNames.CancelRequest)]
    public async Task RequestIdIsRequired(string method)
    {
        await using var bridge = await Bridge.StartAsync();
        await using var client = await bridge.ConnectAsync();

        var missing = await client.CallAsync("missing", method);
        var notText = await client.CallAsync("not-text", method, new { requestId = 7 });

        Assert.Equal(JsonRpcCodes.InvalidParams, ErrorCode(missing));
        Assert.Equal(JsonRpcCodes.InvalidParams, ErrorCode(notText));
    }

    [Fact]
    public async Task GetStatus_WorksWhileNothingDrainsTheQueue()
    {
        await using var bridge = await Bridge.StartAsync();
        await using var client = await bridge.ConnectAsync();
        await client.SendAsync("waiting", Queued);
        await bridge.WaitForAdmissionAsync(client);
        await bridge.WaitForSignalAsync();
        bridge.Clock.Advance(TimeSpan.FromSeconds(7));

        var status = Result(await client.CallAsync("status", MethodNames.GetStatus));

        Assert.False(string.IsNullOrEmpty(status.GetProperty("pluginVersion").GetString()));
        Assert.Equal(BridgeServer.ProtocolVersion, status.GetProperty("protocolVersion").GetInt32());
        Assert.Equal(1, status.GetProperty("queueLength").GetInt32());
        Assert.Equal(7, status.GetProperty("oldestQueuedSeconds").GetDouble(), precision: 3);
        Assert.Equal(1, bridge.Signal.Calls);
    }

    [Fact]
    public async Task ExecutesAndReturnsResult()
    {
        await using var bridge = await Bridge.StartAsync();
        await using var client = await bridge.ConnectAsync();

        await client.SendAsync("req-1", Queued, new { name = "Уровень 1" });
        var request = await bridge.DequeueAsync();
        request.Complete(TestRequests.Json("""{"level":"Уровень 1"}"""));
        var response = await client.ReceiveAsync("req-1");

        Assert.Equal("req-1", request.Id);
        Assert.Equal(Queued, request.Method);
        Assert.Equal("2.0", response.GetProperty("jsonrpc").GetString());
        Assert.Equal("req-1", response.GetProperty("id").GetString());
        Assert.Equal("Уровень 1", Result(response).GetProperty("level").GetString());
        Assert.False(response.TryGetProperty("error", out _));
        Assert.Equal(1, bridge.Signal.Calls);
    }

    [Fact]
    public async Task Params_OutliveTheFrameTheyCameIn()
    {
        await using var bridge = await Bridge.StartAsync();
        await using var client = await bridge.ConnectAsync();

        await client.SendAsync("req-1", Queued, new { name = "Уровень 1" });
        await bridge.WaitForAdmissionAsync(client);
        var request = await bridge.DequeueAsync();

        Assert.Equal("Уровень 1", request.Params.GetProperty("name").GetString());
    }

    [Fact]
    public async Task FailedRequest_ReturnsItsCode()
    {
        await using var bridge = await Bridge.StartAsync();
        await using var client = await bridge.ConnectAsync();

        await client.SendAsync("req-1", Queued);
        var request = await bridge.DequeueAsync();
        request.Fail(-32050, "no_active_document");
        var response = await client.ReceiveAsync("req-1");

        Assert.Equal(-32050, ErrorCode(response));
        Assert.Equal("no_active_document", ErrorMessage(response));
    }

    [Fact]
    public async Task DuplicateId_DoesNotEnqueueTwice()
    {
        await using var bridge = await Bridge.StartAsync();
        await using var client = await bridge.ConnectAsync();

        await client.SendAsync("same", Queued);
        await client.SendAsync("same", Queued);
        await bridge.WaitForAdmissionAsync(client);

        // Checked before dequeuing: a dequeue skips a second copy of a request that already runs, and hides it.
        Assert.Equal(1, bridge.Queue.Count);

        var request = await bridge.DequeueAsync();
        Assert.Null(bridge.Queue.TryDequeue());
        request.Complete(TestRequests.Json("""{"value":1}"""));

        var first = await client.ReceiveAsync("same");
        var second = await client.ReceiveAsync("same");

        Assert.Equal(first.GetRawText(), second.GetRawText());
        Assert.Equal(1, bridge.Signal.Calls);
    }

    [Fact]
    public async Task RepeatAfterFinish_ReturnsTheStoredResult_AndRunsNothing()
    {
        await using var bridge = await Bridge.StartAsync();
        await using var client = await bridge.ConnectAsync();
        await client.SendAsync("same", Queued);
        (await bridge.DequeueAsync()).Complete(TestRequests.Json("""{"value":1}"""));
        var first = await client.ReceiveAsync("same");

        var repeat = await client.CallAsync("same", Queued);

        Assert.Equal(first.GetRawText(), repeat.GetRawText());
        Assert.Null(bridge.Queue.TryDequeue());
        Assert.Equal(1, bridge.Signal.Calls);
    }

    [Fact]
    public async Task SameIdWithAnotherMethod_IsRefused_AndGetsNoResult()
    {
        await using var bridge = await Bridge.StartAsync();
        await using var client = await bridge.ConnectAsync();
        var original = TestRequests.Make("same", bridge.Clock.GetUtcNow(), method: "another_method");
        original.Complete(TestRequests.Json("""{"value":1}"""));
        Assert.True(bridge.Store.TryAdd(original));

        var response = await client.CallAsync("same", Queued);

        Assert.Equal(JsonRpcCodes.InvalidParams, ErrorCode(response));
        Assert.False(response.TryGetProperty("result", out _));
        Assert.Equal(0, bridge.Queue.Count);
        Assert.Equal(0, bridge.Signal.Calls);
    }

    [Fact]
    public void ParsedRequest_DoesNotPrintTheToken()
    {
        var frame = Utf8($$"""{"id":"a","method":"get_status","params":{},"token":"{{BridgeTestClient.ValidToken}}","protocolVersion":1}""");

        var printed = JsonRpcRequest.TryParse(frame)!.ToString();

        Assert.DoesNotContain(BridgeTestClient.ValidToken, printed);
        Assert.Contains("get_status", printed);
    }

    [Fact]
    public async Task CancelQueuedRequest()
    {
        await using var bridge = await Bridge.StartAsync();
        await using var client = await bridge.ConnectAsync();
        await client.SendAsync("target", Queued);
        await bridge.WaitForAdmissionAsync(client);

        var cancel = await client.CallAsync("cancel", MethodNames.CancelRequest, new { requestId = "target" });
        var original = await client.ReceiveAsync("target");

        Assert.Equal("target", Result(cancel).GetProperty("requestId").GetString());
        Assert.Equal("cancelled", State(cancel));
        Assert.Equal(JsonRpcCodes.QueueExpired, ErrorCode(original));
        Assert.False(string.IsNullOrEmpty(ErrorMessage(original)));
        Assert.Null(bridge.Queue.TryDequeue());
    }

    [Fact]
    public async Task CancelRunningRequest_ReportsRunning_AndKeepsTheRealResult()
    {
        await using var bridge = await Bridge.StartAsync();
        await using var client = await bridge.ConnectAsync();
        await client.SendAsync("target", Queued);
        var request = await bridge.DequeueAsync();

        var cancel = await client.CallAsync("cancel", MethodNames.CancelRequest, new { requestId = "target" });
        request.Complete(TestRequests.Json("""{"value":1}"""));
        var original = await client.ReceiveAsync("target");

        Assert.Equal("running", State(cancel));
        Assert.Equal(1, Result(original).GetProperty("value").GetInt32());
    }

    [Fact]
    public async Task CancelUnknownRequest_ReportsUnknown()
    {
        await using var bridge = await Bridge.StartAsync();
        await using var client = await bridge.ConnectAsync();

        var cancel = await client.CallAsync("cancel", MethodNames.CancelRequest, new { requestId = "nobody" });

        Assert.Equal("unknown", State(cancel));
    }

    [Fact]
    public async Task GetRequestStatus_ReportsEveryState()
    {
        await using var bridge = await Bridge.StartAsync();
        await using var client = await bridge.ConnectAsync();
        Task<JsonElement> StatusOf(string id) =>
            client.CallAsync($"status-{Guid.NewGuid():N}", MethodNames.GetRequestStatus, new { requestId = id });

        var unknown = await StatusOf("nobody");
        Assert.Equal("nobody", Result(unknown).GetProperty("requestId").GetString());
        Assert.Equal("unknown", State(unknown));

        await client.SendAsync("ok", Queued);
        await bridge.WaitForAdmissionAsync(client);
        var queued = await StatusOf("ok");
        Assert.Equal("queued", State(queued));
        Assert.False(Result(queued).TryGetProperty("result", out _));

        var request = await bridge.DequeueAsync();
        var running = await StatusOf("ok");
        Assert.Equal("running", State(running));
        Assert.False(Result(running).TryGetProperty("result", out _));

        request.Complete(TestRequests.Json("""{"name":"Уровень 1"}"""));
        await client.ReceiveAsync("ok");
        var succeeded = await StatusOf("ok");
        Assert.Equal("succeeded", State(succeeded));
        Assert.Equal("Уровень 1", Result(succeeded).GetProperty("result").GetProperty("name").GetString());

        await client.SendAsync("bad", Queued);
        (await bridge.DequeueAsync()).Fail(-32050, "boom");
        await client.ReceiveAsync("bad");
        var failed = await StatusOf("bad");
        Assert.Equal("failed", State(failed));
        Assert.Equal(-32050, ErrorCode(Result(failed)));
        Assert.Equal("boom", ErrorMessage(Result(failed)));

        await client.SendAsync("gone", Queued);
        await bridge.WaitForAdmissionAsync(client);
        await client.CallAsync("cancel", MethodNames.CancelRequest, new { requestId = "gone" });
        var cancelled = await StatusOf("gone");
        Assert.Equal("cancelled", State(cancelled));
        Assert.Equal(JsonRpcCodes.QueueExpired, ErrorCode(Result(cancelled)));
    }

    [Fact]
    public async Task ResultSurvivesTheConnectionThatAskedForIt()
    {
        await using var bridge = await Bridge.StartAsync();
        var first = await bridge.ConnectAsync();
        await first.SendAsync("lost", Queued);
        var request = await bridge.DequeueAsync();
        await bridge.WaitForSignalAsync();
        await first.DisposeAsync();
        request.Complete(TestRequests.Json("""{"value":1}"""));
        await using var second = await bridge.ConnectAsync();

        var status = await second.CallAsync("status", MethodNames.GetRequestStatus, new { requestId = "lost" });
        var repeat = await second.CallAsync("lost", Queued);

        Assert.Equal("succeeded", State(status));
        Assert.Equal(1, Result(status).GetProperty("result").GetProperty("value").GetInt32());
        Assert.Equal(1, Result(repeat).GetProperty("value").GetInt32());
        Assert.Equal(1, bridge.Signal.Calls);
    }

    [Fact]
    public async Task ParallelRequests_DoNotMixResults()
    {
        const int total = 50;
        await using var bridge = await Bridge.StartAsync();
        var clients = new List<BridgeTestClient>();
        for (var i = 0; i < Limits.MaxConnections; i++)
        {
            clients.Add(await bridge.ConnectAsync());
        }

        BridgeTestClient ClientFor(int request) => clients[request % clients.Count];

        await Task.WhenAll(Enumerable.Range(0, total).Select(n => ClientFor(n).SendAsync($"req-{n}", Queued, new { n })));

        var running = new List<PendingRequest>();
        for (var i = 0; i < total; i++)
        {
            running.Add(await bridge.DequeueAsync());
        }

        // Answer backwards, so responses cannot match their requests just by arriving in order.
        running.Reverse();
        foreach (var request in running)
        {
            var n = request.Params.GetProperty("n").GetInt32();
            request.Complete(TestRequests.Json($$"""{"echo":{{n}}}"""));
        }

        var responses = await Task.WhenAll(Enumerable.Range(0, total).Select(n => ClientFor(n).ReceiveAsync($"req-{n}")));

        for (var n = 0; n < total; n++)
        {
            Assert.Equal(n, Result(responses[n]).GetProperty("echo").GetInt32());
        }

        foreach (var client in clients)
        {
            await client.DisposeAsync();
        }
    }

    [Fact]
    public async Task LargeResponsesFinishingTogether_ArriveWhole()
    {
        const int total = 8;
        var filler = new string('x', 4 * 1024 * 1024);
        await using var bridge = await Bridge.StartAsync();
        await using var client = await bridge.ConnectAsync();

        var running = new List<PendingRequest>();
        for (var n = 0; n < total; n++)
        {
            await client.SendAsync($"req-{n}", Queued, new { n });
            running.Add(await bridge.DequeueAsync());
        }

        // This checks the bytes that arrive. It does not prove the write lock: the suite also passes without it.
        var results = running
            .Select(request => (Request: request, Result: TestRequests.Json(JsonSerializer.Serialize(new
            {
                n = request.Params.GetProperty("n").GetInt32(),
                filler,
            }))))
            .ToList();
        await Task.WhenAll(results.Select(item => Task.Run(() => item.Request.Complete(item.Result), Ct)));

        for (var n = 0; n < total; n++)
        {
            var result = Result(await client.ReceiveAsync($"req-{n}"));
            Assert.Equal(n, result.GetProperty("n").GetInt32());
            Assert.Equal(filler.Length, result.GetProperty("filler").GetString()!.Length);
        }
    }

    [Fact]
    public async Task SignalDenied_FailsRequest()
    {
        await using var bridge = await Bridge.StartAsync();
        await using var client = await bridge.ConnectAsync();
        bridge.Signal.Result = SignalResult.Denied;

        var response = await client.CallAsync("req-1", Queued);

        Assert.Equal(JsonRpcCodes.InternalError, ErrorCode(response));
        Assert.Equal(RequestState.Failed, bridge.Store.GetState("req-1"));
        Assert.Null(bridge.Queue.TryDequeue());
    }

    [Fact]
    public async Task SignalThatThrows_FailsRequest()
    {
        await using var bridge = await Bridge.StartAsync();
        await using var client = await bridge.ConnectAsync();
        bridge.Signal.OnSignal = () => throw new InvalidOperationException("Revit is shutting down.");

        var response = await client.CallAsync("req-1", Queued);

        Assert.Equal(JsonRpcCodes.InternalError, ErrorCode(response));
        Assert.Equal(RequestState.Failed, bridge.Store.GetState("req-1"));
        Assert.Null(bridge.Queue.TryDequeue());
    }

    [Fact]
    public async Task SignalDenied_DoesNotFailARequestThatAlreadyRuns()
    {
        await using var bridge = await Bridge.StartAsync();
        await using var client = await bridge.ConnectAsync();
        var taken = new TaskCompletionSource<PendingRequest>(TaskCreationOptions.RunContinuationsAsynchronously);
        bridge.Signal.OnSignal = () =>
        {
            // An earlier raise of the event got to the request first, so Revit runs it despite this denial.
            taken.SetResult(bridge.Queue.TryDequeue()!);
            return SignalResult.Denied;
        };

        await client.SendAsync("req-1", Queued);
        var running = await taken.Task.WaitAsync(BridgeTestClient.Timeout, Ct);

        // The denial is handled off the read loop with nothing to observe, so give a wrong handler time to act.
        await Task.Delay(TimeSpan.FromMilliseconds(100), Ct);
        Assert.Equal(RequestState.Running, running.State);

        running.Complete(TestRequests.Json("""{"value":1}"""));
        var response = await client.ReceiveAsync("req-1");

        Assert.Equal(1, Result(response).GetProperty("value").GetInt32());
    }

    [Fact]
    public async Task BlockedSignal_DoesNotHoldUpTheFramesBehindIt()
    {
        using var release = new ManualResetEventSlim();
        await using var bridge = await Bridge.StartAsync();
        await using var client = await bridge.ConnectAsync();
        bridge.Signal.OnSignal = () =>
        {
            release.Wait(BridgeTestClient.Timeout * 2);
            return SignalResult.Accepted;
        };

        try
        {
            await client.SendAsync("req-1", Queued);
            var status = await client.CallAsync("status", MethodNames.GetStatus);

            Assert.Equal(1, Result(status).GetProperty("queueLength").GetInt32());
        }
        finally
        {
            release.Set();
        }
    }

    [Fact]
    public async Task StopAsync_DoesNotWaitForABlockedSignal()
    {
        using var release = new ManualResetEventSlim();
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        await using var bridge = await Bridge.StartAsync();
        await using var client = await bridge.ConnectAsync();
        bridge.Signal.OnSignal = () =>
        {
            entered.SetResult();
            release.Wait(BridgeTestClient.Timeout * 2);
            return SignalResult.Accepted;
        };

        try
        {
            await client.SendAsync("req-1", Queued);
            await entered.Task.WaitAsync(BridgeTestClient.Timeout, Ct);

            await bridge.Server.StopAsync().WaitAsync(BridgeTestClient.Timeout, Ct);
        }
        finally
        {
            release.Set();
        }
    }

    [Fact]
    public async Task SignalDenied_FailsTheRequestEvenIfItsConnectionIsGone()
    {
        using var release = new ManualResetEventSlim();
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        await using var bridge = await Bridge.StartAsync();
        var client = await bridge.ConnectAsync();
        bridge.Signal.OnSignal = () =>
        {
            entered.SetResult();
            release.Wait(BridgeTestClient.Timeout * 2);
            return SignalResult.Denied;
        };

        try
        {
            await client.SendAsync("req-1", Queued);
            await entered.Task.WaitAsync(BridgeTestClient.Timeout, Ct);
            await client.DisposeAsync();
            await bridge.AssertServesNewConnectionAsync();
        }
        finally
        {
            release.Set();
        }

        await bridge.Store.Find("req-1")!.Completion
            .ContinueWith(_ => { }, Ct, TaskContinuationOptions.None, TaskScheduler.Default)
            .WaitAsync(BridgeTestClient.Timeout, Ct);
        Assert.Equal(RequestState.Failed, bridge.Store.GetState("req-1"));
    }

    [Fact]
    public async Task ExpiredRequest_FailsOnTheTimer_WhileNothingTouchesTheQueue()
    {
        await using var bridge = await Bridge.StartAsync();
        await using var client = await bridge.ConnectAsync();
        await client.SendAsync("stale", Queued);
        await bridge.WaitForAdmissionAsync(client);

        bridge.Clock.Advance(Limits.QueueTtl + Limits.ExpirySweepInterval);
        var response = await client.ReceiveAsync("stale");

        Assert.Equal(JsonRpcCodes.QueueExpired, ErrorCode(response));
        Assert.Contains("expired", ErrorMessage(response));
        Assert.Equal(RequestState.Cancelled, bridge.Store.GetState("stale"));
    }

    [Fact]
    public async Task FailureInsideTheExpirySweep_StaysOnTheTimerThread()
    {
        var clock = new FakeTimeProvider();
        var queue = new RequestQueue(new BrokenClock());
        var server = new BridgeServer(
            BridgeTestClient.ValidToken,
            queue,
            new RequestStore(Limits.ResultCapacity),
            new Bridge.FakeSignal(),
            clock);
        await server.StartAsync();

        try
        {
            // FakeTimeProvider fires on this thread, so an exception that left the callback would land here.
            clock.Advance(Limits.ExpirySweepInterval);
        }
        finally
        {
            await server.StopAsync().WaitAsync(BridgeTestClient.Timeout, Ct);
        }
    }

    [Fact]
    public async Task SilentPeers_AreClosedAtTheAuthDeadline_AndFreeTheirSlots()
    {
        await using var bridge = await Bridge.StartAsync();
        var peers = new List<BridgeTestClient>();
        for (var i = 0; i < Limits.MaxConnections; i++)
        {
            peers.Add(await bridge.ConnectAsync());
        }

        await bridge.WaitForConnectionsAsync(Limits.MaxConnections);
        bridge.Clock.Advance(Limits.AuthTimeout);

        foreach (var peer in peers)
        {
            await peer.AssertClosedAsync();
        }

        await bridge.AssertServesNewConnectionAsync();

        foreach (var peer in peers)
        {
            await peer.DisposeAsync();
        }
    }

    [Fact]
    public async Task WrongTokenPeer_IsClosedAtTheAuthDeadline_AndCannotExtendIt()
    {
        var half = Limits.AuthTimeout / 2;
        await using var bridge = await Bridge.StartAsync();
        await using var client = await bridge.ConnectAsync();
        await bridge.WaitForConnectionsAsync(1);

        bridge.Clock.Advance(half);
        var response = await client.CallAsync("bad", Queued, token: "wrong");
        bridge.Clock.Advance(Limits.AuthTimeout - half);

        Assert.Equal(JsonRpcCodes.Unauthorized, ErrorCode(response));
        await client.AssertClosedAsync();
    }

    [Fact]
    public async Task FrameRejectedAfterTheTokenCheck_DoesNotDisarmTheAuthDeadline()
    {
        await using var bridge = await Bridge.StartAsync();
        await using var client = await bridge.ConnectAsync();
        await bridge.WaitForConnectionsAsync(1);

        var response = await client.CallAsync("nope", "unknown_method");
        bridge.Clock.Advance(Limits.AuthTimeout);

        Assert.Equal(JsonRpcCodes.MethodNotFound, ErrorCode(response));
        await client.AssertClosedAsync();
    }

    [Fact]
    public async Task AuthenticatedIdleConnection_OutlivesTheAuthDeadline()
    {
        await using var bridge = await Bridge.StartAsync();
        await using var client = await bridge.ConnectAsync();
        await bridge.WaitForConnectionsAsync(1);

        bridge.Clock.Advance(Limits.AuthTimeout - TimeSpan.FromSeconds(1));
        await client.CallAsync("first", MethodNames.GetStatus);
        bridge.Clock.Advance(Limits.AuthTimeout * 3);
        var status = await client.CallAsync("second", MethodNames.GetStatus);

        Assert.True(status.TryGetProperty("result", out _));
    }

    [Fact]
    public async Task FullStore_AnswersBusy_AndEnqueuesNothing()
    {
        await using var bridge = await Bridge.StartAsync(storeCapacity: 1);
        await using var client = await bridge.ConnectAsync();
        await client.SendAsync("first", Queued);
        await bridge.WaitForAdmissionAsync(client);
        await bridge.WaitForSignalAsync();

        var response = await client.CallAsync("second", Queued);

        Assert.Equal(JsonRpcCodes.Busy, ErrorCode(response));
        Assert.Null(bridge.Store.Find("second"));
        Assert.Equal(1, bridge.Signal.Calls);
    }

    [Fact]
    public async Task ResultTooLargeForAFrame_AnswersAnError_AndKeepsTheConnection()
    {
        await using var bridge = await Bridge.StartAsync();
        await using var client = await bridge.ConnectAsync();
        await client.SendAsync("huge", Queued);
        var request = await bridge.DequeueAsync();

        request.Complete(TestRequests.Json($"\"{new string('x', Limits.MaxFrameBytes)}\""));
        var response = await client.ReceiveAsync("huge");
        var status = await client.CallAsync("status", MethodNames.GetStatus);

        Assert.Equal(JsonRpcCodes.InternalError, ErrorCode(response));
        Assert.True(status.TryGetProperty("result", out _));
    }

    [Fact]
    public async Task UnusableResult_AnswersAnError_AndKeepsTheConnection()
    {
        await using var bridge = await Bridge.StartAsync();
        await using var client = await bridge.ConnectAsync();
        await client.SendAsync("broken", Queued);
        var request = await bridge.DequeueAsync();

        request.Complete(default);
        var response = await client.ReceiveAsync("broken");
        var status = await client.CallAsync("status", MethodNames.GetStatus);

        Assert.Equal(JsonRpcCodes.InternalError, ErrorCode(response));
        Assert.True(status.TryGetProperty("result", out _));
    }

    [Theory]
    [InlineData("{not json")]
    [InlineData("")]
    [InlineData("[1,2]")]
    [InlineData("42")]
    [InlineData("""{"id":"\ud800","token":"x"}""")]
    [InlineData("""{"id":"a","token":"\ud800"}""")]
    public async Task MalformedJson_ClosesWithoutCrash(string frame)
    {
        await using var bridge = await Bridge.StartAsync();
        await using var client = await bridge.ConnectAsync();

        await client.SendRawAsync(Utf8(frame));

        await client.AssertClosedAsync();
        await bridge.AssertServesNewConnectionAsync();
    }

    [Fact]
    public async Task OversizedFrame_ClosesConnection()
    {
        await using var bridge = await Bridge.StartAsync();
        await using var client = await bridge.ConnectAsync();
        var header = new byte[4];
        BinaryPrimitives.WriteUInt32BigEndian(header, (uint)Limits.MaxFrameBytes + 1);

        await client.SendBytesAsync(header);

        await client.AssertClosedAsync();
        await bridge.AssertServesNewConnectionAsync();
    }

    [Fact]
    public async Task HttpRequest_ClosesConnection()
    {
        await using var bridge = await Bridge.StartAsync();
        await using var client = await bridge.ConnectAsync();

        await client.SendBytesAsync(Encoding.ASCII.GetBytes("POST / HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n"));

        await client.AssertClosedAsync();
        await bridge.AssertServesNewConnectionAsync();
    }

    [Fact]
    public async Task ConnectionsAboveTheCap_AreClosedAtOnce_WithoutTouchingTheOthers()
    {
        await using var bridge = await Bridge.StartAsync();
        var held = new List<BridgeTestClient>();
        for (var i = 0; i < Limits.MaxConnections - 1; i++)
        {
            // Silent on purpose: a slot is taken before any token could be checked.
            held.Add(await bridge.ConnectAsync());
        }

        await using var working = await bridge.ConnectAsync();
        await working.CallAsync("first", MethodNames.GetStatus);

        await using var extra = await bridge.ConnectAsync();
        await extra.AssertClosedAsync();
        var status = await working.CallAsync("second", MethodNames.GetStatus);
        Assert.True(status.TryGetProperty("result", out _));

        await held[0].DisposeAsync();
        await bridge.AssertServesNewConnectionAsync();

        foreach (var client in held.Skip(1))
        {
            await client.DisposeAsync();
        }
    }

    [Fact]
    public async Task StopAsync_ClosesConnections_EvenWithARequestInFlight()
    {
        await using var bridge = await Bridge.StartAsync();
        await using var client = await bridge.ConnectAsync();
        await client.SendAsync("stuck", Queued);
        await bridge.WaitForAdmissionAsync(client);

        await bridge.Server.StopAsync().WaitAsync(BridgeTestClient.Timeout, Ct);

        await client.AssertClosedAsync();
        Assert.Empty(ListenersOn(bridge.Port));
        Assert.Equal(0, bridge.Clock.ActiveTimers);
    }

    [Fact]
    public async Task RunsOnTheSystemClock()
    {
        var queue = new RequestQueue(TimeProvider.System);
        var store = new RequestStore(Limits.ResultCapacity);
        var server = new BridgeServer(BridgeTestClient.ValidToken, queue, store, new Bridge.FakeSignal(), TimeProvider.System);
        var port = await server.StartAsync();

        await using (var client = await BridgeTestClient.ConnectAsync(port))
        {
            var status = await client.CallAsync("status", MethodNames.GetStatus);
            Assert.Equal(0, Result(status).GetProperty("queueLength").GetInt32());
        }

        await server.StopAsync().WaitAsync(BridgeTestClient.Timeout, Ct);
        await server.StopAsync().WaitAsync(BridgeTestClient.Timeout, Ct);
    }

    [Fact]
    public async Task StopAsync_WithoutStart_DoesNothing()
    {
        var clock = new FakeTimeProvider();
        var server = new BridgeServer(
            BridgeTestClient.ValidToken,
            new RequestQueue(clock),
            new RequestStore(Limits.ResultCapacity),
            new Bridge.FakeSignal(),
            clock);

        await server.StopAsync().WaitAsync(BridgeTestClient.Timeout, Ct);
    }

    private static IEnumerable<IPEndPoint> ListenersOn(int port) =>
        IPGlobalProperties.GetIPGlobalProperties().GetActiveTcpListeners().Where(endpoint => endpoint.Port == port);

    private sealed class BrokenClock : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => throw new InvalidOperationException("The clock failed.");
    }

    /// <summary>A running server with everything around it faked, and nothing draining its queue.</summary>
    private sealed class Bridge : IAsyncDisposable
    {
        private int _barriers;

        private Bridge(int storeCapacity)
        {
            Queue = new RequestQueue(Clock);
            Store = new RequestStore(storeCapacity);
            Server = new BridgeServer(BridgeTestClient.ValidToken, Queue, Store, Signal, Clock);
        }

        public FakeTimeProvider Clock { get; } = new();

        public FakeSignal Signal { get; } = new();

        public RequestQueue Queue { get; }

        public RequestStore Store { get; }

        public BridgeServer Server { get; }

        public int Port { get; private set; }

        public static async Task<Bridge> StartAsync(int storeCapacity = Limits.ResultCapacity)
        {
            var bridge = new Bridge(storeCapacity);
            bridge.Port = await bridge.Server.StartAsync();
            return bridge;
        }

        public Task<BridgeTestClient> ConnectAsync() => BridgeTestClient.ConnectAsync(Port);

        /// <summary>
        /// Returns once this connection's earlier frames were admitted, because a connection admits frames in
        /// order. Uses <c>get_request_status</c>, which leaves the queue alone: reading the queue would expire
        /// stale requests and hide what the timer does.
        /// </summary>
        public async Task WaitForAdmissionAsync(BridgeTestClient client)
        {
            var id = $"barrier-{Interlocked.Increment(ref _barriers)}";
            await client.CallAsync(id, MethodNames.GetRequestStatus, new { requestId = id });
        }

        public async Task<PendingRequest> DequeueAsync()
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(TestContext.Current.CancellationToken);
            timeout.CancelAfter(BridgeTestClient.Timeout);
            while (true)
            {
                if (Queue.TryDequeue() is { } request)
                {
                    return request;
                }

                await Task.Delay(TimeSpan.FromMilliseconds(5), timeout.Token);
            }
        }

        /// <summary>Returns once the signal was called. It runs off the read loop, so admission does not imply it.</summary>
        public Task WaitForSignalAsync() => WaitUntilAsync(() => Signal.Calls >= 1);

        /// <summary>
        /// Returns once this many connections are being served, each with its deadline armed. The clock must not
        /// advance before that, or a deadline armed later would miss it. The server's own sweep is one more timer.
        /// </summary>
        public Task WaitForConnectionsAsync(int count) => WaitUntilAsync(() => Clock.ActiveTimers == count + 1);

        private static async Task WaitUntilAsync(Func<bool> condition)
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(TestContext.Current.CancellationToken);
            timeout.CancelAfter(BridgeTestClient.Timeout);
            while (!condition())
            {
                await Task.Delay(TimeSpan.FromMilliseconds(5), timeout.Token);
            }
        }

        /// <summary>
        /// Proves the server still works. Retries, since a connection slot frees shortly after its client
        /// leaves and until then a new connection is refused.
        /// </summary>
        public async Task AssertServesNewConnectionAsync()
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(TestContext.Current.CancellationToken);
            timeout.CancelAfter(BridgeTestClient.Timeout);
            while (true)
            {
                await using var client = await ConnectAsync();
                var answered = client.ReceiveAsync("probe");
                try
                {
                    await client.SendAsync("probe", MethodNames.GetStatus);
                    if (await Task.WhenAny(answered, client.AssertClosedAsync()).WaitAsync(timeout.Token) == answered)
                    {
                        Assert.True((await answered).TryGetProperty("result", out _));
                        return;
                    }
                }
                catch (IOException)
                {
                    // The refusal beat the frame to the socket: the same outcome as the close above.
                }

                await Task.Delay(TimeSpan.FromMilliseconds(20), timeout.Token);
            }
        }

        public async ValueTask DisposeAsync() =>
            await Server.StopAsync().WaitAsync(BridgeTestClient.Timeout, CancellationToken.None);

        internal sealed class FakeSignal : IEventSignal
        {
            private int _calls;

            public int Calls => Volatile.Read(ref _calls);

            public SignalResult Result { get; set; } = SignalResult.Accepted;

            public Func<SignalResult>? OnSignal { get; set; }

            public SignalResult Signal()
            {
                Interlocked.Increment(ref _calls);
                return OnSignal?.Invoke() ?? Result;
            }
        }
    }
}
