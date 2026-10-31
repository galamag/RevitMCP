using Autodesk.Revit.UI;
using RevitMCP.Bridge;

namespace RevitMCP.Plugin.Dispatch;

/// <summary>Raises the Revit external event from any thread.</summary>
public sealed class ExternalEventSignal(ExternalEvent externalEvent) : IEventSignal
{
    /// <summary>
    /// <see cref="ExternalEventRequest.Pending"/> counts as accepted: the event already waits to run, and the
    /// handler it runs takes whatever is in the queue by then.
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
public sealed class CommandHandler(RequestQueue queue, CommandRegistry commands) : IExternalEventHandler
{
    /// <summary>The prefix of the error message a request gets when its command needs a document.</summary>
    public const string NoActiveDocument = "no_active_document";

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

            // Requests left behind expire on the bridge's timer, or go with the next request's signal.
            if (queue.Count > 0 && Signal?.Signal() != SignalResult.Accepted)
            {
                Log.Error("Could not raise the external event for the requests still queued.");
            }
        }
        catch (Exception e)
        {
            Log.Error("The command handler failed outside a command.", e);
        }
    }

    private void Run(PendingRequest request, UIApplication app)
    {
        try
        {
            var command = commands.Find(request.Method)
                ?? throw new RequestFailedException(JsonRpcCodes.MethodNotFound, $"No command serves '{request.Method}'.");

            var document = app.ActiveUIDocument?.Document;
            if (command.NeedsDocument && document is null)
            {
                throw new RequestFailedException(
                    JsonRpcCodes.InternalError,
                    $"{NoActiveDocument}: {request.Method} needs an open document, and Revit has no active one.");
            }

            request.Complete(command.Execute(new CommandContext(app, document), request.Params));
        }
        catch (RequestFailedException e)
        {
            request.Fail(e.Code, e.Message);
        }
        catch (Exception e)
        {
            Log.Error($"Request {request.Id} ({request.Method}) failed.", e);
            request.Fail(JsonRpcCodes.InternalError, $"{request.Method} failed: {e.Message}");
        }
    }
}
