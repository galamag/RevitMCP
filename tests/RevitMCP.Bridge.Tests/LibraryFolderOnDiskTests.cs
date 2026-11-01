using System.Runtime.InteropServices;
using System.Text;
using Xunit;

namespace RevitMCP.Bridge.Tests;

/// <summary>What <see cref="LibraryFolder.FindOnDisk(string)"/> does with a library of files, built here in a folder of its own.</summary>
public sealed class LibraryFolderOnDiskTests : IDisposable
{
    private const string FolderName = "Двери Бытовой";
    private const string FileName = "Дверь-Одинарная-Панель.rfa";

    private readonly string _root = Path.Combine(Path.GetTempPath(), "revitmcp-library-" + Guid.NewGuid().ToString("N"));

    public LibraryFolderOnDiskTests()
    {
        Directory.CreateDirectory(Path.Combine(_root, "Russia", FolderName));
        File.WriteAllBytes(Path.Combine(_root, "Russia", FolderName, FileName), []);
        File.WriteAllBytes(Path.Combine(_root, "Russia", FolderName, "Дверь-Одинарная-Панель.txt"), []);
        Directory.CreateDirectory(Path.Combine(_root, "Russia", "Папка.rfa"));
    }

    private string Stored => Path.Combine(_root, "Russia", FolderName, FileName);

    public void Dispose() => Directory.Delete(_root, recursive: true);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetShortPathName(string longPath, StringBuilder shortPath, uint length);

    [Fact]
    public void GivesTheNamesAsTheyAreStored()
    {
        Assert.Equal(Stored, LibraryFolder.FindOnDisk(_root, Stored));
        Assert.Equal(Stored, LibraryFolder.FindOnDisk(_root, Path.Combine(_root, "RUSSIA", FolderName.ToLowerInvariant(), FileName.ToLowerInvariant())));
        Assert.Equal(Stored, LibraryFolder.FindOnDisk(_root, Path.Combine(_root, "russia", FolderName.ToUpperInvariant(), FileName.ToUpperInvariant().Replace(".RFA", ".Rfa"))));
    }

    [Fact]
    public void GivesTheSameNameForEverySpellingOfTheFile()
    {
        var spellings = new[] { Stored, Stored.ToLowerInvariant(), Stored.ToUpperInvariant() };

        Assert.Single(spellings.Select(spelling => Path.GetFileNameWithoutExtension(LibraryFolder.FindOnDisk(_root, spelling))).Distinct(StringComparer.Ordinal));
    }

    [Fact]
    public void ExpandsShortNames()
    {
        var shortPath = new StringBuilder(512);
        var length = GetShortPathName(Stored, shortPath, (uint)shortPath.Capacity);

        // Without 8.3 names on the volume there is nothing to expand, and the long name comes back as the short one.
        Assert.SkipUnless(length != 0 && shortPath.ToString().Contains('~', StringComparison.Ordinal), "this volume makes no 8.3 short names");

        Assert.NotEqual(Stored, shortPath.ToString());
        Assert.Equal(Stored, LibraryFolder.FindOnDisk(_root, shortPath.ToString()));
    }

    [Fact]
    public void GivesNothingForAFileThatIsNotThere() => Assert.Null(LibraryFolder.FindOnDisk(_root, Path.Combine(_root, "Russia", FolderName, "Нет.rfa")));

    [Fact]
    public void GivesNothingForAFolderCalledLikeAFamily() => Assert.Null(LibraryFolder.FindOnDisk(_root, Path.Combine(_root, "Russia", "Папка.rfa")));

    [Fact]
    public void GivesNothingForOtherExtensions() => Assert.Null(LibraryFolder.FindOnDisk(_root, Path.ChangeExtension(Stored, ".txt")));

    [Fact]
    public void GivesNothingOutsideTheLibrary()
    {
        Assert.Null(LibraryFolder.FindOnDisk(_root, Path.Combine(_root, "..", Path.GetFileName(_root), "Russia", FolderName, FileName) + "x"));
        Assert.Null(LibraryFolder.FindOnDisk(_root + "2", Stored));
        Assert.Null(LibraryFolder.FindOnDisk(_root, Path.Combine(Path.GetTempPath(), FileName)));
        Assert.Null(LibraryFolder.FindOnDisk(_root, FileName));
    }

    [Fact]
    public void GivesNothingWhenTheLibraryIsNotThere() => Assert.Null(LibraryFolder.FindOnDisk(_root + "-none", Path.Combine(_root + "-none", "x.rfa")));
}

public class WindowsNamesTests
{
    [Theory]
    [InlineData("Дверь-Одинарная-Панель.rfa")]
    [InlineData("Окно 1-Распашное - Один. переплет - ГОСТ 30674-99.rfa")]
    [InlineData("CONSOLE")]
    [InlineData("COM")]
    [InlineData("LPT10.txt")]
    [InlineData("NUL x.rfa")]
    public void Check_KeepsWhatWindowsKeeps(string name) => Assert.Equal(NameProblem.None, WindowsNames.Check(name));

    [Theory]
    [InlineData(null, "Empty")]
    [InlineData("", "Empty")]
    [InlineData("  ", "Empty")]
    [InlineData("a:b", "ForbiddenCharacter")]
    [InlineData("a?b", "ForbiddenCharacter")]
    [InlineData("a\\b", "ForbiddenCharacter")]
    [InlineData("a ", "SpaceOrDotAtTheEnd")]
    [InlineData(" a", "SpaceOrDotAtTheEnd")]
    [InlineData("a.", "SpaceOrDotAtTheEnd")]
    [InlineData("...", "SpaceOrDotAtTheEnd")]
    [InlineData("CON", "DeviceName")]
    [InlineData("nul.txt", "DeviceName")]
    [InlineData("NUL .txt", "DeviceName")]
    [InlineData("com1   .rfa", "DeviceName")]
    [InlineData("LPT¹.x", "DeviceName")]
    [InlineData("CONOUT$", "DeviceName")]
    public void Check_SaysWhatIsWrong(string? name, string expected) => Assert.Equal(Enum.Parse<NameProblem>(expected), WindowsNames.Check(name));

    [Fact]
    public void TryGetNamesBelow_GivesTheNamesBelowTheRoot()
    {
        var root = Path.Combine(Path.GetTempPath(), "revitmcp-root");

        Assert.True(WindowsNames.TryGetNamesBelow(root, Path.Combine(root, "a", "Б.rfa"), out var names));
        Assert.Equal(["a", "Б.rfa"], names);
    }

    [Theory]
    [InlineData("")]
    [InlineData(@"..\x")]
    [InlineData(@"a\NUL .x")]
    [InlineData(@"a\b.")]
    public void TryGetNamesBelow_RefusesWhatIsNotBelowOrWouldBeRewritten(string relative)
    {
        var root = Path.Combine(Path.GetTempPath(), "revitmcp-root");

        Assert.False(WindowsNames.TryGetNamesBelow(root, root + @"\" + relative, out _));
    }

    [Fact]
    public void TryGetNamesBelow_RefusesASiblingWithTheSamePrefixAndTheRootItself()
    {
        var root = Path.Combine(Path.GetTempPath(), "revitmcp-root");

        Assert.False(WindowsNames.TryGetNamesBelow(root, Path.Combine(root + "2", "x"), out _));
        Assert.False(WindowsNames.TryGetNamesBelow(root, root, out _));
        Assert.False(WindowsNames.TryGetNamesBelow(root, @"x\y", out _));
    }
}
