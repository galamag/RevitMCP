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
        Assert.Equal(Ours, decision.Ours!.Name);
        Assert.Equal(1, decision.StepsAbove);
    }

    [Fact]
    public void Decide_CountsEveryUserChangeAboveOurStep()
    {
        Commit(Active, Ours);
        Commit(Active, Theirs);
        Commit(Active, "Door");

        var decision = _history.Decide(Active);

        Assert.Equal(UndoVerdict.NotOurs, decision.Verdict);
        Assert.Equal("Door", decision.Step!.Name);
        Assert.Equal(2, decision.StepsAbove);
    }

    /// <summary>The user must not be sent to undo their work when an unknown step would stop undo right below it.</summary>
    [Fact]
    public void Decide_SaysLostWhenAnUnknownStepLiesBetweenTheUserChangeAndOurStep()
    {
        Commit(Active, Ours);
        _history.Committed(Active, "Дом", [], [], []);
        Commit(Active, Theirs);

        var decision = _history.Decide(Active);

        Assert.Equal(UndoVerdict.HistoryLost, decision.Verdict);
        Assert.Equal(Theirs, decision.Step!.Name);
    }

    [Fact]
    public void Decide_SendsTheUserToUndoWhenOursLiesAboveTheUnknownStep()
    {
        _history.Committed(Active, "Дом", [], [], []);
        Commit(Active, Ours);
        Commit(Active, Theirs);

        Assert.Equal(UndoVerdict.NotOurs, _history.Decide(Active).Verdict);
    }

    [Fact]
    public void Decide_RefusesAUserChangeWithNothingOfOursBelow()
    {
        Commit(Active, Theirs);

        var decision = _history.Decide(Active);

        Assert.Equal(UndoVerdict.NothingOfOurs, decision.Verdict);
        Assert.Equal(Theirs, decision.Step!.Name);
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

        Assert.Equal(UndoVerdict.NothingOfOurs, _history.Decide(Active).Verdict);
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
        Assert.Equal(UndoOutcome.Waiting, attempt.Outcome);

        _history.Undone(Active, "Дом", [Ours]);

        var last = _history.LastAttempt!;
        Assert.Equal(UndoOutcome.Undone, last.Outcome);
        Assert.Null(last.Other);
        Assert.Equal(attempt.Id, last.Id);
        Assert.Equal(Ours, last.Step.Name);
        Assert.Equal(["10"], last.Step.CreatedIds);
        Assert.Equal(["5"], last.Step.DeletedIds);
    }

    [Fact]
    public void Undone_InAnotherDocument_IsRecordedAsWhatHappened()
    {
        Commit(Active, Ours);
        Commit(Other, "MCP: other");
        _history.Undone(Other, "Другой", ["MCP: other"]);
        Post();

        Commit(Other, "MCP: other", ["20"]);
        _history.Undone(Other, "Другой", ["MCP: other"]);

        var attempt = _history.LastAttempt!;
        Assert.Equal(UndoOutcome.Other, attempt.Outcome);
        Assert.Equal("MCP: other", attempt.Other!.Name);
        Assert.Equal("Другой", attempt.Other.DocumentTitle);
        Assert.Equal(["20"], attempt.Other.CreatedIds);
        Assert.Equal(Ours, attempt.Step.Name);
    }

    [Fact]
    public void Undone_WithANameThatDoesNotFit_IsRecordedAsWhatHappened()
    {
        Commit(Active, Ours);
        Post();

        _history.Undone(Active, "Дом", ["Что-то другое"]);

        var attempt = _history.LastAttempt!;
        Assert.Equal(UndoOutcome.Other, attempt.Outcome);
        Assert.Equal("Что-то другое", attempt.Other!.Name);
        Assert.Equal("Дом", attempt.Other.DocumentTitle);
        Assert.Empty(attempt.Other.CreatedIds);
    }

    /// <summary>The name fits, so the history stays in step, but the step is not the one the attempt was posted for.</summary>
    [Fact]
    public void Undone_OfAStepWithTheSameName_IsNotTheAttemptsStep()
    {
        Commit(Active, Ours, ["10"]);
        Post();
        Commit(Active, Ours, ["20"]);

        _history.Undone(Active, "Дом", [Ours]);

        var attempt = _history.LastAttempt!;
        Assert.Equal(UndoOutcome.Other, attempt.Outcome);
        Assert.Equal(Ours, attempt.Other!.Name);
        Assert.Equal(["20"], attempt.Other.CreatedIds);
        Assert.Equal(["10"], attempt.Step.CreatedIds);
    }

    [Fact]
    public void Undone_WithNoName_IsRecordedAsUnknownSteps()
    {
        Commit(Active, Ours);
        Post();

        _history.Undone(Active, "Дом", []);

        Assert.Equal(UndoStep.UnknownName, _history.LastAttempt!.Other!.Name);
    }

    [Fact]
    public void Decide_KeepsRefusingAfterAnotherUndo_UntilTheWindowEnds()
    {
        Commit(Active, Ours);
        Post();
        Commit(Active, "MCP: second");
        _history.Undone(Active, "Дом", ["MCP: second"]);

        Assert.Equal(UndoVerdict.Unconfirmed, _history.Decide(Active).Verdict);

        _clock.Advance(UndoHistory.ConfirmWindow);
        Assert.Equal(UndoVerdict.Allowed, _history.Decide(Active).Verdict);
    }

    [Fact]
    public void Undone_AfterTheWindow_IsNoLongerTiedToTheAttempt()
    {
        Commit(Active, Ours);
        Post();
        Commit(Active, Theirs);
        _clock.Advance(UndoHistory.ConfirmWindow);

        _history.Undone(Active, "Дом", [Theirs]);

        Assert.Equal(UndoOutcome.Waiting, _history.LastAttempt!.Outcome);
    }

    [Fact]
    public void RolledBack_IsNoUndo_SoItLeavesTheAttemptWaiting()
    {
        Commit(Active, Ours);
        Post();
        Commit(Active, "Inner");

        _history.RolledBack(Active, "Дом", ["Inner"]);

        Assert.Equal(UndoOutcome.Waiting, _history.LastAttempt!.Outcome);
    }

    [Fact]
    public void Undone_WithAnEventThatDoesNotFit_StopsTheHistoryThere()
    {
        Commit(Active, Ours);
        Commit(Active, "MCP: second");

        _history.Undone(Active, "Дом", ["Что-то другое"]);

        Assert.Equal(UndoVerdict.HistoryLost, _history.Decide(Active).Verdict);
    }

    [Fact]
    public void Undone_AfterLosingTrack_OurNextStepCanStillBeUndone_AndThenItStops()
    {
        Commit(Active, Ours);
        _history.Undone(Active, "Дом", ["Что-то другое"]);

        Commit(Active, "MCP: next");
        Assert.Equal(UndoVerdict.Allowed, _history.Decide(Active).Verdict);

        _history.Undone(Active, "Дом", ["MCP: next"]);
        Assert.Equal(UndoVerdict.HistoryLost, _history.Decide(Active).Verdict);
    }

    /// <summary>Live Revit: a group of two commits comes as two events, and its undo as one, in the name of the group.</summary>
    [Fact]
    public void Undone_OfAnAssimilatedGroup_RefusesFromThenOn_SoOurStepBelowIsLostToUndoNotWronglyTaken()
    {
        Commit(Active, Ours);
        Commit(Active, "Inner 1");
        Commit(Active, "Inner 2");
        Assert.Equal(UndoVerdict.NotOurs, _history.Decide(Active).Verdict);

        _history.Undone(Active, "Дом", ["Group"]);

        Assert.Equal(UndoVerdict.HistoryLost, _history.Decide(Active).Verdict);
    }

    /// <summary>Live Revit: a rolled back group names its steps, the last one first.</summary>
    [Fact]
    public void Undone_OfARolledBackGroup_LeavesOurStepOnTop()
    {
        Commit(Active, Ours);
        Commit(Active, "Inner 1");
        Commit(Active, "Inner 2");

        _history.RolledBack(Active, "Дом", ["Inner 2", "Inner 1"]);

        Assert.Equal(UndoVerdict.Allowed, _history.Decide(Active).Verdict);
    }

    [Fact]
    public void Undone_OnAnEmptyHistory_LeavesNothingThatLooksLikeOurs()
    {
        _history.Undone(Active, "Дом", [Ours]);

        Assert.Equal(UndoVerdict.HistoryLost, _history.Decide(Active).Verdict);
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

        Assert.Equal(UndoVerdict.NothingOfOurs, _history.Decide(Active).Verdict);
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

    /// <summary>If the names were one real step, a top reading as ours would take <c>Theirs</c> along with it.</summary>
    [Fact]
    public void Committed_WithSeveralNames_IsOneUnknownStep_AndKeepsNoIds()
    {
        _history.Committed(Active, "Дом", [Theirs, Ours], ["10"], ["5"]);

        var decision = _history.Decide(Active);

        Assert.Equal(UndoVerdict.HistoryLost, decision.Verdict);
        Assert.Equal(UndoStep.UnknownName, decision.Step!.Name);
        Assert.Empty(decision.Step.CreatedIds);
        Assert.Empty(decision.Step.DeletedIds);
    }

    [Fact]
    public void Committed_WithNoName_IsAnUnknownStep()
    {
        Commit(Active, Ours);

        _history.Committed(Active, "Дом", [], [], []);

        Assert.Equal(UndoVerdict.HistoryLost, _history.Decide(Active).Verdict);
    }

    [Fact]
    public void Committed_KeepsIdsOnlyForOurSteps()
    {
        Commit(Active, Ours, ["10"], ["5"]);
        var ours = _history.Decide(Active).Step!;

        Commit(Active, Theirs, ["11"], ["6"]);
        var theirs = _history.Decide(Active).Step!;

        Assert.Equal(["10"], ours.CreatedIds);
        Assert.Equal(["5"], ours.DeletedIds);
        Assert.Empty(theirs.CreatedIds);
        Assert.Empty(theirs.DeletedIds);
    }

    [Fact]
    public void Depth_KeepsTheNewestSteps_AndWhatFellOffIsUnknown()
    {
        for (var step = 0; step < UndoHistory.MaxDepth + 5; step++)
        {
            Commit(Active, $"MCP: {step}");
        }

        // The bottom place holds the unknown step, so one step fewer than the depth can be undone.
        for (var step = UndoHistory.MaxDepth + 4; step > 5; step--)
        {
            Assert.Equal($"MCP: {step}", _history.Decide(Active).Step!.Name);
            _history.Undone(Active, "Дом", [$"MCP: {step}"]);
        }

        Assert.Equal(UndoVerdict.HistoryLost, _history.Decide(Active).Verdict);
    }

    [Fact]
    public void Depth_HoldsAgainstRedo()
    {
        for (var step = 0; step < UndoHistory.MaxDepth + 1; step++)
        {
            _history.Redone(Active, "Дом", [Theirs]);
        }

        Assert.Equal(UndoVerdict.HistoryLost, _history.Decide(Active).Verdict);
    }

    [Fact]
    public void Depth_LeavesAHistoryAtTheLimitAlone()
    {
        Commit(Active, Ours);
        for (var step = 1; step < UndoHistory.MaxDepth; step++)
        {
            Commit(Active, Theirs);
        }

        Assert.Equal(UndoVerdict.NotOurs, _history.Decide(Active).Verdict);
    }

    [Fact]
    public void Track_RecordsTheEventWhenItWorks()
    {
        _history.Track(() => Active, document => Commit(document, Ours));

        Assert.Equal(UndoVerdict.Allowed, _history.Decide(Active).Verdict);
    }

    [Fact]
    public void Track_AFailureRefusesThatDocument_EvenWithOursOnTop()
    {
        Commit(Active, Ours);

        FailToRecord(Active);

        var decision = _history.Decide(Active);
        Assert.Equal(UndoVerdict.TrackingFailed, decision.Verdict);
        Assert.Null(decision.Step);
    }

    [Fact]
    public void Track_AFailureHolds_ThroughOurNextSteps_UntilTheDocumentResets()
    {
        FailToRecord(Active);

        Commit(Active, Ours);
        Assert.Equal(UndoVerdict.TrackingFailed, _history.Decide(Active).Verdict);

        _history.Forget(Active);
        Commit(Active, Ours);
        Assert.Equal(UndoVerdict.Allowed, _history.Decide(Active).Verdict);
    }

    [Fact]
    public void Track_AFailureLeavesOtherDocumentsAlone_AndItsStepsDoNotBlockThem()
    {
        Commit(Other, "MCP: earlier");
        Commit(Active, "MCP: later");

        FailToRecord(Active);

        Assert.Equal(UndoVerdict.Allowed, _history.Decide(Other).Verdict);
    }

    [Fact]
    public void Track_AFailureBeforeTheDocumentIsKnown_RefusesEveryDocument_EvenOnesNotSeenYet()
    {
        Commit(Active, Ours);
        Commit(Other, Ours);

        FailToRecord(null);

        Assert.Equal(UndoVerdict.TrackingFailed, _history.Decide(Active).Verdict);
        Assert.Equal(UndoVerdict.TrackingFailed, _history.Decide(Other).Verdict);
        Assert.Equal(UndoVerdict.TrackingFailed, _history.Decide(3).Verdict);
    }

    [Fact]
    public void Track_AFailureForEveryDocument_EndsForEachAsItResets()
    {
        Commit(Active, Ours);
        Commit(Other, Ours);
        FailToRecord(null);

        _history.Forget(Other);
        Commit(Other, Ours);

        Assert.Equal(UndoVerdict.Allowed, _history.Decide(Other).Verdict);
        Assert.Equal(UndoVerdict.TrackingFailed, _history.Decide(Active).Verdict);
    }

    [Fact]
    public void Track_ASecondFailureForEveryDocument_CatchesThoseThatResetBefore()
    {
        FailToRecord(null);
        _history.Forget(Other);

        FailToRecord(null);

        Assert.Equal(UndoVerdict.TrackingFailed, _history.Decide(Other).Verdict);
    }

    [Fact]
    public void Track_AFailureWhileAnUndoWaits_MakesItsFateUnknown()
    {
        Commit(Active, Ours);
        Post();

        FailToRecord(Active);

        Assert.Equal(UndoOutcome.Unknown, _history.LastAttempt!.Outcome);
    }

    [Fact]
    public void Track_AFailureInAnotherDocument_LeavesAWaitingUndoWaiting()
    {
        Commit(Active, Ours);
        Post();

        FailToRecord(Other);

        Assert.Equal(UndoOutcome.Waiting, _history.LastAttempt!.Outcome);
    }

    [Fact]
    public void Track_AFailureBeforeTheDocumentIsKnown_MakesAWaitingUndoUnknown()
    {
        Commit(Active, Ours);
        Post();

        FailToRecord(null);

        Assert.Equal(UndoOutcome.Unknown, _history.LastAttempt!.Outcome);
    }

    [Fact]
    public void Track_AFailureLeavesASettledUndoAsItIs()
    {
        Commit(Active, Ours);
        Post();
        _history.Undone(Active, "Дом", [Ours]);

        FailToRecord(Active);

        Assert.Equal(UndoOutcome.Undone, _history.LastAttempt!.Outcome);
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

        Assert.Equal(UndoOutcome.Undone, _history.LastAttempt!.Outcome);
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
        Assert.Equal(UndoOutcome.Waiting, _history.LastAttempt.Outcome);
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

    [Fact]
    public void Explain_SendsTheUserToUndoWhenOursLiesBelow_AndSaysWhatItCostsThem()
    {
        Commit(Active, Ours);
        Commit(Active, Theirs);

        var text = _history.Decide(Active).Explain("Дом");

        Assert.Contains($"'{Theirs}'", text);
        Assert.Contains($"the last operation of these tools, '{Ours}': 1.", text);
        Assert.Contains("Only the user can undo those", text);
        Assert.Contains("that loses them", text);
        Assert.Contains("try again", text);
    }

    [Fact]
    public void Explain_DoesNotSendTheUserToUndoWhenNothingOfOursLiesBelow()
    {
        Commit(Active, Theirs);

        var text = _history.Decide(Active).Explain("Дом");

        Assert.Contains("nothing to undo here", text);
        Assert.Contains("Do not ask the user to undo that change", text);
        Assert.DoesNotContain("try again", text);
    }

    [Fact]
    public void Explain_ForALostHistory_SaysWhenUndoComesBack_AndDoesNotSendTheUserToUndo()
    {
        Commit(Active, Ours);
        _history.Undone(Active, "Дом", ["Что-то другое"]);

        var text = _history.Decide(Active).Explain("Дом");

        Assert.Contains("the undo history of 'Дом' was lost", text);
        Assert.Contains("until the next operation of these tools in this project", text);
        Assert.Contains("Do not ask the user to undo anything for this", text);
        Assert.DoesNotContain(UndoStep.UnknownName, text);
        Assert.DoesNotContain("try again", text);
    }

    /// <summary>A user change above a lost history reads the same: undoing it would rebuild the same refusal.</summary>
    [Fact]
    public void Explain_ForAUserChangeAboveALostHistory_DoesNotSendTheUserToUndo()
    {
        Commit(Active, Ours);
        _history.Undone(Active, "Дом", ["Что-то другое"]);
        Commit(Active, Theirs);

        var text = _history.Decide(Active).Explain("Дом");

        Assert.Contains("was lost", text);
        Assert.Contains("Do not ask the user to undo anything for this", text);
    }

    [Fact]
    public void Explain_ForAFailedTracker_SaysItLastsUntilTheProjectReopens()
    {
        Commit(Active, Ours);
        FailToRecord(Active);

        var text = _history.Decide(Active).Explain("Дом");

        Assert.Contains("recording the changes of 'Дом' failed", text);
        Assert.Contains("until this project is closed and opened again", text);
        Assert.Contains("Do not ask the user to undo anything for this", text);
    }

    [Fact]
    public void Explain_ForAnotherDocument_NamesItAndTheWayThere()
    {
        Commit(Other, Ours);

        var text = _history.Decide(Active).Explain("Дом");

        Assert.Contains("'Другой'", text);
        Assert.Contains("open_project", text);
    }

    [Fact]
    public void Explain_ForAnUnsettledUndo_SaysToAskWhatBecameOfIt()
    {
        Commit(Active, Ours);
        Post();

        var text = _history.Decide(Active).Explain("Дом");

        Assert.Contains("get_last_undo_result", text);
        Assert.Contains("one minute", text);
    }

    [Fact]
    public void Explain_ForAnEmptyHistory_SaysSo()
    {
        Assert.Contains("nothing to undo in 'Дом'", _history.Decide(Active).Explain("Дом"));
    }

    /// <summary>Runs an event that fails, with its document known unless <paramref name="document"/> is null.</summary>
    private void FailToRecord(int? document)
    {
        var failure = new InvalidOperationException("The event could not be read.");

        var thrown = Assert.Throws<InvalidOperationException>(() =>
            _history.Track(() => document ?? throw failure, _ => throw failure));

        Assert.Same(failure, thrown);
    }

    private void Commit(int document, string name, string[]? created = null, string[]? deleted = null) =>
        _history.Committed(document, document == Active ? "Дом" : "Другой", [name], created ?? [], deleted ?? []);

    private UndoAttempt Post() => _history.Posted(_history.Decide(Active).Step!);
}
