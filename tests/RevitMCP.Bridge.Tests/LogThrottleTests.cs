using RevitMCP.Commands.Dispatch;
using Xunit;

namespace RevitMCP.Bridge.Tests;

/// <summary>
/// The throttle behind the log lines of <c>CommandHandler.SignalIfQueued</c>. <c>LogThrottle.cs</c> uses no Revit type,
/// so this project compiles it in by a link. How the handler uses it needs Revit and is not covered here.
/// </summary>
public class LogThrottleTests
{
    private static readonly TimeSpan Interval = TimeSpan.FromMinutes(1);

    private readonly FakeTimeProvider _clock = new();
    private readonly LogThrottle _throttle;

    public LogThrottleTests()
    {
        _throttle = new LogThrottle(_clock, Interval);
    }

    [Fact]
    public void ShouldLogFailure_LogsTheFirstFailureAtOnce()
    {
        Assert.True(_throttle.ShouldLogFailure(out var heldBack));
        Assert.Equal(0, heldBack);
    }

    [Fact]
    public void ShouldLogFailure_HoldsBackFailuresInsideTheInterval()
    {
        _throttle.ShouldLogFailure(out _);

        _clock.Advance(TimeSpan.FromSeconds(1));
        Assert.False(_throttle.ShouldLogFailure(out _));

        _clock.Advance(Interval - TimeSpan.FromSeconds(2));
        Assert.False(_throttle.ShouldLogFailure(out _));
    }

    [Fact]
    public void ShouldLogFailure_LogsAgainWhenTheIntervalHasPassedAndSaysHowManyStayedOut()
    {
        _throttle.ShouldLogFailure(out _);
        _clock.Advance(TimeSpan.FromSeconds(1));
        _throttle.ShouldLogFailure(out _);
        _clock.Advance(TimeSpan.FromSeconds(1));
        _throttle.ShouldLogFailure(out _);

        _clock.Advance(Interval);

        Assert.True(_throttle.ShouldLogFailure(out var heldBack));
        Assert.Equal(2, heldBack);
    }

    [Fact]
    public void ShouldLogFailure_LogsExactlyAtTheEndOfTheInterval()
    {
        _throttle.ShouldLogFailure(out _);

        _clock.Advance(Interval);

        Assert.True(_throttle.ShouldLogFailure(out _));
    }

    [Fact]
    public void ShouldLogFailure_CountsFromTheLastLoggedLineNotFromTheFirst()
    {
        _throttle.ShouldLogFailure(out _);
        _clock.Advance(Interval);
        _throttle.ShouldLogFailure(out _);

        _clock.Advance(Interval - TimeSpan.FromSeconds(1));

        Assert.False(_throttle.ShouldLogFailure(out _));
    }

    [Fact]
    public void ShouldLogFailure_OnATimerTickingEverySecondLogsOneLinePerMinute()
    {
        var lines = new List<int>();

        for (var second = 0; second < 150; second++)
        {
            if (_throttle.ShouldLogFailure(out var heldBack))
            {
                lines.Add(heldBack);
            }

            _clock.Advance(TimeSpan.FromSeconds(1));
        }

        Assert.Equal([0, 59, 59], lines);
    }

    [Fact]
    public void ShouldLogFailure_LogsWhenTheClockWasSetBack()
    {
        _throttle.ShouldLogFailure(out _);

        _clock.Advance(-TimeSpan.FromHours(1));

        Assert.True(_throttle.ShouldLogFailure(out _));
    }

    [Fact]
    public void EndsRun_IsFalseWhenNothingFailed()
    {
        Assert.False(_throttle.EndsRun(out var failures));
        Assert.Equal(0, failures);
    }

    [Fact]
    public void EndsRun_ReportsTheRunOnceWithAllItsFailures()
    {
        _throttle.ShouldLogFailure(out _);
        _clock.Advance(TimeSpan.FromSeconds(1));
        _throttle.ShouldLogFailure(out _);
        _clock.Advance(TimeSpan.FromSeconds(1));
        _throttle.ShouldLogFailure(out _);

        Assert.True(_throttle.EndsRun(out var failures));
        Assert.Equal(3, failures);

        Assert.False(_throttle.EndsRun(out var again));
        Assert.Equal(0, again);
    }

    [Fact]
    public void ShouldLogFailure_AfterARecoveryLogsAtOnceAsANewRun()
    {
        _throttle.ShouldLogFailure(out _);
        _clock.Advance(TimeSpan.FromSeconds(1));
        _throttle.ShouldLogFailure(out _);
        _throttle.EndsRun(out _);

        _clock.Advance(TimeSpan.FromSeconds(1));

        Assert.True(_throttle.ShouldLogFailure(out var heldBack));
        Assert.Equal(0, heldBack);

        Assert.True(_throttle.EndsRun(out var failures));
        Assert.Equal(1, failures);
    }
}
