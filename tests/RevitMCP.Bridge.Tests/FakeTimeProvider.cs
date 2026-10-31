namespace RevitMCP.Bridge.Tests;

/// <summary>
/// Hand-written <see cref="TimeProvider"/> whose clock only moves when a test advances it.
/// Timers made through it fire inside <see cref="Advance"/>, never in real time.
/// </summary>
internal sealed class FakeTimeProvider(DateTimeOffset start) : TimeProvider
{
    private readonly object _gate = new();
    private readonly List<FakeTimer> _timers = [];
    private DateTimeOffset _now = start;

    public FakeTimeProvider()
        : this(new DateTimeOffset(2026, 1, 1, 0, 0, 0, TimeSpan.Zero))
    {
    }

    /// <summary>How many timers were created and not disposed yet.</summary>
    public int ActiveTimers
    {
        get
        {
            lock (_gate)
            {
                return _timers.Count;
            }
        }
    }

    public override DateTimeOffset GetUtcNow()
    {
        lock (_gate)
        {
            return _now;
        }
    }

    public void Advance(TimeSpan by)
    {
        List<FakeTimer> due;
        lock (_gate)
        {
            _now += by;
            due = _timers.Where(timer => timer.NextDue <= _now).ToList();
            foreach (var timer in due)
            {
                timer.NextDue = timer.Period == Timeout.InfiniteTimeSpan ? DateTimeOffset.MaxValue : _now + timer.Period;
            }
        }

        foreach (var timer in due)
        {
            timer.Fire();
        }
    }

    public override ITimer CreateTimer(TimerCallback callback, object? state, TimeSpan dueTime, TimeSpan period)
    {
        lock (_gate)
        {
            var timer = new FakeTimer(this, callback, state, _now + dueTime, period);
            _timers.Add(timer);
            return timer;
        }
    }

    private void Remove(FakeTimer timer)
    {
        lock (_gate)
        {
            _timers.Remove(timer);
        }
    }

    private sealed class FakeTimer(
        FakeTimeProvider owner,
        TimerCallback callback,
        object? state,
        DateTimeOffset nextDue,
        TimeSpan period) : ITimer
    {
        public DateTimeOffset NextDue { get; set; } = nextDue;

        public TimeSpan Period { get; } = period;

        public void Fire() => callback(state);

        public bool Change(TimeSpan dueTime, TimeSpan period) => throw new NotSupportedException();

        public void Dispose() => owner.Remove(this);

        public ValueTask DisposeAsync()
        {
            Dispose();
            return ValueTask.CompletedTask;
        }
    }
}
