using Xunit;

namespace RevitMCP.Bridge.Tests;

public class PendingRequestTests
{
    private static readonly DateTimeOffset Now = new(2026, 1, 1, 0, 0, 0, TimeSpan.Zero);

    [Fact]
    public async Task Complete_ResolvesCompletionWithResult()
    {
        var request = TestRequests.Make("a", Now);

        Assert.True(request.Complete(TestRequests.Json("{\"ok\":true}")));

        var result = await request.Completion;
        Assert.True(result.GetProperty("ok").GetBoolean());
        Assert.Equal(RequestState.Succeeded, request.State);
    }

    [Fact]
    public async Task Fail_FaultsCompletionWithCodeAndMessage()
    {
        var request = TestRequests.Make("a", Now);

        Assert.True(request.Fail(-32001, "no such element"));

        var ex = await Assert.ThrowsAsync<RequestFailedException>(() => request.Completion);
        Assert.Equal(-32001, ex.Code);
        Assert.Equal("no such element", ex.Message);
        Assert.Equal(RequestState.Failed, request.State);
    }

    [Fact]
    public async Task Cancel_CancelsCompletionAndKeepsReason()
    {
        var request = TestRequests.Make("a", Now);

        Assert.True(request.Cancel("client went away"));

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => request.Completion);
        Assert.Equal(RequestState.Cancelled, request.State);
        Assert.Equal("client went away", request.CancelReason);
    }

    [Fact]
    public void FirstTerminalTransitionWins()
    {
        var request = TestRequests.Make("a", Now);

        Assert.True(request.Complete(TestRequests.Json("1")));
        Assert.False(request.Fail(1, "late"));
        Assert.False(request.Cancel("late"));

        Assert.Equal(RequestState.Succeeded, request.State);
        Assert.Null(request.CancelReason);
    }

    [Fact]
    public void Cancel_FailsOnceRunning_AndRealResultStillRecorded()
    {
        var clock = new FakeTimeProvider();
        var queue = new RequestQueue(clock);
        var request = TestRequests.Make("a", clock.GetUtcNow());
        queue.Enqueue(request);
        Assert.Same(request, queue.TryDequeue());

        Assert.False(request.Cancel("client timeout"));
        Assert.Equal(RequestState.Running, request.State);
        Assert.Null(request.CancelReason);
        Assert.False(request.Completion.IsCompleted);

        Assert.True(request.Complete(TestRequests.Json("{}")));
        Assert.Equal(RequestState.Succeeded, request.State);
    }

    [Fact]
    public async Task DequeuedRequest_IsNeverCancelledWhenHandedOut()
    {
        var clock = new FakeTimeProvider();
        var queue = new RequestQueue(clock);
        for (var i = 0; i < 200; i++)
        {
            var request = TestRequests.Make($"r{i}", clock.GetUtcNow());
            queue.Enqueue(request);

            var canceller = Task.Run(() => request.Cancel("race"));
            var dequeued = queue.TryDequeue();
            var cancelled = await canceller;

            // Exactly one side wins: either the consumer got a Running request, or the cancel did.
            Assert.True(dequeued is not null ^ cancelled);
            if (dequeued is not null)
            {
                Assert.Equal(RequestState.Running, dequeued.State);
            }
        }
    }

    [Fact]
    public void NewRequestIsQueued_AndCompletionIsPending()
    {
        var request = TestRequests.Make("a", Now);

        Assert.Equal(RequestState.Queued, request.State);
        Assert.False(request.Completion.IsCompleted);
    }

    [Fact]
    public async Task Continuations_DoNotRunInlineInsideComplete()
    {
        var request = TestRequests.Make("a", Now);
        using var released = new ManualResetEventSlim();
        // If the continuation ran inline it would block inside Complete() until the wait times out.
        var continuation = request.Completion.ContinueWith(
            _ => released.Wait(TimeSpan.FromSeconds(10)),
            TaskContinuationOptions.ExecuteSynchronously);

        request.Complete(TestRequests.Json("{}"));
        released.Set();

        Assert.True(await continuation.WaitAsync(TimeSpan.FromSeconds(15), TestContext.Current.CancellationToken));
    }
}
