using Xunit;

namespace RevitMCP.Bridge.Tests;

public class RequestStoreTests
{
    private static readonly DateTimeOffset Now = new(2026, 1, 1, 0, 0, 0, TimeSpan.Zero);

    [Fact]
    public void Store_DuplicateIdReturnsSameRequest()
    {
        var store = new RequestStore(Limits.ResultCapacity);
        var first = TestRequests.Make("dup", Now);
        var second = TestRequests.Make("dup", Now);

        Assert.True(store.TryAdd(first));
        Assert.False(store.TryAdd(second));

        Assert.Same(first, store.Find("dup"));
    }

    [Fact]
    public void Store_EvictsOldestFinished_KeepsRunning()
    {
        var store = new RequestStore(Limits.ResultCapacity);
        var requests = Enumerable.Range(0, Limits.ResultCapacity)
            .Select(i => TestRequests.Make($"r{i}", Now))
            .ToList();
        foreach (var request in requests)
        {
            Assert.True(store.TryAdd(request));
        }

        // r0 stays unfinished (the oldest entry); r1 and r2 finish, so r1 is the oldest finished one.
        requests[1].Complete(TestRequests.Json("{}"));
        requests[2].Fail(-32000, "boom");

        var extra = TestRequests.Make("extra", Now);
        Assert.True(store.TryAdd(extra));

        Assert.Equal(RequestState.Unknown, store.GetState("r1"));
        Assert.Null(store.Find("r1"));
        Assert.Equal(RequestState.Queued, store.GetState("r0"));
        Assert.Equal(RequestState.Failed, store.GetState("r2"));
        Assert.Same(extra, store.Find("extra"));
    }

    [Fact]
    public void Store_AllUnfinished_RefusesNewRequestAndKeepsEverything()
    {
        var store = new RequestStore(Limits.ResultCapacity);
        for (var i = 0; i < Limits.ResultCapacity; i++)
        {
            Assert.True(store.TryAdd(TestRequests.Make($"r{i}", Now)));
        }

        var extra = TestRequests.Make("extra", Now);

        Assert.False(store.TryAdd(extra));
        Assert.Null(store.Find("extra"));
        Assert.Equal(RequestState.Unknown, store.GetState("extra"));
        for (var i = 0; i < Limits.ResultCapacity; i++)
        {
            Assert.NotNull(store.Find($"r{i}"));
        }
    }

    [Fact]
    public void Store_UnknownIdIsUnknown()
    {
        var store = new RequestStore(Limits.ResultCapacity);

        Assert.Equal(RequestState.Unknown, store.GetState("nope"));
        Assert.Null(store.Find("nope"));
    }

    [Fact]
    public void Store_ReportsStateOfStoredRequest()
    {
        var store = new RequestStore(Limits.ResultCapacity);
        var request = TestRequests.Make("a", Now);
        store.TryAdd(request);

        Assert.Equal(RequestState.Queued, store.GetState("a"));
        request.Complete(TestRequests.Json("{}"));
        Assert.Equal(RequestState.Succeeded, store.GetState("a"));
    }

    [Fact]
    public async Task ConcurrentAdds_NeverExceedCapacity()
    {
        const int capacity = 64;
        var store = new RequestStore(capacity);
        var requests = Enumerable.Range(0, 2000).Select(i => TestRequests.Make($"r{i}", Now)).ToList();

        await Task.WhenAll(Enumerable.Range(0, 4).Select(t => Task.Run(() =>
        {
            for (var i = t; i < requests.Count; i += 4)
            {
                requests[i].Complete(TestRequests.Json("{}"));
                Assert.True(store.TryAdd(requests[i]));
            }
        }))).WaitAsync(TimeSpan.FromSeconds(30), TestContext.Current.CancellationToken);

        var held = requests.Count(r => store.Find(r.Id) is not null);
        Assert.Equal(capacity, held);
    }
}
