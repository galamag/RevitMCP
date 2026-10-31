using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitMCP.Bridge;

namespace RevitMCP.Commands.Dispatch;

/// <summary>Raises the Revit external event. <c>Raise</c> is the only Revit call allowed off the main thread.</summary>
public sealed class ExternalEventSignal(ExternalEvent externalEvent) : IEventSignal
{
    /// <summary>
    /// <see cref="ExternalEventRequest.Pending"/> counts as accepted, because an event is already waiting to run.
    /// Whether that run still sees a request queued just now is unverified: the API does not say when the flag
    /// clears, so a signal can go unserved. <see cref="CommandHandler.SignalIfQueued"/> on a timer is the fallback.
    /// </summary>
    public SignalResult Signal() => externalEvent.Raise() switch
    {
        ExternalEventRequest.Accepted or ExternalEventRequest.Pending => SignalResult.Accepted,
        _ => SignalResult.Denied,
    };
}

/// <summary>
/// Serves the queue on the Revit main thread, one request per call, so Revit gets control back between requests.
/// No exception leaves <see cref="Execute"/>: Revit denies an event whose handler failed.
/// </summary>
public sealed class CommandHandler(RequestQueue queue, CommandRegistry commands, DialogGuard dialogGuard) : IExternalEventHandler
{
    /// <summary>The prefix of the error message a request gets when its command needs a document.</summary>
    public const string NoActiveDocument = "no_active_document";

    /// <summary>How often a refusal that lasts reaches the log, after the first one.</summary>
    private static readonly TimeSpan RefusalLogInterval = TimeSpan.FromMinutes(1);

    private readonly LogThrottle _refusals = new(TimeProvider.System, RefusalLogInterval);

    private int _signalling;

    /// <summary>Raises the event again while requests wait. Set it before the event can first be raised.</summary>
    public IEventSignal? Signal { get; set; }

    public string GetName() => "RevitMCP command handler";

    public void Execute(UIApplication app)
    {
        try
        {
            if (queue.TryDequeue() is { } request)
            {
                Run(request, app);
            }
        }
        catch (Exception e)
        {
            Log.Error("The command handler failed outside a command.", e);
        }

        SignalIfQueued();
    }

    /// <summary>
    /// Raises the event while requests wait: at the end of <see cref="Execute"/>, and on a timer as the fallback
    /// for a signal that went unserved or was refused. Runs on any thread and never throws, so it must call no
    /// Revit API except through <see cref="Signal"/>, whose <c>Raise</c> is the one call allowed off the main thread.
    /// A refusal that lasts would fill the log at one line per tick, so the log gets the first refusal, then at most
    /// one line a minute, and one line when Raise works again.
    /// </summary>
    public void SignalIfQueued()
    {
        // Skips the tick instead of waiting, so a slow Raise cannot stack up a pool thread per tick.
        if (Interlocked.Exchange(ref _signalling, 1) == 1)
        {
            return;
        }

        try
        {
            if (queue.Count > 0)
            {
                if (Signal?.Signal() == SignalResult.Accepted)
                {
                    ReportRaised();
                }
                else
                {
                    ReportRefusal("Could not raise the external event for the requests still queued. The timer tries again.", null);
                }
            }
        }
        catch (Exception e)
        {
            ReportRefusal("Raising the external event failed. The timer tries again.", e);
        }
        finally
        {
            Volatile.Write(ref _signalling, 0);
        }
    }

    private void ReportRefusal(string message, Exception? exception)
    {
        if (_refusals.ShouldLogFailure(out var heldBack))
        {
            Log.Error(heldBack > 0 ? $"{message} {heldBack} refusals since the last line stayed out of the log." : message, exception);
        }
    }

    private void ReportRaised()
    {
        if (_refusals.EndsRun(out var refusals))
        {
            Log.Info($"The external event can be raised again, after {refusals} refused attempts.");
        }
    }

    /// <summary>A command that needs no document must still run when Revit cannot say which one is active.</summary>
    private static Document? FindActiveDocument(UIApplication app)
    {
        try
        {
            return app.ActiveUIDocument?.Document;
        }
        catch (Exception e)
        {
            Log.Error("Could not read the active document, so the request runs without one.", e);
            return null;
        }
    }

    private void Run(PendingRequest request, UIApplication app)
    {
        try
        {
            var command = commands.Find(request.Method)
                ?? throw new RequestFailedException(JsonRpcCodes.MethodNotFound, $"No command serves '{request.Method}'.");

            var document = FindActiveDocument(app);
            if (command.NeedsDocument && document is null)
            {
                throw new RequestFailedException(
                    JsonRpcCodes.InternalError,
                    $"{NoActiveDocument}: {request.Method} needs an open document, and Revit has no active one.");
            }

            using (dialogGuard.Activate())
            {
                request.Complete(command.Execute(new CommandContext(app, document), request.Params));
            }
        }
        catch (RequestFailedException e)
        {
            request.Fail(e.Code, e.Message);
        }
        catch (Exception e)
        {
            Log.Error($"Request {Log.Clean(request.Id)} ({request.Method}) failed.", e);
            request.Fail(JsonRpcCodes.InternalError, $"{request.Method} failed: {e.Message}");
        }
    }
}
