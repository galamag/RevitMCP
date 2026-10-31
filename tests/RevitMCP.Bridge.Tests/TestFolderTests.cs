using Xunit;

namespace RevitMCP.Bridge.Tests;

public class TestFolderTests
{
    private static string OtherDrive => (TestFolder.Root[0] == 'Z' ? "Y" : "Z") + TestFolder.Root[1..];

    private static void AssertRefused(string name)
    {
        var refusal = Assert.Throws<RequestFailedException>(() => TestFolder.Resolve(name));

        Assert.Equal(JsonRpcCodes.InvalidParams, refusal.Code);
    }

    [Theory]
    [InlineData(@"..\x")]
    [InlineData("../x")]
    [InlineData("..")]
    [InlineData("...")]
    [InlineData(@"a\..\..\x")]
    [InlineData("a..b")]
    public void Rejects_ParentTraversal(string name) => AssertRefused(name);

    [Theory]
    [InlineData(@"C:\Windows\x")]
    [InlineData(@"\\server\share\x")]
    [InlineData(@"\x")]
    [InlineData("/etc/x")]
    public void Rejects_AbsolutePath(string name) => AssertRefused(name);

    [Fact]
    public void Rejects_AbsolutePathInsideTheFolder() => AssertRefused(Path.Combine(TestFolder.Root, "x.rvt"));

    [Theory]
    [InlineData(@"Z:\x.rvt")]
    [InlineData("Z:x")]
    public void Rejects_OtherDrive(string name) => AssertRefused(name);

    [Theory]
    [InlineData("дом")]
    [InlineData("Тест проба")]
    [InlineData("проверка-задача9-120000")]
    [InlineData("Ёлка_й")]
    public void Accepts_CyrillicName(string name)
    {
        var path = TestFolder.Resolve(name);

        Assert.Equal(Path.Combine(TestFolder.Root, name + ".rvt"), path);
        Assert.True(TestFolder.Contains(path));
    }

    [Theory]
    [InlineData("дом.rvt")]
    [InlineData("дом.RVT")]
    [InlineData("дом.Rvt")]
    public void SuppliedRvtExtension_IsNotDoubled(string name) =>
        Assert.Equal(Path.Combine(TestFolder.Root, "дом.rvt"), TestFolder.Resolve(name));

    [Theory]
    [InlineData("дом.rte")]
    [InlineData("дом.rfa")]
    [InlineData("дом.txt")]
    [InlineData("дом.rvt.rvt")]
    [InlineData("дом.0001")]
    [InlineData("дом.0001.rvt")]
    [InlineData(".rvt")]
    public void Rejects_AnythingButTheRvtExtension(string name) => AssertRefused(name);

    [Theory]
    [InlineData("")]
    [InlineData(" ")]
    [InlineData("\t")]
    public void Rejects_EmptyName(string name) => AssertRefused(name);

    [Fact]
    public void Rejects_NullName() => AssertRefused(null!);

    [Theory]
    [InlineData("CON")]
    [InlineData("con")]
    [InlineData("PRN")]
    [InlineData("AUX")]
    [InlineData("NUL")]
    [InlineData("COM1")]
    [InlineData("lpt9")]
    [InlineData("COM¹")]
    [InlineData("CONIN$")]
    [InlineData("CONOUT$")]
    [InlineData("NUL.rvt")]
    public void Rejects_DeviceName(string name) => AssertRefused(name);

    [Theory]
    [InlineData("CONSOLE")]
    [InlineData("COM")]
    [InlineData("LPT10")]
    public void Accepts_NameThatOnlyLooksLikeADevice(string name) =>
        Assert.Equal(Path.Combine(TestFolder.Root, name + ".rvt"), TestFolder.Resolve(name));

    [Theory]
    [InlineData("дом.")]
    [InlineData("дом ")]
    [InlineData(" дом")]
    [InlineData("дом .rvt")]
    [InlineData("дом..rvt")]
    public void Rejects_DotOrSpaceWindowsWouldDrop(string name) => AssertRefused(name);

    [Theory]
    [InlineData("a:b")]
    [InlineData("a*b")]
    [InlineData("a?b")]
    [InlineData("a\"b")]
    [InlineData("a<b")]
    [InlineData("a>b")]
    [InlineData("a|b")]
    [InlineData("a\0b")]
    [InlineData("a\nb")]
    public void Rejects_CharactersWindowsForbids(string name) => AssertRefused(name);

    [Fact]
    public void Refusal_NamesTheInput()
    {
        var refusal = Assert.Throws<RequestFailedException>(() => TestFolder.Resolve(@"..\x"));

        Assert.Contains(@"..\x", refusal.Message);
    }

    [Fact]
    public void Contains_IsCaseInsensitive()
    {
        Assert.True(TestFolder.Contains(Path.Combine(TestFolder.Root.ToUpperInvariant(), "ТЕСТ.RVT")));
        Assert.True(TestFolder.Contains(Path.Combine(TestFolder.Root.ToLowerInvariant(), "тест.rvt")));
    }

    [Theory]
    [InlineData("2")]
    [InlineData(" copy")]
    [InlineData("-old")]
    [InlineData(".rvt")]
    public void Contains_RejectsSiblingWithSamePrefix(string suffix) =>
        Assert.False(TestFolder.Contains(Path.Combine(TestFolder.Root + suffix, "x.rvt")));

    [Fact]
    public void Contains_RejectsTheFolderItself()
    {
        Assert.False(TestFolder.Contains(TestFolder.Root));
        Assert.False(TestFolder.Contains(TestFolder.Root + @"\"));
    }

    [Theory]
    [InlineData(@"..\x.rvt")]
    [InlineData(@"a\..\..\x.rvt")]
    public void Contains_RejectsPathThatLeavesTheFolder(string relative) =>
        Assert.False(TestFolder.Contains(TestFolder.Root + @"\" + relative));

    [Fact]
    public void Contains_AcceptsPathThatStaysInside()
    {
        Assert.True(TestFolder.Contains(TestFolder.Root + @"\a\..\x.rvt"));
        Assert.True(TestFolder.Contains(TestFolder.Root + "/x.rvt"));
        Assert.True(TestFolder.Contains(TestFolder.Root + @"\Коттедж.0001.rvt"));
    }

    [Fact]
    public void Contains_RejectsOtherDrive() => Assert.False(TestFolder.Contains(Path.Combine(OtherDrive, "x.rvt")));

    [Theory]
    [InlineData("x.rvt")]
    [InlineData(@"a\x.rvt")]
    [InlineData("C:x.rvt")]
    [InlineData(@"\x.rvt")]
    [InlineData(@"..\x.rvt")]
    public void Contains_RejectsPathThatDependsOnTheCurrentDirectory(string path) =>
        Assert.False(TestFolder.Contains(path));

    [Theory]
    [InlineData("CON.rvt")]
    [InlineData("nul")]
    [InlineData(@"COM1\x.rvt")]
    [InlineData("x.rvt.")]
    [InlineData("x.rvt ")]
    [InlineData("x.rvt:stream")]
    public void Contains_RejectsNameWindowsWouldRewrite(string relative) =>
        Assert.False(TestFolder.Contains(TestFolder.Root + @"\" + relative));

    [Theory]
    [InlineData("")]
    [InlineData(" ")]
    [InlineData(null)]
    public void Contains_RejectsEmptyPath(string? path) => Assert.False(TestFolder.Contains(path!));

    [Fact]
    public void Root_IsTheFolderInTheUserProfile()
    {
        var profile = Environment.GetEnvironmentVariable("USERPROFILE")!;

        Assert.Equal(Path.Combine(profile, "Documents", "RevitMCP"), TestFolder.Root, ignoreCase: true);
    }
}
