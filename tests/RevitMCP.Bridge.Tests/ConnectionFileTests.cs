using System.Text.Json;
using Xunit;

namespace RevitMCP.Bridge.Tests;

public sealed class ConnectionFileTests : IDisposable
{
    private static readonly ConnectionInfo Info = new(50123, "secret-token", 4242, BridgeServer.ProtocolVersion);

    private readonly DirectoryInfo _directory = Directory.CreateTempSubdirectory("revitmcp-tests-");

    private string FilePath => Path.Combine(_directory.FullName, "connection.json");

    public void Dispose() => _directory.Delete(recursive: true);

    [Fact]
    public void ConnectionFile_ClaimsWhenOwnerProcessDead()
    {
        ConnectionFile.Write(FilePath, Info);

        Assert.True(ConnectionFile.CanClaim(FilePath, _ => false));
    }

    [Fact]
    public void ConnectionFile_RefusesWhenOwnerAlive()
    {
        ConnectionFile.Write(FilePath, Info);
        var askedAbout = 0;

        var canClaim = ConnectionFile.CanClaim(FilePath, pid =>
        {
            askedAbout = pid;
            return true;
        });

        Assert.False(canClaim);
        Assert.Equal(Info.Pid, askedAbout);
    }

    [Fact]
    public void ConnectionFile_ClaimsWhenFileIsMissing()
    {
        Assert.True(ConnectionFile.CanClaim(FilePath, _ => true));
        Assert.True(ConnectionFile.CanClaim(Path.Combine(_directory.FullName, "no-such-folder", "connection.json"), _ => true));
    }

    [Theory]
    [InlineData("")]
    [InlineData("{not json")]
    [InlineData("[]")]
    [InlineData("""{"port":1}""")]
    [InlineData("""{"pid":"4242"}""")]
    [InlineData("""{"pid":0}""")]
    [InlineData("""{"pid":99999999999}""")]
    public void ConnectionFile_ClaimsWhenItNamesNoOwner(string content)
    {
        File.WriteAllText(FilePath, content);

        Assert.True(ConnectionFile.CanClaim(FilePath, _ => true));
    }

    [Fact]
    public void Write_ProducesCamelCaseJsonThatNodeCanParse()
    {
        ConnectionFile.Write(FilePath, Info);

        var bytes = File.ReadAllBytes(FilePath);
        Assert.Equal((byte)'{', bytes[0]);

        using var document = JsonDocument.Parse(bytes);
        var root = document.RootElement;
        Assert.Equal(Info.Port, root.GetProperty("port").GetInt32());
        Assert.Equal(Info.Token, root.GetProperty("token").GetString());
        Assert.Equal(Info.Pid, root.GetProperty("pid").GetInt32());
        Assert.Equal(Info.ProtocolVersion, root.GetProperty("protocolVersion").GetInt32());
    }

    [Fact]
    public void Write_ReplacesTheOldFile_AndLeavesNoTemporaryFile()
    {
        ConnectionFile.Write(FilePath, Info);

        ConnectionFile.Write(FilePath, Info with { Port = 50124 });

        using var document = JsonDocument.Parse(File.ReadAllBytes(FilePath));
        Assert.Equal(50124, document.RootElement.GetProperty("port").GetInt32());
        Assert.Equal(FilePath, Assert.Single(Directory.GetFiles(_directory.FullName)));
    }

    [Fact]
    public void Write_CreatesTheFolder()
    {
        var path = Path.Combine(_directory.FullName, "RevitMCP", "connection.json");

        ConnectionFile.Write(path, Info);

        Assert.True(File.Exists(path));
    }

    [Fact]
    public void Write_LeavesNoTemporaryFile_WhenTheMoveFails()
    {
        Directory.CreateDirectory(FilePath);

        Assert.ThrowsAny<Exception>(() => ConnectionFile.Write(FilePath, Info));

        Assert.Empty(Directory.GetFiles(_directory.FullName));
    }
}
