namespace RevitMCP.Commands;

/// <summary>A file of the snapshot folder as the cleanup sees it: its name and when it was last written.</summary>
internal readonly record struct SnapshotFile(string Name, DateTime WrittenUtc);

/// <summary>What <see cref="SnapshotRetention.Trim"/> did. <paramref name="FirstFailure"/> is null when nothing failed.</summary>
internal readonly record struct TrimResult(int Removed, int Failed, Exception? FirstFailure);

/// <summary>
/// Keeps the snapshot folder from growing for ever: every <c>get_view_snapshot</c> call adds one PNG, and nothing else
/// removes them. Only files this plugin wrote are touched, and the newest <see cref="Keep"/> of them stay.
/// Uses no Revit type, so the tests compile it in by a link.
/// </summary>
internal static class SnapshotRetention
{
    /// <summary>How many of the newest snapshots stay.</summary>
    public const int Keep = 200;

    private const int GuidLength = 32;
    private const string Separator = " - ";
    private const string Extension = ".png";

    /// <summary><c>%LOCALAPPDATA%\RevitMCP\snapshots</c>, beside <c>connection.json</c>. The server reads files from here and nowhere else.</summary>
    public static string Folder { get; } = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "RevitMCP",
        "snapshots");

    /// <summary>
    /// True for a name <c>GetViewSnapshotCommand</c> gives: a <c>Guid</c> in format <c>N</c> (32 lowercase hex digits),
    /// then optionally <c>" - "</c> and what Revit appends, then <c>.png</c>. Any other file in the folder is not ours.
    /// </summary>
    public static bool WasWrittenByUs(string fileName)
    {
        if (!fileName.EndsWith(Extension, StringComparison.Ordinal))
        {
            return false;
        }

        var stem = fileName.AsSpan(0, fileName.Length - Extension.Length);
        if (stem.Length < GuidLength)
        {
            return false;
        }

        foreach (var c in stem[..GuidLength])
        {
            if (!char.IsAsciiHexDigitLower(c))
            {
                return false;
            }
        }

        return stem.Length == GuidLength || stem[GuidLength..].StartsWith(Separator, StringComparison.Ordinal);
    }

    /// <summary>
    /// The names to remove, oldest first: everything of ours except the <paramref name="keep"/> newest. Files of equal age
    /// go by name, so the answer does not depend on the order the folder was listed in.
    /// </summary>
    public static IReadOnlyList<string> SelectForRemoval(IEnumerable<SnapshotFile> files, int keep)
    {
        ArgumentNullException.ThrowIfNull(files);
        ArgumentOutOfRangeException.ThrowIfNegative(keep);

        var ours = files
            .Where(file => WasWrittenByUs(file.Name))
            .OrderBy(file => file.WrittenUtc)
            .ThenBy(file => file.Name, StringComparer.Ordinal)
            .ToList();

        return ours.Take(Math.Max(0, ours.Count - keep)).Select(file => file.Name).ToList();
    }

    /// <summary>
    /// Removes the old snapshots of <paramref name="folder"/>, not its subfolders. A file that cannot be removed, locked
    /// or read-only, is counted and skipped, so one stuck file does not keep the others. A missing folder is no error.
    /// </summary>
    public static TrimResult Trim(string folder, int keep)
    {
        var directory = new DirectoryInfo(folder);
        if (!directory.Exists)
        {
            return default;
        }

        var files = directory.EnumerateFiles().Select(file => new SnapshotFile(file.Name, file.LastWriteTimeUtc)).ToList();
        var removed = 0;
        var failed = 0;
        Exception? firstFailure = null;

        foreach (var name in SelectForRemoval(files, keep))
        {
            try
            {
                File.Delete(Path.Combine(folder, name));
                removed++;
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
                failed++;
                firstFailure ??= e;
            }
        }

        return new TrimResult(removed, failed, firstFailure);
    }
}
