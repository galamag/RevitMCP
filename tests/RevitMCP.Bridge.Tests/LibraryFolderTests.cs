using Xunit;

namespace RevitMCP.Bridge.Tests;

public class LibraryFolderTests
{
    private const string Door = @"Russia\Двери\Бытовой\Дверь-Внутренняя-Одинарная-1_Панель-Дерево.rfa";

    /// <summary>A real file of the library: spaces, a dot inside the name, and digits and dashes.</summary>
    private const string GostWindow =
        @"Russia\Окна\Для России\ГОСТ 30674-99\Окно 1-Распашное - Один. переплет с несколькими оконными стеклами - ГОСТ 30674-99.rfa";

    private static string OtherDrive => (LibraryFolder.Root[0] == 'Z' ? "Y" : "Z") + LibraryFolder.Root[1..];

    private static void AssertRefused(string path)
    {
        var refusal = Assert.Throws<RequestFailedException>(() => LibraryFolder.Resolve(path));

        Assert.Equal(JsonRpcCodes.InvalidParams, refusal.Code);
    }

    [Theory]
    [InlineData(@"..\x.rfa")]
    [InlineData("../x.rfa")]
    [InlineData("..")]
    [InlineData("...")]
    [InlineData(@"a\..\..\x.rfa")]
    [InlineData(@"Russia\..\..\Windows\x.rfa")]
    [InlineData(@"Russia\..\Russia\x.rfa")]
    [InlineData(@".\x.rfa")]
    [InlineData(@"Russia\.\x.rfa")]
    [InlineData(@"Russia\..")]
    public void Rejects_ParentTraversal(string path) => AssertRefused(path);

    [Theory]
    [InlineData(@"C:\Windows\x.rfa")]
    [InlineData(@"\\server\share\x.rfa")]
    [InlineData(@"\x.rfa")]
    [InlineData("/etc/x.rfa")]
    [InlineData("C:x.rfa")]
    public void Rejects_AbsolutePath(string path) => AssertRefused(path);

    [Fact]
    public void Rejects_AbsolutePathInsideTheLibrary() => AssertRefused(Path.Combine(LibraryFolder.Root, "Russia", "x.rfa"));

    [Theory]
    [InlineData(@"Z:\x.rfa")]
    [InlineData("Z:x")]
    [InlineData(@"Russia\x.rfa:stream")]
    public void Rejects_OtherDriveAndStreams(string path) => AssertRefused(path);

    [Theory]
    [InlineData(@"Russia\x.rvt")]
    [InlineData(@"Russia\x.txt")]
    [InlineData(@"Russia\x.rte")]
    [InlineData(@"Russia\x.dll")]
    [InlineData(@"Russia\x.rfa.txt")]
    [InlineData(@"Russia\x.rfa.exe")]
    [InlineData(@"Russia\x.rfa.rfa.bak")]
    [InlineData(@"Russia\x")]
    [InlineData(@"Russia\.rfa")]
    [InlineData("rfa")]
    [InlineData(@"Russia\Двери")]
    [InlineData(@"Russia\Двери\")]
    public void Rejects_OtherExtension(string path) => AssertRefused(path);

    [Theory]
    [InlineData(Door)]
    [InlineData(GostWindow)]
    [InlineData(@"Russia\Мебель\Кровати\Кровать-Стандарт.rfa")]
    [InlineData(@"Russia\Озеленение\RPC Дерево - листопадное.rfa")]
    [InlineData(@"Russia\Сантехника\Архитектурные\Приборы\Ванны\Ванна-Прямоугольная-3D.rfa")]
    [InlineData(@"Ёлка й\Ёж_1.rfa")]
    public void Accepts_CyrillicPath(string path)
    {
        var full = LibraryFolder.Resolve(path);

        Assert.Equal(Path.Combine(LibraryFolder.Root, path), full);
        Assert.True(LibraryFolder.Contains(full));
    }

    [Theory]
    [InlineData(@"Russia\Мебель\Кровати\Кровать-Стандарт.RFA")]
    [InlineData(@"Russia\Мебель\Кровати\Кровать-Стандарт.Rfa")]
    public void Accepts_TheExtensionInAnyCase(string path) => Assert.Equal(Path.Combine(LibraryFolder.Root, path), LibraryFolder.Resolve(path));

    [Fact]
    public void Accepts_ForwardSlashes_AsTheSamePath()
    {
        var full = LibraryFolder.Resolve("Russia/Мебель/Кровати/Кровать-Стандарт.rfa");

        Assert.Equal(Path.Combine(LibraryFolder.Root, @"Russia\Мебель\Кровати\Кровать-Стандарт.rfa"), full);
    }

    [Fact]
    public void Accepts_AFileDirectlyInTheLibrary() =>
        Assert.Equal(Path.Combine(LibraryFolder.Root, "x.rfa"), LibraryFolder.Resolve("x.rfa"));

    [Theory]
    [InlineData("")]
    [InlineData(" ")]
    [InlineData("\t")]
    public void Rejects_EmptyPath(string path) => AssertRefused(path);

    [Fact]
    public void Rejects_NullPath() => AssertRefused(null!);

    [Theory]
    [InlineData(@"Russia\\x.rfa")]
    [InlineData(@"Russia//x.rfa")]
    [InlineData(@"Russia\ \x.rfa")]
    public void Rejects_EmptyFolderName(string path) => AssertRefused(path);

    [Theory]
    [InlineData(@"CON\x.rfa")]
    [InlineData(@"Russia\nul\x.rfa")]
    [InlineData(@"Russia\COM1.rfa")]
    [InlineData(@"Russia\lpt9.rfa")]
    [InlineData(@"Russia\CONIN$.rfa")]
    [InlineData("NUL .rfa")]
    [InlineData(@"Russia\NUL .rfa")]
    [InlineData(@"Russia\com1   .rfa")]
    [InlineData(@"nul \x.rfa")]
    public void Rejects_DeviceName(string path) => AssertRefused(path);

    [Theory]
    [InlineData("CONSOLE.rfa")]
    [InlineData("COM.rfa")]
    [InlineData(@"LPT10\x.rfa")]
    public void Accepts_NameThatOnlyLooksLikeADevice(string path) => Assert.Equal(Path.Combine(LibraryFolder.Root, path), LibraryFolder.Resolve(path));

    [Theory]
    [InlineData(@"Russia \x.rfa")]
    [InlineData(@" Russia\x.rfa")]
    [InlineData(@"Russia.\x.rfa")]
    [InlineData(@"Russia\x.rfa.")]
    [InlineData(@"Russia\x.rfa ")]
    public void Rejects_DotOrSpaceWindowsWouldDrop(string path) => AssertRefused(path);

    [Theory]
    [InlineData("a*b.rfa")]
    [InlineData("a?b.rfa")]
    [InlineData("a\"b.rfa")]
    [InlineData("a<b.rfa")]
    [InlineData("a>b.rfa")]
    [InlineData("a|b.rfa")]
    [InlineData("a\0b.rfa")]
    [InlineData("a\nb.rfa")]
    public void Rejects_CharactersWindowsForbids(string path) => AssertRefused(path);

    [Theory]
    [InlineData("2")]
    [InlineData(" copy")]
    [InlineData("-old")]
    [InlineData(".rfa")]
    public void Rejects_SiblingWithSamePrefix(string suffix)
    {
        Assert.False(LibraryFolder.Contains(Path.Combine(LibraryFolder.Root + suffix, "x.rfa")));
        AssertRefused(@"..\Russian" + suffix + @"\x.rfa");
    }

    [Fact]
    public void Refusal_NamesTheInput()
    {
        var refusal = Assert.Throws<RequestFailedException>(() => LibraryFolder.Resolve(@"..\x.rfa"));

        Assert.Contains(@"..\x.rfa", refusal.Message);
    }

    [Fact]
    public void Refusal_OfAnOtherExtension_SaysWhichIsTaken()
    {
        var refusal = Assert.Throws<RequestFailedException>(() => LibraryFolder.Resolve(@"Russia\x.txt"));

        Assert.Contains(".rfa", refusal.Message);
    }

    [Fact]
    public void Contains_IsCaseInsensitive()
    {
        Assert.True(LibraryFolder.Contains(Path.Combine(LibraryFolder.Root.ToUpperInvariant(), "РОССИЯ", "ТЕСТ.RFA")));
        Assert.True(LibraryFolder.Contains(Path.Combine(LibraryFolder.Root.ToLowerInvariant(), "россия", "тест.rfa")));
    }

    [Fact]
    public void Contains_RejectsTheFolderItself()
    {
        Assert.False(LibraryFolder.Contains(LibraryFolder.Root));
        Assert.False(LibraryFolder.Contains(LibraryFolder.Root + @"\"));
    }

    [Theory]
    [InlineData(@"..\x.rfa")]
    [InlineData(@"a\..\..\x.rfa")]
    [InlineData(@"..\Russian2\x.rfa")]
    public void Contains_RejectsPathThatLeavesTheLibrary(string relative) =>
        Assert.False(LibraryFolder.Contains(LibraryFolder.Root + @"\" + relative));

    [Fact]
    public void Contains_RejectsOtherExtensionsInsideTheLibrary()
    {
        Assert.False(LibraryFolder.Contains(LibraryFolder.Root + @"\Russia\x.txt"));
        Assert.False(LibraryFolder.Contains(LibraryFolder.Root + @"\Russia\x.rfa.txt"));
        Assert.False(LibraryFolder.Contains(LibraryFolder.Root + @"\Russia\.rfa"));
    }

    [Fact]
    public void Contains_RejectsOtherDrive() => Assert.False(LibraryFolder.Contains(Path.Combine(OtherDrive, "x.rfa")));

    [Theory]
    [InlineData("x.rfa")]
    [InlineData(@"a\x.rfa")]
    [InlineData("C:x.rfa")]
    [InlineData(@"\x.rfa")]
    [InlineData(@"..\x.rfa")]
    public void Contains_RejectsPathThatDependsOnTheCurrentDirectory(string path) => Assert.False(LibraryFolder.Contains(path));

    [Theory]
    [InlineData("CON.rfa")]
    [InlineData("nul")]
    [InlineData(@"COM1\x.rfa")]
    [InlineData("x.rfa.")]
    [InlineData("x.rfa ")]
    [InlineData("x.rfa:stream")]
    public void Contains_RejectsNameWindowsWouldRewrite(string relative) =>
        Assert.False(LibraryFolder.Contains(LibraryFolder.Root + @"\" + relative));

    [Theory]
    [InlineData("")]
    [InlineData(" ")]
    [InlineData(null)]
    public void Contains_RejectsEmptyPath(string? path) => Assert.False(LibraryFolder.Contains(path!));

    [Theory]
    [InlineData("NUL .rfa")]
    [InlineData("Russia/COM1  .rfa")]
    public void Contains_RejectsDeviceNameWithSpacesBeforeTheDot(string relative) =>
        Assert.False(LibraryFolder.Contains(LibraryFolder.Root + @"\" + relative));

    [Fact]
    public void Root_IsTheRussianLibraryInProgramData()
    {
        var programData = Environment.GetEnvironmentVariable("ProgramData")!;

        Assert.Equal(Path.Combine(programData, "Autodesk", "RVT 2027", "Libraries", "Russian"), LibraryFolder.Root, ignoreCase: true);
    }
}
