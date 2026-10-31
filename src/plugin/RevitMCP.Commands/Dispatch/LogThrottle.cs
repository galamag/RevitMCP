namespace RevitMCP.Commands.Dispatch;

/// <summary>
/// Decides which failures of a repeating attempt reach the log, so that a timer ticking every second cannot fill the
/// disk while the cause lasts. The first failure of a run is logged, the later ones at most once per
/// <c>interval</c>, and the end of a run is reported once. A run ends on a success, or when nothing is left to attempt,
/// and the caller says which. It decides only: the caller writes the lines.
/// Uses no Revit type and is safe on any thread.
/// </summary>
internal sealed class LogThrottle(TimeProvider clock, TimeSpan interval)
{
    private readonly object _gate = new();
    private bool _failing;
    private int _failures;
    private int _heldBack;
    private DateTimeOffset _lastLogged;

    /// <summary>
    /// Counts one failure. Returns <c>false</c> when it stays out of the log. Returns <c>true</c> when the caller logs it,
    /// and then <paramref name="heldBack"/> is how many failures since the previous line stayed out.
    /// </summary>
    public bool ShouldLogFailure(out int heldBack)
    {
        lock (_gate)
        {
            var now = clock.GetUtcNow();
            _failures++;

            // A clock set back gives a negative age. That line is overdue, and waiting out the set-back would hide the run.
            var age = now - _lastLogged;
            if (_failing && age >= TimeSpan.Zero && age < interval)
            {
                _heldBack++;
                heldBack = 0;
                return false;
            }

            heldBack = _heldBack;
            _heldBack = 0;
            _failing = true;
            _lastLogged = now;
            return true;
        }
    }

    /// <summary>
    /// Ends the run: call it on a success, and when there is nothing left to attempt, as a run must not stay open for
    /// ever. Returns <c>true</c> once when a run of failures was open, and then <paramref name="failures"/> is its length,
    /// the held-back ones included. Returns <c>false</c> when no run was open. The next failure starts a new run and is
    /// logged at once.
    /// </summary>
    public bool EndsRun(out int failures)
    {
        lock (_gate)
        {
            failures = _failures;
            var ended = _failing;

            _failing = false;
            _failures = 0;
            _heldBack = 0;
            return ended;
        }
    }
}
