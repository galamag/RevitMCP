namespace RevitMCP.Commands;

/// <summary>
/// Appends to <c>%LOCALAPPDATA%\RevitMCP\plugin.log</c>. Never throws, because it runs inside Revit.
/// Callers must not pass the token or the body of <c>connection.json</c>, and request params stay out too.
/// </summary>
public static class Log
{
    private const int MaxCleanLength = 64;

    private static readonly object Gate = new();

    private static readonly string FilePath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "RevitMCP",
        "plugin.log");

    public static void Info(string message) => Write("INFO", message, null);

    public static void Error(string message, Exception? exception = null) => Write("ERROR", message, exception);

    /// <summary>
    /// Makes text a client chose safe for one log line: at most 64 characters, with control characters replaced.
    /// Surrogates go too, because a cut can split a pair, and writing half a pair throws and loses the line.
    /// </summary>
    public static string Clean(string text) => string.Concat(
        text.Take(MaxCleanLength).Select(c => char.IsControl(c) || char.IsSurrogate(c) ? '?' : c));

    private static void Write(string level, string message, Exception? exception)
    {
        try
        {
            // Inside the try: formatting calls the exception's ToString, which can throw.
            var text = exception is null ? message : $"{message}{Environment.NewLine}{exception}";
            var line = $"{DateTimeOffset.Now:O} [{Environment.ProcessId}] {level} {text}{Environment.NewLine}";

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
