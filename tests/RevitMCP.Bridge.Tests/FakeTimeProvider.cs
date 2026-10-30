namespace RevitMCP.Bridge.Tests;

/// <summary>Hand-written <see cref="TimeProvider"/> whose clock only moves when a test advances it.</summary>
internal sealed class FakeTimeProvider(DateTimeOffset start) : TimeProvider
{
    private readonly object _gate = new();
    private DateTimeOffset _now = start;

    public FakeTimeProvider()
        : this(new DateTimeOffset(2026, 1, 1, 0, 0, 0, TimeSpan.Zero))
    {
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
        lock (_gate)
        {
            _now += by;
        }
    }
}
