namespace RevitMCP.Commands;

/// <summary>
/// One step of a document's undo history as the events reported it. <paramref name="CreatedIds"/> and
/// <paramref name="DeletedIds"/> stay empty for a step the history lost track of and saw again only by its name.
/// </summary>
internal sealed record UndoStep(
    string Name,
    int Document,
    string DocumentTitle,
    long Sequence,
    IReadOnlyList<string> CreatedIds,
    IReadOnlyList<string> DeletedIds)
{
    /// <summary><c>Operation.Run</c> names its transactions with this prefix, and nothing else in Revit is known to.</summary>
    public const string OurPrefix = "MCP: ";

    public bool IsOurs => Name.StartsWith(OurPrefix, StringComparison.Ordinal);
}

/// <summary>What <see cref="UndoHistory.Decide"/> answers.</summary>
internal enum UndoVerdict
{
    /// <summary><see cref="UndoDecision.Step"/> is ours and on top, and its document is active.</summary>
    Allowed,

    /// <summary>The active document has no step, and these tools have no step anywhere.</summary>
    Empty,

    /// <summary><see cref="UndoDecision.Step"/> is on top of the active document and is not ours.</summary>
    NotOurs,

    /// <summary><see cref="UndoDecision.Step"/> is our last operation, and its document is not the active one.</summary>
    OtherDocument,

    /// <summary><see cref="UndoDecision.Step"/> is what an earlier undo set out to take, which nobody saw happen yet.</summary>
    Unconfirmed,
}

/// <summary><see cref="Step"/> is null only for <see cref="UndoVerdict.Empty"/>.</summary>
internal sealed record UndoDecision(UndoVerdict Verdict, UndoStep? Step);

/// <summary>One Undo posted to Revit. <see cref="Undone"/> turns true when the event of that undo arrives.</summary>
internal sealed record UndoAttempt(long Id, UndoStep Step, DateTimeOffset PostedAt, bool Undone);

/// <summary>
/// A copy of Revit's undo history, one per open document, because the API cannot read the real one. It is kept from
/// the document events alone, so it can only be as right as they are: live Revit matched it in every probe. Where it
/// loses track it forgets what lay below, in the direction of refusing: a step that says "ours" must never be wrong,
/// since Undo takes whatever is on top of the real history. No Revit type appears here, so the tests can compile this
/// file. All of it runs on the Revit main thread.
/// </summary>
internal sealed class UndoHistory(TimeProvider clock)
{
    /// <summary>
    /// How long an unseen undo blocks the next one. It stands in for "Revit dropped it", which nothing reports. A posted
    /// command once waited 28 s, and the next request through the external event always let it run first, so a block
    /// longer than that is only reached when Revit really dropped the command.
    /// </summary>
    public static readonly TimeSpan ConfirmWindow = TimeSpan.FromSeconds(60);

    /// <summary>Stands for steps the history cannot name. It is not ours, so undo stops there.</summary>
    private const string UnknownStep = "(unknown steps)";

    private readonly Dictionary<int, Document> _documents = [];
    private long _sequence;
    private long _attempts;

    /// <summary>The undo posted last in this Revit session, whatever became of it.</summary>
    public UndoAttempt? LastAttempt { get; private set; }

    /// <summary>A transaction landed. A new step always ends what could be redone.</summary>
    public void Committed(int document, string title, IReadOnlyList<string> names, IReadOnlyList<string> createdIds, IReadOnlyList<string> deletedIds)
    {
        var history = HistoryOf(document);
        history.Redoable.Clear();

        // "Typically only one" name, says the API. Ids cannot be split between several, so the last one carries them.
        var steps = names.Count == 0 ? [UnknownStep] : names;
        foreach (var (name, index) in steps.Select((name, index) => (name, index)))
        {
            var last = index == steps.Count - 1;
            history.Done.Add(NewStep(name, document, title, last ? createdIds : [], last ? deletedIds : []));
        }
    }

    /// <summary>Steps came off the top, by the undo of anyone: a posted one, the user's, or a rolled back group.</summary>
    public void Undone(int document, string title, IReadOnlyList<string> names)
    {
        var history = HistoryOf(document);
        var taken = TakeTop(history.Done, names);
        if (taken is null)
        {
            history.Done.Clear();
            history.Redoable.Clear();
            history.Done.Add(NewStep(UnknownStep, document, title, [], []));
            return;
        }

        history.Redoable.AddRange(taken);

        if (LastAttempt is { Undone: false } attempt
            && attempt.Step.Document == document
            && taken.Any(step => step.Sequence == attempt.Step.Sequence))
        {
            LastAttempt = attempt with { Undone = true };
        }
    }

    /// <summary>Steps came back, which only a person can do. A step the history cannot find comes back by name alone.</summary>
    public void Redone(int document, string title, IReadOnlyList<string> names)
    {
        var history = HistoryOf(document);
        var taken = TakeTop(history.Redoable, names);
        if (taken is null)
        {
            history.Redoable.Clear();
            history.Done.AddRange(names.Select(name => NewStep(name, document, title, [], [])));
            return;
        }

        history.Done.AddRange(taken);
    }

    /// <summary>The document closed or was opened anew, and Revit keeps no undo history across that.</summary>
    public void Forget(int document) => _documents.Remove(document);

    /// <summary>
    /// Decides whether Undo in <paramref name="activeDocument"/> would take our last operation. Undo acts on the active
    /// document and takes its top step, so that step has to be our last operation of all, and nothing may be on its way.
    /// </summary>
    public UndoDecision Decide(int activeDocument)
    {
        if (LastAttempt is { Undone: false } attempt && clock.GetUtcNow() - attempt.PostedAt < ConfirmWindow)
        {
            return new UndoDecision(UndoVerdict.Unconfirmed, attempt.Step);
        }

        var lastOurs = _documents.Values
            .SelectMany(history => history.Done)
            .Where(step => step.IsOurs)
            .MaxBy(step => step.Sequence);
        if (lastOurs is not null && lastOurs.Document != activeDocument)
        {
            return new UndoDecision(UndoVerdict.OtherDocument, lastOurs);
        }

        var top = _documents.GetValueOrDefault(activeDocument)?.Done.LastOrDefault();
        if (top is null)
        {
            return new UndoDecision(UndoVerdict.Empty, null);
        }

        return new UndoDecision(top.IsOurs ? UndoVerdict.Allowed : UndoVerdict.NotOurs, top);
    }

    /// <summary>Records an Undo just posted, to take <paramref name="step"/>.</summary>
    public UndoAttempt Posted(UndoStep step)
    {
        LastAttempt = new UndoAttempt(++_attempts, step, clock.GetUtcNow(), false);
        return LastAttempt;
    }

    /// <summary>
    /// Takes as many steps as there are <paramref name="names"/> off <paramref name="stack"/>, nearest first. Returns
    /// null, with <paramref name="stack"/> as it was, when they are not the steps the event names, in any order: the API
    /// does not say in which order several names come.
    /// </summary>
    private static List<UndoStep>? TakeTop(List<UndoStep> stack, IReadOnlyList<string> names)
    {
        if (names.Count == 0 || names.Count > stack.Count)
        {
            return null;
        }

        var taken = stack.TakeLast(names.Count).Reverse().ToList();
        if (!taken.Select(step => step.Name).Order(StringComparer.Ordinal).SequenceEqual(names.Order(StringComparer.Ordinal)))
        {
            return null;
        }

        stack.RemoveRange(stack.Count - names.Count, names.Count);
        return taken;
    }

    private UndoStep NewStep(string name, int document, string title, IReadOnlyList<string> createdIds, IReadOnlyList<string> deletedIds) =>
        new(name, document, title, ++_sequence, createdIds, deletedIds);

    private Document HistoryOf(int document)
    {
        if (!_documents.TryGetValue(document, out var history))
        {
            history = new Document();
            _documents[document] = history;
        }

        return history;
    }

    /// <summary>The two stacks of one document, tops last.</summary>
    private sealed class Document
    {
        public List<UndoStep> Done { get; } = [];

        public List<UndoStep> Redoable { get; } = [];
    }
}
