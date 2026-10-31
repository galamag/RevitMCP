using System.Text.Json;
using Xunit;

namespace RevitMCP.Bridge.Tests;

public class ContractTests
{
    [Fact]
    public void Contract_MethodNamesMatchProtocolJson()
    {
        using var contract = JsonDocument.Parse(File.ReadAllBytes(FindProtocolJson()));
        var root = contract.RootElement;

        var methods = root.GetProperty("methods").EnumerateArray().Select(method => method.GetString()!);

        Assert.Equal(MethodNames.All.Order(StringComparer.Ordinal), methods.Order(StringComparer.Ordinal));
        Assert.Equal(BridgeServer.ProtocolVersion, root.GetProperty("protocolVersion").GetInt32());
    }

    [Fact]
    public void Contract_ImmediateMethodsAreTheThreeThatNeedNoMainThread()
    {
        Assert.Equal(
            [MethodNames.CancelRequest, MethodNames.GetRequestStatus, MethodNames.GetStatus],
            MethodNames.Immediate.Order(StringComparer.Ordinal));
        Assert.Empty(MethodNames.Immediate.Except(MethodNames.All));
    }

    /// <summary>Walks up from the test assembly to the repository root.</summary>
    private static string FindProtocolJson()
    {
        for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory is not null; directory = directory.Parent)
        {
            var candidate = Path.Combine(directory.FullName, "src", "contract", "protocol.json");
            if (File.Exists(candidate))
            {
                return candidate;
            }
        }

        throw new FileNotFoundException("No src/contract/protocol.json above " + AppContext.BaseDirectory);
    }
}
