using System.Text.Json;

namespace RevitMCP.Bridge;

/// <summary>What a client needs to reach the bridge.</summary>
public sealed record ConnectionInfo(int Port, string Token, int Pid, int ProtocolVersion)
{
    /// <summary>Leaves the token out, so logging this record cannot leak it.</summary>
    public override string ToString() =>
        $"ConnectionInfo {{ Port = {Port}, Pid = {Pid}, ProtocolVersion = {ProtocolVersion} }}";
}

/// <summary>
/// The <c>connection.json</c> file that tells clients where the bridge listens. Its folder sits under
/// <c>%LOCALAPPDATA%</c>, whose default ACL is what keeps the token away from other users.
/// </summary>
public static class ConnectionFile
{
    /// <summary>
    /// Writes the file atomically: a reader sees the old content or the new one, never a partial token.
    /// Creates the folder if needed.
    /// </summary>
    public static void Write(string path, ConnectionInfo info)
    {
        ArgumentNullException.ThrowIfNull(path);
        ArgumentNullException.ThrowIfNull(info);

        var fullPath = Path.GetFullPath(path);
        Directory.CreateDirectory(Path.GetDirectoryName(fullPath)!);

        // Same folder as the target: File.Move is only atomic within one volume.
        var temporaryPath = $"{fullPath}.{Guid.NewGuid():N}.tmp";
        try
        {
            File.WriteAllBytes(temporaryPath, JsonSerializer.SerializeToUtf8Bytes(info, JsonSerializerOptions.Web));
            File.Move(temporaryPath, fullPath, overwrite: true);
        }
        finally
        {
            File.Delete(temporaryPath);
        }
    }

    /// <summary>
    /// Returns <c>true</c> when this process may take the file over: it does not exist, it names no owner,
    /// or its owner is dead. A file that exists but cannot be read throws, because its owner is unknown.
    /// </summary>
    public static bool CanClaim(string path, Func<int, bool> isProcessAlive)
    {
        ArgumentNullException.ThrowIfNull(path);
        ArgumentNullException.ThrowIfNull(isProcessAlive);

        byte[] content;
        try
        {
            content = File.ReadAllBytes(path);
        }
        catch (Exception e) when (e is FileNotFoundException or DirectoryNotFoundException)
        {
            return true;
        }

        return ReadOwnerPid(content) is not { } pid || !isProcessAlive(pid);
    }

    private static int? ReadOwnerPid(byte[] content)
    {
        try
        {
            using var document = JsonDocument.Parse(content);
            return document.RootElement.ValueKind == JsonValueKind.Object
                && document.RootElement.TryGetProperty("pid", out var pid)
                && pid.ValueKind == JsonValueKind.Number
                && pid.TryGetInt32(out var value)
                && value > 0
                ? value
                : null;
        }
        catch (JsonException)
        {
            return null;
        }
    }
}
