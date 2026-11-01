using Autodesk.Revit.ApplicationServices;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Events;

namespace RevitMCP.Commands;

/// <summary>
/// Feeds <see cref="UndoHistory"/> from the document events, for the length of the Revit session. A document is known
/// by <see cref="Document.GetHashCode"/>: the API promises it is the same for every instance of a document open in the
/// session and differs when the file is opened again, so a reopened document cannot inherit a history, while titles
/// repeat. No exception leaves a handler, because they run inside Revit. An event that could not be recorded makes undo
/// refuse instead, see <see cref="UndoHistory.Track"/>. All of it runs on the main thread.
/// </summary>
public sealed class UndoTracker
{
    /// <summary>The documents between DocumentClosing and DocumentClosed, as only the first of the pair has the document.</summary>
    private readonly Dictionary<int, int> _closing = [];

    /// <summary>The tracker of this Revit session. <see cref="EditScopeOperation"/> tells it about a scope from here, as it is static like <see cref="Operation"/>.</summary>
    internal static UndoTracker? Attached { get; private set; }

    internal UndoHistory History { get; } = new(TimeProvider.System);

    /// <summary>The key of a document in <see cref="History"/>.</summary>
    internal static int KeyOf(Document document) => document.GetHashCode();

    public void Attach(ControlledApplication application)
    {
        ArgumentNullException.ThrowIfNull(application);

        application.DocumentChanged += OnDocumentChanged;
        application.DocumentCreated += OnDocumentCreated;
        application.DocumentOpened += OnDocumentOpened;
        application.DocumentClosing += OnDocumentClosing;
        application.DocumentClosed += OnDocumentClosed;
        Attached = this;
    }

    public void Detach(ControlledApplication application)
    {
        ArgumentNullException.ThrowIfNull(application);

        Attached = null;
        application.DocumentChanged -= OnDocumentChanged;
        application.DocumentCreated -= OnDocumentCreated;
        application.DocumentOpened -= OnDocumentOpened;
        application.DocumentClosing -= OnDocumentClosing;
        application.DocumentClosed -= OnDocumentClosed;
    }

    /// <summary>Marks an edit scope around its commits, see <see cref="UndoHistory.BeginScope"/>. Disposing the result ends the mark.</summary>
    internal IDisposable MarkScope(Document document, string transactionName)
    {
        var key = KeyOf(document);
        History.BeginScope(key, transactionName);

        return new ScopeMark(History, key);
    }

    private static List<string> Texts(ICollection<ElementId> ids) => ids.Select(id => id.ToString()).ToList();

    private void OnDocumentChanged(object? sender, DocumentChangedEventArgs e) => Guarded(nameof(OnDocumentChanged), () =>
        History.Track(() => KeyOf(e.GetDocument()), key => Record(e, key)));

    private void Record(DocumentChangedEventArgs e, int key)
    {
        var title = e.GetDocument().Title;
        var names = e.GetTransactionNames().ToList();

        switch (e.Operation)
        {
            case UndoOperation.TransactionCommitted:
                History.Committed(key, title, names, Texts(e.GetAddedElementIds()), Texts(e.GetDeletedElementIds()));
                break;

            case UndoOperation.TransactionUndone:
                if (History.Undone(key, title, names) is { } refused)
                {
                    Log.Error(
                        $"An undo took '{Log.Clean(string.Join(", ", names))}' after undo {refused.Id} of '{Log.Clean(refused.Step.Name)}' was reported as refused by Revit. "
                        + "Either a person undid this in Revit, or the refused undo ran after all and the report was wrong.");
                }

                break;

            // What a rolled back group held was committed step by step, so it leaves the history the same way.
            case UndoOperation.TransactionGroupRolledBack:
                History.RolledBack(key, title, names);
                break;

            case UndoOperation.TransactionRedone:
                History.Redone(key, title, names);
                break;

            // A rolled back transaction never reached the history. Live Revit raises this event for one, as for a dry run.
            default:
                break;
        }
    }

    private void OnDocumentCreated(object? sender, DocumentCreatedEventArgs e) => Guarded(nameof(OnDocumentCreated), () => Reset(e.Document));

    private void OnDocumentOpened(object? sender, DocumentOpenedEventArgs e) => Guarded(nameof(OnDocumentOpened), () => Reset(e.Document));

    private void OnDocumentClosing(object? sender, DocumentClosingEventArgs e) => Guarded(nameof(OnDocumentClosing), () =>
    {
        _closing[e.DocumentId] = KeyOf(e.Document);
    });

    /// <summary>Revit raises this for a close that failed or was cancelled too, and then the history still holds.</summary>
    private void OnDocumentClosed(object? sender, DocumentClosedEventArgs e) => Guarded(nameof(OnDocumentClosed), () =>
    {
        if (_closing.Remove(e.DocumentId, out var key) && e.Status == RevitAPIEventStatus.Succeeded)
        {
            History.Forget(key);
        }
    });

    /// <summary>A failed open or create raises the event with no document.</summary>
    private void Reset(Document? document)
    {
        if (document is not null)
        {
            History.Forget(KeyOf(document));
        }
    }

    private static void Guarded(string handler, Action body)
    {
        try
        {
            body();
        }
        catch (Exception e)
        {
            Log.Error($"The undo tracker failed in {handler}, so its history may be behind Revit's.", e);
        }
    }

    private sealed class ScopeMark(UndoHistory history, int key) : IDisposable
    {
        public void Dispose() => history.EndScope(key);
    }
}
