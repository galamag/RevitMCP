using System.Text.Json;
using RevitMCP.Commands;
using Xunit;

namespace RevitMCP.Bridge.Tests;

/// <summary>
/// The report of an item that fails after the commit. <c>ItemResult.cs</c> uses no Revit type, so this project compiles it in by a link.
/// The branch of <c>ItemBatch.ReadBackAll</c> that calls it reads elements of a document, needs Revit, and is not covered here.
/// </summary>
public class ItemResultTests
{
    private static readonly JsonElement Request = JsonSerializer.SerializeToElement(new { levelId = "311", name = "Гостиная" });

    private static ItemResult Created() =>
        new(2, ItemStatus.Created, "300307", Request, JsonSerializer.SerializeToElement(new { areaM2 = 0 }), ["a warning"], null);

    [Fact]
    public void FailedAfterCommit_IsFailedWithNoElementAndNoActual()
    {
        var failed = Created().FailedAfterCommit("The room has an area of 0.");

        Assert.Equal(ItemStatus.Failed, failed.Status);
        Assert.Null(failed.ElementId);
        Assert.Null(failed.Actual);
        Assert.Equal("The room has an area of 0.", failed.Error);
    }

    [Fact]
    public void FailedAfterCommit_KeepsWhatWasAskedAndWarned()
    {
        var created = Created();

        var failed = created.FailedAfterCommit("why");

        Assert.Equal(created.Index, failed.Index);
        Assert.Equal(created.Requested, failed.Requested);
        Assert.Equal(["a warning"], failed.Warnings);
    }

    [Fact]
    public void FailedAfterCommit_LeavesTheCreatedReportAsItWas()
    {
        var created = Created();

        _ = created.FailedAfterCommit("why");

        Assert.Equal(ItemStatus.Created, created.Status);
        Assert.Equal("300307", created.ElementId);
        Assert.Null(created.Error);
    }
}
