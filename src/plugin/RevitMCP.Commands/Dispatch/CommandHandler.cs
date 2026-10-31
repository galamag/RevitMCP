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
            if (queue.Count > 0 && Signal?.Signal() != SignalResult.Accepted)
            {
                Log.Error("Could not raise the external event for the requests still queued. The timer tries again.");
            }
        }
        catch (Exception e)
        {
            Log.Error("Raising the external event failed. The timer tries again.", e);
        }
        finally
        {
            Volatile.Write(ref _signalling, 0);
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
