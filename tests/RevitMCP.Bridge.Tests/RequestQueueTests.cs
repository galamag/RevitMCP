using System.Collections.Concurrent;
using Xunit;

namespace RevitMCP.Bridge.Tests;

public class RequestQueueTests
{
    [Fact]
    public void Dequeue_IsFifo()
    {
        var clock = new FakeTimeProvider();
        var queue = new RequestQueue(clock);
        var first = TestRequests.Make("a", clock.GetUtcNow());
        var second = TestRequests.Make("b", clock.GetUtcNow());
        var third = TestRequests.Make("c", clock.GetUtcNow());
        queue.Enqueue(first);
        queue.Enqueue(second);
        queue.Enqueue(third);

        Assert.Same(first, queue.TryDequeue());
        Assert.Same(second, queue.TryDequeue());
        Assert.Same(third, queue.TryDequeue());
        Assert.Null(queue.TryDequeue());
        Assert.Equal(RequestState.Running, first.State);
    }

    [Fact]
    public void Dequeue_SkipsExpired_AndCancelsThem()
    {
        var clock = new FakeTimeProvider();
        var queue = new RequestQueue(clock);
        var old = TestRequests.Make("old", clock.GetUtcNow());
        queue.Enqueue(old);
        clock.Advance(Limits.QueueTtl + TimeSpan.FromSeconds(1));
        var fresh = TestRequests.Make("fresh", clock.GetUtcNow());
        queue.Enqueue(fresh);

        var dequeued = queue.TryDequeue();

        Assert.Same(fresh, dequeued);
        Assert.Equal(RequestState.Cancelled, old.State);
        Assert.Contains("expired", old.CancelReason);
        Assert.True(old.Completion.IsCanceled);
        Assert.Equal(0, queue.Count);
    }

    [Fact]
    public void Dequeue_RequestExactlyAtTtl_IsStillServed()
    {
        var clock = new FakeTimeProvider();
        var queue = new RequestQueue(clock);
        var request = TestRequests.Make("a", clock.GetUtcNow());
        queue.Enqueue(request);
        clock.Advance(Limits.QueueTtl);

        Assert.Same(request, queue.TryDequeue());
    }

    [Fact]
    public void Dequeue_OnlyExpiredRequests_ReturnsNull()
    {
        var clock = new FakeTimeProvider();
        var queue = new RequestQueue(clock);
        var old = TestRequests.Make("old", clock.GetUtcNow());
        queue.Enqueue(old);
        clock.Advance(Limits.QueueTtl + TimeSpan.FromSeconds(1));

        Assert.Null(queue.TryDequeue());
        Assert.Equal(RequestState.Cancelled, old.State);
    }

    [Fact]
    public async Task Count_ExpiresStaleRequestsWithoutDequeue()
    {
        var clock = new FakeTimeProvider();
        var queue = new RequestQueue(clock);
        var stale = TestRequests.Make("stale", clock.GetUtcNow());
        queue.Enqueue(stale);
        clock.Advance(Limits.QueueTtl + TimeSpan.FromSeconds(1));

        Assert.Equal(0, queue.Count);

        Assert.Equal(RequestState.Cancelled, stale.State);
        Assert.Contains("expired", stale.CancelReason);
        Assert.True(stale.Completion.IsCompleted);
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => stale.Completion);
    }

    [Fact]
    public void ExpireStale_CancelsOnlyStaleQueuedRequests_AndReturnsTheirNumber()
    {
        var clock = new FakeTimeProvider();
        var queue = new RequestQueue(clock);
        var running = TestRequests.Make("running", clock.GetUtcNow());
        var stale1 = TestRequests.Make("stale1", clock.GetUtcNow());
        var stale2 = TestRequests.Make("stale2", clock.GetUtcNow());
        queue.Enqueue(running);
        queue.Enqueue(stale1);
        queue.Enqueue(stale2);
        Assert.Same(running, queue.TryDequeue());
        clock.Advance(Limits.QueueTtl + TimeSpan.FromSeconds(1));
        var fresh = TestRequests.Make("fresh", clock.GetUtcNow());
        queue.Enqueue(fresh);

        Assert.Equal(2, queue.ExpireStale());

        Assert.Equal(RequestState.Cancelled, stale1.State);
        Assert.Equal(RequestState.Cancelled, stale2.State);
        Assert.Equal(RequestState.Running, running.State);
        Assert.Equal(RequestState.Queued, fresh.State);
        Assert.Equal(1, queue.Count);
        Assert.Equal(0, queue.ExpireStale());
    }

    [Fact]
    public void OldestQueuedSeconds_And_TryCancel_ApplyTheTtl()
    {
        var clock = new FakeTimeProvider();
        var queue = new RequestQueue(clock);
        var first = TestRequests.Make("first", clock.GetUtcNow());
        var second = TestRequests.Make("second", clock.GetUtcNow());
        queue.Enqueue(first);
        queue.Enqueue(second);
        clock.Advance(Limits.QueueTtl + TimeSpan.FromSeconds(1));

        Assert.Equal(0, queue.OldestQueuedSeconds);
        Assert.Equal(RequestState.Cancelled, first.State);
        Assert.Contains("expired", first.CancelReason);

        Assert.False(queue.TryCancel("second"));
        Assert.Contains("expired", second.CancelReason);
    }

    [Fact]
    public void TryCancel_WorksOnlyWhileQueued()
    {
        var clock = new FakeTimeProvider();
        var queue = new RequestQueue(clock);
        var running = TestRequests.Make("running", clock.GetUtcNow());
        var waiting = TestRequests.Make("waiting", clock.GetUtcNow());
        queue.Enqueue(running);
        queue.Enqueue(waiting);
        Assert.Same(running, queue.TryDequeue());

        Assert.False(queue.TryCancel("running"));
        Assert.Equal(RequestState.Running, running.State);

        Assert.False(queue.TryCancel("nobody"));

        Assert.True(queue.TryCancel("waiting"));
        Assert.Equal(RequestState.Cancelled, waiting.State);
        Assert.False(string.IsNullOrEmpty(waiting.CancelReason));
        Assert.Equal(0, queue.Count);
        Assert.Null(queue.TryDequeue());

        Assert.False(queue.TryCancel("waiting"));
    }

    [Fact]
    public void Dequeue_SkipsRequestsCancelledDirectly()
    {
        var clock = new FakeTimeProvider();
        var queue = new RequestQueue(clock);
        var cancelled = TestRequests.Make("cancelled", clock.GetUtcNow());
        var next = TestRequests.Make("next", clock.GetUtcNow());
        queue.Enqueue(cancelled);
        queue.Enqueue(next);

        cancelled.Cancel("client timeout");

        Assert.Equal(1, queue.Count);
        Assert.Same(next, queue.TryDequeue());
    }

    [Fact]
    public void OldestQueuedSeconds_Grows()
    {
        var clock = new FakeTimeProvider();
        var queue = new RequestQueue(clock);
        Assert.Equal(0, queue.OldestQueuedSeconds);

        queue.Enqueue(TestRequests.Make("a", clock.GetUtcNow()));
        Assert.Equal(0, queue.OldestQueuedSeconds, precision: 3);

        clock.Advance(TimeSpan.FromSeconds(10));
        queue.Enqueue(TestRequests.Make("b", clock.GetUtcNow()));
        Assert.Equal(10, queue.OldestQueuedSeconds, precision: 3);

        clock.Advance(TimeSpan.FromSeconds(5));
        Assert.Equal(15, queue.OldestQueuedSeconds, precision: 3);

        Assert.NotNull(queue.TryDequeue());
        Assert.Equal(5, queue.OldestQueuedSeconds, precision: 3);

        Assert.NotNull(queue.TryDequeue());
        Assert.Equal(0, queue.OldestQueuedSeconds);
    }

    [Fact]
    public void Count_TracksQueuedRequests()
    {
        var clock = new FakeTimeProvider();
        var queue = new RequestQueue(clock);
        Assert.Equal(0, queue.Count);

        queue.Enqueue(TestRequests.Make("a", clock.GetUtcNow()));
        queue.Enqueue(TestRequests.Make("b", clock.GetUtcNow()));
        Assert.Equal(2, queue.Count);

        queue.TryDequeue();
        Assert.Equal(1, queue.Count);
    }

    [Fact]
    public async Task ConcurrentProducersAndConsumers_DeliverEachRequestExactlyOnce()
    {
        const int producers = 4;
        const int perProducer = 500;
        const int total = producers * perProducer;
        var clock = new FakeTimeProvider();
        var queue = new RequestQueue(clock);
        var seen = new ConcurrentDictionary<string, int>();
        var consumed = 0;

        var produce = Enumerable.Range(0, producers).Select(p => Task.Run(() =>
        {
            for (var i = 0; i < perProducer; i++)
            {
                queue.Enqueue(TestRequests.Make($"{p}-{i}", clock.GetUtcNow()));
            }
        }));
        var consume = Enumerable.Range(0, 4).Select(_ => Task.Run(() =>
        {
            while (Volatile.Read(ref consumed) < total)
            {
                var request = queue.TryDequeue();
                if (request is null)
                {
                    Thread.Yield();
                    continue;
                }

                seen.AddOrUpdate(request.Id, 1, (_, n) => n + 1);
                Interlocked.Increment(ref consumed);
            }
        }));

        await Task.WhenAll(produce.Concat(consume)).WaitAsync(TimeSpan.FromSeconds(30), TestContext.Current.CancellationToken);

        Assert.Equal(total, seen.Count);
        Assert.All(seen.Values, n => Assert.Equal(1, n));
    }
}
