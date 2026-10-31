using RevitMCP.Commands;
using Xunit;

namespace RevitMCP.Bridge.Tests;

/// <summary>
/// The cleanup of the snapshot folder. <c>SnapshotRetention.cs</c> uses no Revit type, so this project compiles it in by
/// a link. The folder is a temporary one: the real one holds the pictures of the person working in Revit.
/// </summary>
public sealed class SnapshotRetentionTests : IDisposable
{
    private static readonly DateTime Start = new(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc);

    private readonly DirectoryInfo _directory = Directory.CreateTempSubdirectory("revitmcp-snapshots-");

    public void Dispose()
    {
        foreach (var file in _directory.EnumerateFiles("*", SearchOption.AllDirectories))
        {
            file.Attributes = FileAttributes.Normal;
        }

        _directory.Delete(recursive: true);
    }

    private static string OurName(string view = "3D View - Вид 1") => $"{Guid.NewGuid():N} - {view}.png";

    private static SnapshotFile Ours(int minute) => new(OurName(), Start.AddMinutes(minute));

    private string Create(string name, int minute)
    {
        var path = Path.Combine(_directory.FullName, name);
        File.WriteAllText(path, "x");
        File.SetLastWriteTimeUtc(path, Start.AddMinutes(minute));
        return path;
    }

    [Fact]
    public void Keep_IsTwoHundred() => Assert.Equal(200, SnapshotRetention.Keep);

    [Theory]
    [InlineData("0123456789abcdef0123456789abcdef - 3D View - Вид 1.png")]
    [InlineData("0123456789abcdef0123456789abcdef - Floor Plan - Уровень 1.png")]
    [InlineData("0123456789abcdef0123456789abcdef - Sheet - A101 - Plan.png")]
    [InlineData("0123456789abcdef0123456789abcdef.png")]
    public void WasWrittenByUs_AcceptsTheNamesTheSnapshotCommandWrites(string name) =>
        Assert.True(SnapshotRetention.WasWrittenByUs(name));

    [Fact]
    public void WasWrittenByUs_AcceptsAFreshGuidInFormatN()
    {
        var name = Guid.NewGuid().ToString("N") + " - 3D View - Name.png";

        Assert.True(SnapshotRetention.WasWrittenByUs(name));
    }

    [Theory]
    [InlineData("")]
    [InlineData(".png")]
    [InlineData("photo.png")]
    [InlineData("notes.txt")]
    [InlineData("connection.json")]
    [InlineData("0123456789abcdef0123456789abcdef - 3D View - Name.jpg")]
    [InlineData("0123456789abcdef0123456789abcdef - 3D View - Name.PNG")]
    [InlineData("0123456789abcdef0123456789abcdef - 3D View - Name.png.bak")]
    [InlineData("0123456789ABCDEF0123456789ABCDEF - 3D View - Name.png")]
    [InlineData("0123456789abcdef0123456789abcde - 3D View - Name.png")]
    [InlineData("0123456789abcdef0123456789abcdefg - 3D View - Name.png")]
    [InlineData("0123456789abcdef0123456789abcdefx.png")]
    [InlineData("0123456789abcdef0123456789abcdef-3D View.png")]
    [InlineData("0123456789abcdef0123456789abcdex - 3D View - Name.png")]
    [InlineData("backup 0123456789abcdef0123456789abcdef - 3D View - Name.png")]
    public void WasWrittenByUs_RefusesEveryOtherFile(string name) =>
        Assert.False(SnapshotRetention.WasWrittenByUs(name));

    [Fact]
    public void SelectForRemoval_KeepsTheNewestAndListsTheOldestFirst()
    {
        var files = new[] { Ours(30), Ours(10), Ours(50), Ours(20), Ours(40) };

        var removed = SnapshotRetention.SelectForRemoval(files, keep: 2);

        Assert.Equal([files[1].Name, files[3].Name, files[0].Name], removed);
    }

    [Fact]
    public void SelectForRemoval_RemovesNothingUpToTheKeep()
    {
        var files = new[] { Ours(1), Ours(2), Ours(3) };

        Assert.Empty(SnapshotRetention.SelectForRemoval(files, keep: 3));
        Assert.Empty(SnapshotRetention.SelectForRemoval(files, keep: 4));
        Assert.Empty(SnapshotRetention.SelectForRemoval([], keep: 3));
    }

    [Fact]
    public void SelectForRemoval_WithNothingToKeepListsEveryFileOfOurs()
    {
        var files = new[] { Ours(2), Ours(1) };

        var removed = SnapshotRetention.SelectForRemoval(files, keep: 0);

        Assert.Equal([files[1].Name, files[0].Name], removed);
    }

    [Fact]
    public void SelectForRemoval_NeverListsAForeignFileAndDoesNotCountItToTheKeep()
    {
        var foreign = Enumerable.Range(100, 10)
            .Select(minute => new SnapshotFile($"photo-{minute}.png", Start.AddMinutes(minute)))
            .ToArray();
        var ours = new[] { Ours(1), Ours(2), Ours(3) };

        var removed = SnapshotRetention.SelectForRemoval([.. foreign, .. ours], keep: 2);

        Assert.Equal([ours[0].Name], removed);
    }

    [Fact]
    public void SelectForRemoval_GoesByNameForFilesOfTheSameAge()
    {
        var files = new[]
        {
            new SnapshotFile("cccccccccccccccccccccccccccccccc - 3D View - A.png", Start),
            new SnapshotFile("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa - 3D View - A.png", Start),
            new SnapshotFile("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb - 3D View - A.png", Start),
        };

        var forward = SnapshotRetention.SelectForRemoval(files, keep: 1);
        var backward = SnapshotRetention.SelectForRemoval(files.Reverse(), keep: 1);

        Assert.Equal([files[1].Name, files[2].Name], forward);
        Assert.Equal(forward, backward);
    }

    [Fact]
    public void SelectForRemoval_RefusesANegativeKeep() =>
        Assert.Throws<ArgumentOutOfRangeException>(() => SnapshotRetention.SelectForRemoval([Ours(1)], keep: -1));

    [Fact]
    public void Trim_RemovesTheOldestSnapshotsAndLeavesEverythingElse()
    {
        var snapshots = Enumerable.Range(1, 6).Select(minute => Create(OurName(), minute)).ToArray();
        var foreignPicture = Create("photo.png", 0);
        var foreignText = Create("notes.txt", 0);
        var subfolder = Directory.CreateDirectory(Path.Combine(_directory.FullName, "archive"));
        var nested = Path.Combine(subfolder.FullName, OurName());
        File.WriteAllText(nested, "x");
        File.SetLastWriteTimeUtc(nested, Start);

        var result = SnapshotRetention.Trim(_directory.FullName, keep: 3);

        Assert.Equal(new TrimResult(3, 0, null), result);
        Assert.All(snapshots.Take(3), path => Assert.False(File.Exists(path)));
        Assert.All(snapshots.Skip(3), path => Assert.True(File.Exists(path)));
        Assert.True(File.Exists(foreignPicture));
        Assert.True(File.Exists(foreignText));
        Assert.True(File.Exists(nested));
    }

    [Fact]
    public void Trim_WithTheRealKeepLeavesTwoHundredSnapshots()
    {
        var total = SnapshotRetention.Keep + 5;
        var snapshots = Enumerable.Range(0, total).Select(minute => Create(OurName(), minute)).ToArray();

        var result = SnapshotRetention.Trim(_directory.FullName, SnapshotRetention.Keep);

        Assert.Equal(5, result.Removed);
        Assert.Equal(SnapshotRetention.Keep, _directory.EnumerateFiles().Count());
        Assert.All(snapshots.Take(5), path => Assert.False(File.Exists(path)));
        Assert.True(File.Exists(snapshots[5]));
    }

    [Fact]
    public void Trim_DoesNothingWhenThereAreNotMoreThanTheKeep()
    {
        var snapshots = Enumerable.Range(1, 3).Select(minute => Create(OurName(), minute)).ToArray();

        var result = SnapshotRetention.Trim(_directory.FullName, keep: 3);

        Assert.Equal(default, result);
        Assert.All(snapshots, path => Assert.True(File.Exists(path)));
    }

    [Fact]
    public void Trim_ToleratesAMissingFolder()
    {
        var missing = Path.Combine(_directory.FullName, "never-created");

        var result = SnapshotRetention.Trim(missing, SnapshotRetention.Keep);

        Assert.Equal(default, result);
        Assert.False(Directory.Exists(missing));
    }

    [Fact]
    public void Trim_CountsAFileItCannotRemoveAndStillRemovesTheOthers()
    {
        var stuck = Create(OurName(), 1);
        File.SetAttributes(stuck, FileAttributes.ReadOnly);
        var removable = Create(OurName(), 2);
        var kept = Create(OurName(), 3);

        var result = SnapshotRetention.Trim(_directory.FullName, keep: 1);

        Assert.Equal(1, result.Removed);
        Assert.Equal(1, result.Failed);
        Assert.IsType<UnauthorizedAccessException>(result.FirstFailure);
        Assert.True(File.Exists(stuck));
        Assert.False(File.Exists(removable));
        Assert.True(File.Exists(kept));
    }
}
