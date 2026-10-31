namespace RevitMCP.Plugin;

/// <summary>
/// Appends to <c>%LOCALAPPDATA%\RevitMCP\plugin.log</c>. Never throws, because it runs inside Revit.
/// Callers must not pass the token or the body of <c>connection.json</c>, and request params stay out too.
/// </summary>
public static class Log
{
    private static readonly object Gate = new();

    private static readonly string FilePath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "RevitMCP",
        "plugin.log");

    public static void Info(string message) => Write("INFO", message);

    public static void Error(string message, Exception? exception = null) =>
        Write("ERROR", exception is null ? message : $"{message}{Environment.NewLine}{exception}");

    private static void Write(string level, string message)
    {
        var line = $"{DateTimeOffset.Now:O} [{Environment.ProcessId}] {level} {message}{Environment.NewLine}";
        try
        {
            lock (Gate)
            {
                Directory.CreateDirectory(Path.GetDirectoryName(FilePath)!);
                File.AppendAllText(FilePath, line);
            }
        }
        catch (Exception)
        {
            // A line lost to a full disk or a second Revit holding the file is not worth failing a request.
        }
    }
}
