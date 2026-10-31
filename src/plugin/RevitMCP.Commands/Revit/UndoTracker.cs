using Autodesk.Revit.ApplicationServices;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Events;

namespace RevitMCP.Commands;

/// <summary>
/// Feeds <see cref="UndoHistory"/> from the document events, for the length of the Revit session. A document is known
/// by <see cref="Document.GetHashCode"/>: the API promises it is the same for every instance of a document open in the
/// session and differs when the file is opened again, so a reopened document cannot inherit a history, while titles
/// repeat. No exception leaves a handler, because they run inside Revit. All of it runs on the main thread.
/// </summary>
public sealed class UndoTracker
{
    /// <summary>The documents between DocumentClosing and DocumentClosed, as only the first of the pair has the document.</summary>
    private readonly Dictionary<int, int> _closing = [];

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
    }

    public void Detach(ControlledApplication application)
    {
        ArgumentNullException.ThrowIfNull(application);

        application.DocumentChanged -= OnDocumentChanged;
        application.DocumentCreated -= OnDocumentCreated;
        application.DocumentOpened -= OnDocumentOpened;
        application.DocumentClosing -= OnDocumentClosing;
        application.DocumentClosed -= OnDocumentClosed;
    }

    private static List<string> Texts(ICollection<ElementId> ids) => ids.Select(id => id.ToString()).ToList();

    private void OnDocumentChanged(object? sender, DocumentChangedEventArgs e) => Guarded(nameof(OnDocumentChanged), () =>
    {
        var document = e.GetDocument();
        var key = KeyOf(document);
        var names = e.GetTransactionNames().ToList();

        switch (e.Operation)
        {
            case UndoOperation.TransactionCommitted:
                History.Committed(key, document.Title, names, Texts(e.GetAddedElementIds()), Texts(e.GetDeletedElementIds()));
                break;

            // What a rolled back group held was committed step by step, so it leaves the history the same way.
            case UndoOperation.TransactionUndone:
            case UndoOperation.TransactionGroupRolledBack:
                History.Undone(key, document.Title, names);
                break;

            case UndoOperation.TransactionRedone:
                History.Redone(key, document.Title, names);
                break;

            // A rolled back transaction never reached the history.
            default:
                break;
        }
    });

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
}
