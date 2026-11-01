using Xunit;

namespace RevitMCP.Bridge.Tests;

/// <summary>
/// The words of a save_project_template that failed. Live Revit cannot be made to leave a document on the template without a
/// person to close it, so the branching on where the document really is gets its test here.
/// </summary>
public class TemplateSaveFailureTests
{
    private const string Project = @"C:\Users\x\Documents\RevitMCP\дом.rvt";
    private const string Template = @"C:\Users\x\Documents\RevitMCP\шаблон.rte";
    private const string Cause = "Revit said: the disk is full.";

    [Fact]
    public void SavingBack_DocumentOnTheTemplate_SaysItStayedThereAndWhatNotToDo()
    {
        var message = TemplateSaveFailure.SavingBack(Cause, Project, Template, Template);

        Assert.Contains("THE ACTIVE DOCUMENT STAYED ON THE TEMPLATE " + Template, message);
        Assert.Contains(Cause, message);
        Assert.Contains("Nothing was deleted", message);
        Assert.Contains("restart-revit.ps1", message);
        Assert.Contains("Do not", message);
    }

    [Fact]
    public void SavingBack_DocumentOnTheTemplate_InAnotherLetterCase_IsStillTheTemplate()
    {
        var message = TemplateSaveFailure.SavingBack(Cause, Project, Template, Template.ToUpperInvariant());

        Assert.Contains("STAYED ON THE TEMPLATE", message);
    }

    [Fact]
    public void SavingBack_NamesTheBackupAndDoesNotCallTheProjectFileSimplyOlder()
    {
        var message = TemplateSaveFailure.SavingBack(Cause, Project, Template, Template);

        Assert.Contains(@"C:\Users\x\Documents\RevitMCP\дом.0001.rvt", message);
        Assert.Contains("damaged", message);
        Assert.Contains("missing", message);
        Assert.DoesNotContain("may be older", message);
    }

    [Fact]
    public void SavingBack_DocumentNotReadable_DoesNotClaimItStayedOnTheTemplate()
    {
        var message = TemplateSaveFailure.SavingBack(Cause, Project, Template, TemplateSaveFailure.UnreadablePath);

        Assert.DoesNotContain("STAYED ON THE TEMPLATE", message);
        Assert.DoesNotContain(TemplateSaveFailure.UnreadablePath, message);
        Assert.Contains("DID NOT SAY WHERE THE ACTIVE DOCUMENT IS", message);
        Assert.Contains("MAY BE ON THE TEMPLATE", message);
    }

    [Fact]
    public void SavingBack_DocumentSomewhereElse_NamesThePlaceAndDoesNotCallItTheTemplate()
    {
        var elsewhere = @"C:\Users\x\Documents\RevitMCP\другой.rvt";

        var message = TemplateSaveFailure.SavingBack(Cause, Project, Template, elsewhere);

        Assert.DoesNotContain("STAYED ON THE TEMPLATE", message);
        Assert.Contains("THE ACTIVE DOCUMENT IS NOW " + elsewhere, message);
        Assert.Contains("NEITHER", message);
    }

    [Fact]
    public void SavingBack_DocumentBackOnTheProject_IsNotStrandedAndMayBeSaved()
    {
        var message = TemplateSaveFailure.SavingBack(Cause, Project, Template, Project.ToUpperInvariant());

        Assert.DoesNotContain("STAYED ON THE TEMPLATE", message);
        Assert.Contains("is on " + Project, message);
        Assert.Contains("save_project", message);
        Assert.Contains(Cause, message);
        Assert.Contains("damaged", message);
        Assert.Contains(@"C:\Users\x\Documents\RevitMCP\дом.0001.rvt", message);
    }

    [Fact]
    public void WritingTemplate_DocumentStillOnTheProject_SaysNothingMoved()
    {
        var message = TemplateSaveFailure.WritingTemplate(Cause, Project, Template, Project, templateFileExists: false);

        Assert.Contains("still " + Project, message);
        Assert.Contains("No file was left at " + Template, message);
        Assert.DoesNotContain("STAYED", message);
        Assert.DoesNotContain("FAILED", message);
    }

    [Fact]
    public void WritingTemplate_APartialFileIsReportedAsLeftThere()
    {
        var message = TemplateSaveFailure.WritingTemplate(Cause, Project, Template, Project, templateFileExists: true);

        Assert.Contains("A partial file may remain at " + Template, message);
        Assert.Contains("that name stays taken", message);
    }

    [Fact]
    public void WritingTemplate_DocumentMovedOntoTheTemplate_IsTheSameHazardAsAFailedSaveBack()
    {
        var message = TemplateSaveFailure.WritingTemplate(Cause, Project, Template, Template, templateFileExists: true);

        Assert.Contains("THE ACTIVE DOCUMENT STAYED ON THE TEMPLATE " + Template, message);
        Assert.Contains("A partial file may remain at " + Template, message);
        Assert.Contains("Nothing was deleted", message);
        Assert.Contains("Do not", message);
    }

    [Fact]
    public void WritingTemplate_DocumentNotReadable_DoesNotClaimItStayedOnTheProject()
    {
        var message = TemplateSaveFailure.WritingTemplate(Cause, Project, Template, TemplateSaveFailure.UnreadablePath, templateFileExists: true);

        Assert.DoesNotContain("still " + Project, message);
        Assert.Contains("DID NOT SAY WHERE THE ACTIVE DOCUMENT IS", message);
    }

    [Fact]
    public void EveryMessage_NamesTheTool()
    {
        Assert.Contains(MethodNames.SaveProjectTemplate, TemplateSaveFailure.SavingBack(Cause, Project, Template, Template));
        Assert.Contains(MethodNames.SaveProjectTemplate, TemplateSaveFailure.WritingTemplate(Cause, Project, Template, Project, templateFileExists: false));
    }
}
