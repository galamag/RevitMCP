using RevitMCP.Commands;
using Xunit;

namespace RevitMCP.Bridge.Tests;

/// <summary>
/// The decision logic of undo. <c>UndoHistory.cs</c> uses no Revit type, so this project compiles it in by a link and
/// does not need Revit. How the events feed it is covered by the live tests.
/// </summary>
public class UndoHistoryTests
{
    private const int Active = 1;
    private const int Other = 2;
    private const string Ours = "MCP: create_walls";
    private const string Theirs = "Wall";

    private readonly FakeTimeProvider _clock = new();
    private readonly UndoHistory _history;

    public UndoHistoryTests()
    {
        _history = new UndoHistory(_clock);
    }

    [Fact]
    public void Decide_ANewDocumentHasNothingToUndo()
    {
        var decision = _history.Decide(Active);

        Assert.Equal(UndoVerdict.Empty, decision.Verdict);
        Assert.Null(decision.Step);
    }

    [Fact]
    public void Decide_AllowsOurStepOnTop()
    {
        Commit(Active, Ours, ["10", "11"]);

        var decision = _history.Decide(Active);

        Assert.Equal(UndoVerdict.Allowed, decision.Verdict);
        Assert.Equal(Ours, decision.Step!.Name);
        Assert.Equal(["10", "11"], decision.Step.CreatedIds);
    }

    [Fact]
    public void Decide_RefusesAUserChangeOnTop()
    {
        Commit(Active, Ours);
        Commit(Active, Theirs);

        var decision = _history.Decide(Active);

        Assert.Equal(UndoVerdict.NotOurs, decision.Verdict);
        Assert.Equal(Theirs, decision.Step!.Name);
    }

    [Fact]
    public void Decide_RefusesAUserChangeWithNothingOfOursBelow()
    {
        Commit(Active, Theirs);

        Assert.Equal(UndoVerdict.NotOurs, _history.Decide(Active).Verdict);
    }

    [Fact]
    public void Decide_AllowsOurStepAgainAfterTheUserUndidTheirChange()
    {
        Commit(Active, Ours);
        Commit(Active, Theirs);

        _history.Undone(Active, "Дом", [Theirs]);

        Assert.Equal(UndoVerdict.Allowed, _history.Decide(Active).Verdict);
    }

    [Fact]
    public void Decide_TakesOnlyTheExactPrefixForOurs()
    {
        Commit(Active, "MCP without the colon");
        Commit(Active, "mcp: lower case");

        Assert.Equal(UndoVerdict.NotOurs, _history.Decide(Active).Verdict);
    }

    [Fact]
    public void Decide_RefusesWhenOurLastOperationIsInAnotherDocument()
    {
        Commit(Active, "MCP: earlier");
        Commit(Other, "MCP: later");

        var decision = _history.Decide(Active);

        Assert.Equal(UndoVerdict.OtherDocument, decision.Verdict);
        Assert.Equal("MCP: later", decision.Step!.Name);
        Assert.Equal(Other, decision.Step.Document);
    }

    [Fact]
    public void Decide_RefusesAnEmptyDocumentWhileOurLastOperationIsElsewhere()
    {
        Commit(Other, Ours);

        Assert.Equal(UndoVerdict.OtherDocument, _history.Decide(Active).Verdict);
    }

    [Fact]
    public void Decide_FollowsTheLastOperationBackAcrossDocuments()
    {
        Commit(Active, "MCP: earlier");
        Commit(Other, "MCP: later");

        _history.Undone(Other, "Другой", ["MCP: later"]);

        Assert.Equal(UndoVerdict.Allowed, _history.Decide(Active).Verdict);
        Assert.Equal(UndoVerdict.OtherDocument, _history.Decide(Other).Verdict);
    }

    [Fact]
    public void Decide_IgnoresAUserChangeInAnotherDocument()
    {
        Commit(Active, Ours);
        Commit(Other, Theirs);

        Assert.Equal(UndoVerdict.Allowed, _history.Decide(Active).Verdict);
    }

    [Fact]
    public void Forget_ClearsOneDocumentOnly()
    {
        Commit(Active, Ours);
        Commit(Other, Ours);

        _history.Forget(Other);

        Assert.Equal(UndoVerdict.OtherDocument, _history.Decide(Other).Verdict);
        Assert.Equal(UndoVerdict.Allowed, _history.Decide(Active).Verdict);
    }

    [Fact]
    public void Forget_LeavesNothingOfAClosedDocument()
    {
        Commit(Active, Ours);

        _history.Forget(Active);

        Assert.Equal(UndoVerdict.Empty, _history.Decide(Active).Verdict);
    }

    [Fact]
    public void Undone_MarksThePostedUndoAndKeepsTheIdsForTheReport()
    {
        Commit(Active, Ours, ["10"], ["5"]);
        var attempt = Post();
        Assert.False(attempt.Undone);

        _history.Undone(Active, "Дом", [Ours]);

        var last = _history.LastAttempt!;
        Assert.True(last.Undone);
        Assert.Equal(attempt.Id, last.Id);
        Assert.Equal(Ours, last.Step.Name);
        Assert.Equal(["10"], last.Step.CreatedIds);
        Assert.Equal(["5"], last.Step.DeletedIds);
    }

    [Fact]
    public void Undone_InAnotherDocumentDoesNotConfirm()
    {
        Commit(Active, Ours);
        Commit(Other, "MCP: other");
        _history.Undone(Other, "Другой", ["MCP: other"]);
        Post();

        Commit(Other, "MCP: other");
        _history.Undone(Other, "Другой", ["MCP: other"]);

        Assert.False(_history.LastAttempt!.Undone);
    }

    [Fact]
    public void Undone_OfAnotherStepDoesNotConfirm()
    {
        Commit(Active, Ours);
        Post();

        _history.Undone(Active, "Дом", ["Что-то другое"]);

        Assert.False(_history.LastAttempt!.Undone);
    }

    [Fact]
    public void Undone_WithAnEventThatDoesNotFit_StopsTheHistoryThere()
    {
        Commit(Active, Ours);
        Commit(Active, "MCP: second");

        _history.Undone(Active, "Дом", ["Что-то другое"]);

        Assert.Equal(UndoVerdict.NotOurs, _history.Decide(Active).Verdict);
    }

    [Fact]
    public void Undone_AfterLosingTrack_OurNextStepCanStillBeUndone_AndThenItStops()
    {
        Commit(Active, Ours);
        _history.Undone(Active, "Дом", ["Что-то другое"]);

        Commit(Active, "MCP: next");
        Assert.Equal(UndoVerdict.Allowed, _history.Decide(Active).Verdict);

        _history.Undone(Active, "Дом", ["MCP: next"]);
        Assert.Equal(UndoVerdict.NotOurs, _history.Decide(Active).Verdict);
    }

    [Fact]
    public void Undone_OnAnEmptyHistory_LeavesNothingThatLooksLikeOurs()
    {
        _history.Undone(Active, "Дом", [Ours]);

        Assert.Equal(UndoVerdict.NotOurs, _history.Decide(Active).Verdict);
    }

    [Fact]
    public void Undone_TakesSeveralStepsInOneEvent_InEitherOrder()
    {
        Commit(Active, "MCP: first");
        Commit(Active, "A");
        Commit(Active, "B");

        _history.Undone(Active, "Дом", ["A", "B"]);

        Assert.Equal("MCP: first", _history.Decide(Active).Step!.Name);
    }

    [Fact]
    public void Redone_PutsAStepBackWithItsIds()
    {
        Commit(Active, Ours, ["10"]);
        _history.Undone(Active, "Дом", [Ours]);
        Assert.Equal(UndoVerdict.Empty, _history.Decide(Active).Verdict);

        _history.Redone(Active, "Дом", [Ours]);

        var decision = _history.Decide(Active);
        Assert.Equal(UndoVerdict.Allowed, decision.Verdict);
        Assert.Equal(["10"], decision.Step!.CreatedIds);
    }

    [Fact]
    public void Redone_InTheOrderOfTheUndos()
    {
        Commit(Active, "MCP: first");
        Commit(Active, "MCP: second");
        _history.Undone(Active, "Дом", ["MCP: second"]);
        _history.Undone(Active, "Дом", ["MCP: first"]);

        _history.Redone(Active, "Дом", ["MCP: first"]);
        Assert.Equal("MCP: first", _history.Decide(Active).Step!.Name);

        _history.Redone(Active, "Дом", ["MCP: second"]);
        Assert.Equal("MCP: second", _history.Decide(Active).Step!.Name);
    }

    [Fact]
    public void Redone_OfAUserStepRefusesAgain()
    {
        Commit(Active, Ours);
        Commit(Active, Theirs);
        _history.Undone(Active, "Дом", [Theirs]);

        _history.Redone(Active, "Дом", [Theirs]);

        Assert.Equal(UndoVerdict.NotOurs, _history.Decide(Active).Verdict);
    }

    [Fact]
    public void Redone_OfAStepTheHistoryLost_ComesBackByName()
    {
        _history.Redone(Active, "Дом", [Theirs]);

        Assert.Equal(UndoVerdict.NotOurs, _history.Decide(Active).Verdict);
    }

    [Fact]
    public void Committed_EndsWhatCouldBeRedone()
    {
        Commit(Active, "MCP: first");
        _history.Undone(Active, "Дом", ["MCP: first"]);
        Commit(Active, "MCP: second");

        _history.Redone(Active, "Дом", ["MCP: first"]);

        Assert.Equal("MCP: first", _history.Decide(Active).Step!.Name);
        Assert.Empty(_history.Decide(Active).Step!.CreatedIds);
    }

    [Fact]
    public void Committed_WithSeveralNames_MakesAStepOfEachAndTheLastCarriesTheIds()
    {
        _history.Committed(Active, "Дом", [Theirs, Ours], ["10"], []);

        var top = _history.Decide(Active).Step!;
        Assert.Equal(Ours, top.Name);
        Assert.Equal(["10"], top.CreatedIds);

        _history.Undone(Active, "Дом", [Ours]);
        Assert.Equal(UndoVerdict.NotOurs, _history.Decide(Active).Verdict);
    }

    [Fact]
    public void Committed_WithNoName_IsNotOurs()
    {
        Commit(Active, Ours);

        _history.Committed(Active, "Дом", [], [], []);

        Assert.Equal(UndoVerdict.NotOurs, _history.Decide(Active).Verdict);
    }

    [Fact]
    public void Decide_RefusesWhileAnUndoIsUnconfirmed_EvenWithOursOnTop()
    {
        Commit(Active, "MCP: first");
        Commit(Active, "MCP: second");
        Post();

        var decision = _history.Decide(Active);

        Assert.Equal(UndoVerdict.Unconfirmed, decision.Verdict);
        Assert.Equal("MCP: second", decision.Step!.Name);
    }

    [Fact]
    public void Decide_AllowsTheNextUndoOnceTheLastWasSeen()
    {
        Commit(Active, "MCP: first");
        Commit(Active, "MCP: second");
        Post();

        _history.Undone(Active, "Дом", ["MCP: second"]);

        var decision = _history.Decide(Active);
        Assert.Equal(UndoVerdict.Allowed, decision.Verdict);
        Assert.Equal("MCP: first", decision.Step!.Name);
    }

    [Fact]
    public void Decide_StopsWaitingForAnUnseenUndoAtTheEndOfTheWindow()
    {
        Commit(Active, Ours);
        Post();

        _clock.Advance(UndoHistory.ConfirmWindow - TimeSpan.FromSeconds(1));
        Assert.Equal(UndoVerdict.Unconfirmed, _history.Decide(Active).Verdict);

        _clock.Advance(TimeSpan.FromSeconds(1));
        Assert.Equal(UndoVerdict.Allowed, _history.Decide(Active).Verdict);
    }

    [Fact]
    public void LateUndo_StillCountsForTheAttemptAfterTheWindow()
    {
        Commit(Active, Ours);
        Post();
        _clock.Advance(UndoHistory.ConfirmWindow * 2);

        _history.Undone(Active, "Дом", [Ours]);

        Assert.True(_history.LastAttempt!.Undone);
    }

    [Fact]
    public void Posted_NumbersAttemptsAndKeepsTheLast()
    {
        Commit(Active, "MCP: first");
        Commit(Active, "MCP: second");

        var first = Post();
        _history.Undone(Active, "Дом", ["MCP: second"]);
        var second = Post();

        Assert.NotEqual(first.Id, second.Id);
        Assert.Equal("MCP: first", _history.LastAttempt!.Step.Name);
        Assert.False(_history.LastAttempt.Undone);
    }

    [Fact]
    public void LastAttempt_IsNullBeforeTheFirstPost()
    {
        Commit(Active, Ours);

        Assert.Null(_history.LastAttempt);
    }

    [Fact]
    public void Commit_ThenUserUndo_LeavesNoAttemptConfirmed()
    {
        Commit(Active, Ours);

        _history.Undone(Active, "Дом", [Ours]);

        Assert.Null(_history.LastAttempt);
    }

    private void Commit(int document, string name, string[]? created = null, string[]? deleted = null) =>
        _history.Committed(document, document == Active ? "Дом" : "Другой", [name], created ?? [], deleted ?? []);

    private UndoAttempt Post() => _history.Posted(_history.Decide(Active).Step!);
}
