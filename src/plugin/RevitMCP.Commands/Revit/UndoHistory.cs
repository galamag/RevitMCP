namespace RevitMCP.Commands;

/// <summary>
/// One step of a document's undo history as the events reported it. <paramref name="CreatedIds"/> and
/// <paramref name="DeletedIds"/> are kept for our steps only, and stay empty for a step the history lost track of and
/// saw again only by its name.
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

    /// <summary>Stands for steps the history cannot name. It is not ours, so undo stops there.</summary>
    public const string UnknownName = "(unknown steps)";

    public bool IsOurs => Name.StartsWith(OurPrefix, StringComparison.Ordinal);

    public bool IsUnknown => Name == UnknownName;
}

/// <summary>What <see cref="UndoHistory.Decide"/> answers.</summary>
internal enum UndoVerdict
{
    /// <summary><see cref="UndoDecision.Step"/> is ours and on top, and its document is active.</summary>
    Allowed,

    /// <summary>The active document has no step, and these tools have no step anywhere.</summary>
    Empty,

    /// <summary>
    /// <see cref="UndoDecision.Step"/> is on top of the active document and is not ours, and
    /// <see cref="UndoDecision.Ours"/> really lies below it, under <see cref="UndoDecision.StepsAbove"/> known steps.
    /// </summary>
    NotOurs,

    /// <summary><see cref="UndoDecision.Step"/> is on top of the active document, and nothing of ours lies below it.</summary>
    NothingOfOurs,

    /// <summary>The history of the active document stops at an unknown step before it reaches anything of ours.</summary>
    HistoryLost,

    /// <summary>An event of the active document could not be recorded, so its history cannot be trusted at all.</summary>
    TrackingFailed,

    /// <summary><see cref="UndoDecision.Step"/> is our last operation, and its document is not the active one.</summary>
    OtherDocument,

    /// <summary><see cref="UndoDecision.Step"/> is what an earlier undo set out to take, and that undo is not settled.</summary>
    Unconfirmed,
}

/// <summary><see cref="Step"/> is null only for <see cref="UndoVerdict.Empty"/> and <see cref="UndoVerdict.TrackingFailed"/>.</summary>
internal sealed record UndoDecision(UndoVerdict Verdict, UndoStep? Step, UndoStep? Ours = null, int StepsAbove = 0)
{
    /// <summary>
    /// Says why undo is refused and what can be done. Only <see cref="UndoVerdict.NotOurs"/> sends the caller to the
    /// user: everywhere else the user's undo would cost them their work and change nothing here.
    /// </summary>
    public string Explain(string activeTitle) => this switch
    {
        { Verdict: UndoVerdict.Unconfirmed, Step: { } step } =>
            $"an earlier undo of '{step.Name}' in '{step.DocumentTitle}' is not settled, and two must not overlap. Nothing was undone by this call. "
            + "Ask get_last_undo_result what became of it. If Revit refused it, undo is possible again at once, and otherwise one minute after that undo was posted.",
        { Verdict: UndoVerdict.OtherDocument, Step: { } step } =>
            $"the last operation of these tools, '{step.Name}', lies in '{step.DocumentTitle}', and the active project is '{activeTitle}'. Undo acts on the active project only. "
            + "Nothing was undone. Use open_project to make that project active first.",
        { Verdict: UndoVerdict.NotOurs, Step: { } step, Ours: { } ours, StepsAbove: var above } =>
            $"the last change in '{step.DocumentTitle}' is '{step.Name}', which did not come from these tools, and Undo would take that. Nothing was undone. "
            + $"Changes that lie above the last operation of these tools, '{ours.Name}': {above}. Only the user can undo those, in Revit, and that loses them, so ask whether they want that. If they do, try again afterwards.",
        { Verdict: UndoVerdict.NothingOfOurs, Step: { } step } =>
            $"the last change in '{step.DocumentTitle}' is '{step.Name}', which did not come from these tools, and no operation of these tools lies below it, so this tool has nothing to undo here. Nothing was undone. "
            + "Do not ask the user to undo that change for this: they would lose it, and there would still be nothing to undo.",
        { Verdict: UndoVerdict.HistoryLost } =>
            $"the undo history of '{activeTitle}' was lost: it no longer matches what Revit holds, so nothing can say what Undo would take. Nothing was undone. "
            + "Undo is unavailable here until the next operation of these tools in this project, and it then reaches that operation only. Do not ask the user to undo anything for this: it would not help.",
        { Verdict: UndoVerdict.TrackingFailed } =>
            $"recording the changes of '{activeTitle}' failed, see plugin.log, so nothing can say what Undo would take. Nothing was undone. "
            + "Undo is unavailable here until this project is closed and opened again. Do not ask the user to undo anything for this: it would not help.",
        _ => $"there is nothing to undo in '{activeTitle}': no operation of these tools is in its history. A project opened or created in this Revit session starts with an empty history.",
    };
}

/// <summary>What became of a posted Undo, as far as the events say.</summary>
internal enum UndoOutcome
{
    /// <summary>No event yet.</summary>
    Waiting,

    /// <summary>The event of that undo arrived, and it took the step it was posted for.</summary>
    Undone,

    /// <summary>While it waited, an undo took something else. <see cref="UndoAttempt.Other"/> says what.</summary>
    Other,

    /// <summary>While it waited, an event could not be recorded, so it may have happened.</summary>
    Unknown,

    /// <summary>
    /// It was still waiting when <see cref="UndoHistory.SettleLastAttempt"/> asked, and by then Revit had given it its turn,
    /// so Revit refused it and the model did not change. Live Revit writes that refusal to its journal only, as
    /// <c>API queue command ID_BUTTON_UNDO cannot be invoked in this context</c>, and raises no event.
    /// </summary>
    Refused,
}

/// <summary>
/// One Undo posted to Revit, to take <see cref="Step"/>. <see cref="Other"/> is set with <see cref="UndoOutcome.Other"/>,
/// and its <see cref="UndoStep.Sequence"/> means nothing: it describes what came off, which may be no step of the history.
/// </summary>
internal sealed record UndoAttempt(long Id, UndoStep Step, DateTimeOffset PostedAt, UndoOutcome Outcome, UndoStep? Other = null);

/// <summary>
/// A copy of Revit's undo history, one per open document, because the API cannot read the real one. It is kept from
/// the document events alone, so it can only be as right as they are: live Revit matched it in every probe, except for
/// a transaction group, whose steps it reports one by one and then undoes under the name of the group. An edit scope does
/// the same, and is told apart by <see cref="BeginScope"/>. Where it loses track it forgets what lay below, in the
/// direction of refusing: a step that says "ours" must never be wrong, since Undo takes whatever is on top of the real
/// history. No Revit type appears here, so the tests can compile this file.
/// All of it runs on the Revit main thread.
/// </summary>
internal sealed class UndoHistory(TimeProvider clock)
{
    /// <summary>The most steps kept for one document. What falls off the bottom becomes one unknown step.</summary>
    public const int MaxDepth = 200;

    /// <summary>
    /// How long an undo that nothing settled blocks the next one, so that two never overlap. A posted command once
    /// waited 28 s, and the next request through the external event always let it run first, so
    /// <see cref="SettleLastAttempt"/> ends the wait for an undo Revit refused long before this does.
    /// </summary>
    public static readonly TimeSpan ConfirmWindow = TimeSpan.FromSeconds(60);

    private readonly Dictionary<int, Document> _documents = [];

    /// <summary>The documents that reset since <see cref="_allLost"/> was set, so they are clean again.</summary>
    private readonly HashSet<int> _resetSinceLoss = [];

    /// <summary>An event failed before it could name its document, so no document open then can be trusted.</summary>
    private bool _allLost;

    private long _sequence;
    private long _attempts;

    /// <summary>The undo settled as refused last, until an undo event may have proved that wrong.</summary>
    private UndoAttempt? _refused;

    /// <summary>The undo posted last in this Revit session, whatever became of it.</summary>
    public UndoAttempt? LastAttempt { get; private set; }

    /// <summary>
    /// Records one event. If that fails, the event is lost, and with it the knowledge of what is on top of the real
    /// history, so <see cref="Decide"/> refuses from then on, until the document resets: for that document when
    /// <paramref name="readDocument"/> got as far as naming it, and for every document otherwise. The exception goes on
    /// to the caller, who logs it.
    /// </summary>
    public void Track(Func<int> readDocument, Action<int> record)
    {
        int? document = null;
        try
        {
            document = readDocument();
            record(document.Value);
        }
        catch
        {
            LoseTrack(document);
            throw;
        }
    }

    /// <summary>
    /// A transaction landed. A new step always ends what could be redone. Only a single name can be trusted as one
    /// step: the API does not say what several mean, and if they were one real step, a top that reads as ours would also
    /// take the steps named before it.
    /// </summary>
    public void Committed(int document, string title, IReadOnlyList<string> names, IReadOnlyList<string> createdIds, IReadOnlyList<string> deletedIds)
    {
        var history = HistoryOf(document);
        history.Redoable.Clear();

        if (history.Scope is { } scope)
        {
            Fold(history, scope, document, title, createdIds, deletedIds);
            return;
        }

        var name = names.Count == 1 ? names[0] : UndoStep.UnknownName;
        var ours = NewStep(name, document, title, [], []).IsOurs;
        history.Done.Add(NewStep(name, document, title, ours ? createdIds : [], ours ? deletedIds : []));
        Trim(history, document, title);
    }

    /// <summary>
    /// An edit scope opens on <paramref name="document"/>. Revit reports each transaction of a scope as a commit of its
    /// own, the last one under a name in the language of the interface, and then undoes them all as one step named after
    /// the scope. So until <see cref="EndScope"/> every commit there is folded into one step called
    /// <paramref name="name"/>, whatever its own name says, with the ids of all of them.
    /// </summary>
    public void BeginScope(int document, string name) => HistoryOf(document).Scope = new OpenScope(name);

    /// <summary>The edit scope on <paramref name="document"/> has closed, committed or not.</summary>
    public void EndScope(int document) => HistoryOf(document).Scope = null;

    /// <summary>
    /// Steps came off the top by an undo: a posted one or the user's. An undo that took anything but the step an
    /// unsettled attempt was posted for is recorded on that attempt, as saying "not undone" then would be false.
    /// Returns, for the log, the undo reported as refused when this event may be that undo after all, as then what was
    /// reported about it was wrong. Nothing tells that apart from an undo by the user.
    /// </summary>
    public UndoAttempt? Undone(int document, string title, IReadOnlyList<string> names)
    {
        var taken = TakeOff(document, title, names);

        if (LastAttempt is not { Outcome: UndoOutcome.Waiting } attempt)
        {
            return ReviseRefusal(taken);
        }

        if (taken?.Any(step => step.Sequence == attempt.Step.Sequence) == true)
        {
            LastAttempt = attempt with { Outcome = UndoOutcome.Undone };
        }
        else if (IsWithinWindow(attempt))
        {
            LastAttempt = attempt with { Outcome = UndoOutcome.Other, Other = Describe(document, title, names, taken) };
        }

        return null;
    }

    /// <summary>
    /// A transaction group rolled back, which takes its steps off the top and is no undo of anyone. Inside an edit scope
    /// the group is the scope: it names every commit, the history holds them as one step, and nothing is left to redo.
    /// </summary>
    public void RolledBack(int document, string title, IReadOnlyList<string> names)
    {
        var history = HistoryOf(document);

        if (history.Scope is not { } scope)
        {
            TakeOff(document, title, names);
        }
        else if (scope.HasStep)
        {
            history.Done.RemoveAt(history.Done.Count - 1);
            scope.HasStep = false;
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
        }
        else
        {
            history.Done.AddRange(taken);
        }

        Trim(history, document, title);
    }

    /// <summary>The document closed or was opened anew, and Revit keeps no undo history across that.</summary>
    public void Forget(int document)
    {
        _documents.Remove(document);

        if (_allLost)
        {
            _resetSinceLoss.Add(document);
        }
    }

    /// <summary>
    /// Decides whether Undo in <paramref name="activeDocument"/> would take our last operation. Undo acts on the active
    /// document and takes its top step, so that step has to be our last operation of all, and nothing may be on its way.
    /// A refusal also tells apart whether the user could do anything about it, by what really lies below the top.
    /// </summary>
    public UndoDecision Decide(int activeDocument)
    {
        if (IsLost(activeDocument))
        {
            return new UndoDecision(UndoVerdict.TrackingFailed, null);
        }

        if (LastAttempt is { Outcome: not (UndoOutcome.Undone or UndoOutcome.Refused) } attempt && IsWithinWindow(attempt))
        {
            return new UndoDecision(UndoVerdict.Unconfirmed, attempt.Step);
        }

        var lastOurs = _documents
            .Where(entry => !IsLost(entry.Key))
            .SelectMany(entry => entry.Value.Done)
            .Where(step => step.IsOurs)
            .MaxBy(step => step.Sequence);
        if (lastOurs is not null && lastOurs.Document != activeDocument)
        {
            return new UndoDecision(UndoVerdict.OtherDocument, lastOurs);
        }

        if (_documents.GetValueOrDefault(activeDocument)?.Done is not { Count: > 0 } done)
        {
            return new UndoDecision(UndoVerdict.Empty, null);
        }

        var top = done[^1];
        if (top.IsOurs)
        {
            return new UndoDecision(UndoVerdict.Allowed, top);
        }

        return done.LastOrDefault(step => step.IsOurs || step.IsUnknown) switch
        {
            null => new UndoDecision(UndoVerdict.NothingOfOurs, top),
            { IsOurs: true } ours => new UndoDecision(UndoVerdict.NotOurs, top, ours, done.Count - 1 - done.IndexOf(ours)),
            _ => new UndoDecision(UndoVerdict.HistoryLost, top),
        };
    }

    /// <summary>Records an Undo just posted, to take <paramref name="step"/>.</summary>
    public UndoAttempt Posted(UndoStep step)
    {
        LastAttempt = new UndoAttempt(++_attempts, step, clock.GetUtcNow(), UndoOutcome.Waiting);
        return LastAttempt;
    }

    /// <summary>
    /// Returns the last attempt, when a request of its own asks what became of it. Live Revit gives a posted command its
    /// turn before the next request, so the event of an undo that ran has arrived by now, as it had on the first ask in
    /// all of 165 undos, and an attempt still waiting was refused. <see cref="Undone"/> corrects that if it was not.
    /// </summary>
    public UndoAttempt? SettleLastAttempt()
    {
        if (LastAttempt is { Outcome: UndoOutcome.Waiting } attempt)
        {
            LastAttempt = attempt with { Outcome = UndoOutcome.Refused };
            _refused = LastAttempt;
        }

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

    /// <summary>What an undo that took the wrong thing took, with the ids the history knows for it.</summary>
    private static UndoStep Describe(int document, string title, IReadOnlyList<string> names, List<UndoStep>? taken) => new(
        names.Count == 0 ? UndoStep.UnknownName : string.Join(", ", names),
        document,
        title,
        0,
        taken?.SelectMany(step => step.CreatedIds).ToList() ?? [],
        taken?.SelectMany(step => step.DeletedIds).ToList() ?? []);

    /// <summary>
    /// Adds one commit of an edit scope to its step, which is on top, as nothing else can land during one command. An
    /// element that came and went inside the scope is no change at all.
    /// </summary>
    private void Fold(Document history, OpenScope scope, int document, string title, IReadOnlyList<string> createdIds, IReadOnlyList<string> deletedIds)
    {
        if (!scope.HasStep)
        {
            history.Done.Add(NewStep(scope.Name, document, title, createdIds, deletedIds));
            scope.HasStep = true;
            Trim(history, document, title);
            return;
        }

        var step = history.Done[^1];

        history.Done[^1] = step with
        {
            CreatedIds = [.. step.CreatedIds.Except(deletedIds), .. createdIds],
            DeletedIds = [.. step.DeletedIds, .. deletedIds.Except(step.CreatedIds)],
        };
    }

    /// <summary>
    /// Judges an undo that came with nothing waiting against the last refusal. One that took the refused step ran after
    /// all, however late. One that took another step counts inside the window: it may be the second of two, after a retry.
    /// </summary>
    private UndoAttempt? ReviseRefusal(List<UndoStep>? taken)
    {
        if (_refused is not { } refused)
        {
            return null;
        }

        var tookItsStep = taken?.Any(step => step.Sequence == refused.Step.Sequence) == true;

        if (!tookItsStep && !IsWithinWindow(refused))
        {
            return null;
        }

        if (tookItsStep && LastAttempt?.Id == refused.Id)
        {
            LastAttempt = refused with { Outcome = UndoOutcome.Undone };
        }

        _refused = null;
        return refused;
    }

    /// <summary>Returns what came off, or null, when the event does not fit the history, which then stops at an unknown step.</summary>
    private List<UndoStep>? TakeOff(int document, string title, IReadOnlyList<string> names)
    {
        var history = HistoryOf(document);
        var taken = TakeTop(history.Done, names);
        if (taken is null)
        {
            history.Done.Clear();
            history.Redoable.Clear();
            history.Done.Add(NewStep(UndoStep.UnknownName, document, title, [], []));
            return null;
        }

        history.Redoable.AddRange(taken);
        return taken;
    }

    /// <summary>Keeps the depth in bounds. The new bottom says that steps were lost below it, so undo stops there.</summary>
    private void Trim(Document history, int document, string title)
    {
        var excess = history.Done.Count - MaxDepth;
        if (excess > 0)
        {
            history.Done.RemoveRange(0, excess);
            history.Done[0] = NewStep(UndoStep.UnknownName, document, title, [], []);
        }
    }

    private void LoseTrack(int? document)
    {
        if (document is { } known)
        {
            HistoryOf(known).Lost = true;
        }
        else
        {
            _allLost = true;
            _resetSinceLoss.Clear();
        }

        if (LastAttempt is { Outcome: UndoOutcome.Waiting } attempt && (document is null || document == attempt.Step.Document))
        {
            LastAttempt = attempt with { Outcome = UndoOutcome.Unknown };
        }
    }

    private bool IsLost(int document) =>
        _documents.GetValueOrDefault(document)?.Lost == true || (_allLost && !_resetSinceLoss.Contains(document));

    private bool IsWithinWindow(UndoAttempt attempt) => clock.GetUtcNow() - attempt.PostedAt < ConfirmWindow;

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

    /// <summary>The two stacks of one document, tops last. <see cref="Lost"/> holds until the document resets.</summary>
    private sealed class Document
    {
        public List<UndoStep> Done { get; } = [];

        public List<UndoStep> Redoable { get; } = [];

        public bool Lost { get; set; }

        /// <summary>The edit scope open on this document, if any.</summary>
        public OpenScope? Scope { get; set; }
    }

    /// <summary>An edit scope that is open. <see cref="HasStep"/> says the top of the history holds what it has committed so far.</summary>
    private sealed class OpenScope(string name)
    {
        public string Name { get; } = name;

        public bool HasStep { get; set; }
    }
}
