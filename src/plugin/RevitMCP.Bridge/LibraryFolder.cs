using System.Text.RegularExpressions;

namespace RevitMCP.Bridge;

/// <summary>
/// The only folder family files may be loaded from, <c>C:\ProgramData\Autodesk\RVT 2027\Libraries\Russian</c>, the one content
/// set that is installed. A client names a file below it, never a path of its own, and only a family file (<c>.rfa</c>).
/// Names Windows would quietly rewrite are refused, because the file on disk would then not be the one the checks looked at.
/// </summary>
public static partial class LibraryFolder
{
    private const string Extension = ".rfa";

    private static readonly char[] Separators = ['\\', '/'];

    private static readonly char[] ForbiddenCharacters = Path.GetInvalidFileNameChars();

    /// <summary>The full path of the library, with no trailing separator.</summary>
    public static string Root { get; } = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
        "Autodesk",
        "RVT 2027",
        "Libraries",
        "Russian");

    /// <summary>
    /// Returns the full path of the family file called <paramref name="relativePath"/>, which is relative to <see cref="Root"/>
    /// and may use <c>\</c> or <c>/</c>. It holds no drive, no <c>.</c> and no <c>..</c>, and not even a <c>..</c> that would
    /// stay inside the library. The file name ends in <c>.rfa</c>, in any case. Cyrillic and spaces are kept exactly as given.
    /// It is not looked up on disk: that the file exists is for the caller to say.
    /// </summary>
    /// <exception cref="RequestFailedException">With <see cref="JsonRpcCodes.InvalidParams"/>, when the path is refused.</exception>
    public static string Resolve(string relativePath)
    {
        var problem = FindProblem(relativePath, out var segments);

        if (problem is not null)
        {
            throw Refuse(relativePath, problem);
        }

        var full = Path.Combine(Root, string.Join(Path.DirectorySeparatorChar, segments));

        // The segments cannot leave the library, so this is a second look from the other side, at the path that will be opened.
        return Contains(full) ? full : throw Refuse(relativePath, $"it does not resolve to a family file inside {Root}");
    }

    /// <summary>
    /// Tells whether <paramref name="path"/> is a fully qualified path of a family file below <see cref="Root"/>, not the folder
    /// itself. Case-insensitive, as Windows is. A path that fails to qualify, or that Windows would rewrite, is not.
    /// </summary>
    public static bool Contains(string path)
    {
        if (string.IsNullOrWhiteSpace(path) || !Path.IsPathFullyQualified(path) || path.EndsWith('.') || path.EndsWith(' '))
        {
            return false;
        }

        string full;
        try
        {
            full = Path.GetFullPath(path);
        }
        catch (Exception e) when (e is ArgumentException or NotSupportedException or PathTooLongException)
        {
            return false;
        }

        var prefix = Root + Path.DirectorySeparatorChar;

        if (!full.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        var segments = full[prefix.Length..].Split(Path.DirectorySeparatorChar);

        return segments.All(segment => FindSegmentProblem(segment) is null) && IsFamilyFileName(segments[^1]);
    }

    private static RequestFailedException Refuse(string? path, string problem) =>
        new(JsonRpcCodes.InvalidParams, $"'{path}' cannot be a family path: {problem}.");

    /// <summary>Says what is wrong with <paramref name="path"/>, or returns <c>null</c> and the segments it is made of.</summary>
    private static string? FindProblem(string? path, out string[] segments)
    {
        segments = [];

        if (string.IsNullOrWhiteSpace(path))
        {
            return "it is empty";
        }

        if (Path.IsPathRooted(path))
        {
            return $"it must be relative to {Root}, so no drive, no share and no leading separator";
        }

        segments = path.Split(Separators);
        foreach (var segment in segments)
        {
            if (segment is "." or "..")
            {
                return $"'{segment}' is not allowed anywhere in it, as it must not leave {Root}";
            }

            if (FindSegmentProblem(segment) is { } problem)
            {
                return problem;
            }
        }

        return IsFamilyFileName(segments[^1]) ? null : $"only a family file is taken, so the last name must end in {Extension}";
    }

    /// <summary>A name with something before the extension: <c>.rfa</c> alone is no family file.</summary>
    private static bool IsFamilyFileName(string name) =>
        name.Length > Extension.Length && name.EndsWith(Extension, StringComparison.OrdinalIgnoreCase);

    /// <summary>Says what is wrong with one folder or file name, or returns <c>null</c> when Windows would keep it as it is.</summary>
    private static string? FindSegmentProblem(string segment)
    {
        if (string.IsNullOrWhiteSpace(segment))
        {
            return "a folder or file name in it is empty";
        }

        if (segment.IndexOfAny(ForbiddenCharacters) >= 0)
        {
            return $"'{segment}' holds a character that Windows forbids in a name, such as : * ? \" < > |";
        }

        if (segment != segment.Trim() || segment.EndsWith('.'))
        {
            return $"'{segment}' starts or ends with a space or ends with a dot, which Windows would change";
        }

        return DeviceName().IsMatch(segment) ? $"'{segment}' is a Windows device name" : null;
    }

    /// <summary>Windows reserves these names whatever the extension, in any case.</summary>
    [GeneratedRegex(@"^(CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|(COM|LPT)[0-9¹²³])(\..*)?\z", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex DeviceName();
}
