using System.Text.RegularExpressions;

namespace RevitMCP.Bridge;

/// <summary>
/// The only folder the project tools may touch, <c>%USERPROFILE%\Documents\RevitMCP</c>. A client names a project, never
/// a path. Names Windows would quietly rewrite are refused, because the file on disk would then not be the one the
/// checks here looked at.
/// </summary>
public static partial class TestFolder
{
    private const string Extension = ".rvt";

    private static readonly char[] ForbiddenCharacters = Path.GetInvalidFileNameChars();

    /// <summary>The full path of the folder, with no trailing separator.</summary>
    public static string Root { get; } = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
        "Documents",
        "RevitMCP");

    /// <summary>
    /// Returns the full path of the project called <paramref name="name"/>, which may end in <c>.rvt</c> in any case.
    /// The name can hold no other dot, which leaves no way to spell a parent folder, another extension or a Revit
    /// backup such as <c>name.0001.rvt</c>. Cyrillic is kept exactly as given.
    /// </summary>
    /// <exception cref="RequestFailedException">With <see cref="JsonRpcCodes.InvalidParams"/>, when the name is refused.</exception>
    public static string Resolve(string name)
    {
        var stem = name?.EndsWith(Extension, StringComparison.OrdinalIgnoreCase) == true ? name[..^Extension.Length] : name;

        var problem = FindProblem(stem);
        if (problem is null && stem!.Contains('.'))
        {
            problem = $"apart from an optional {Extension} ending it may hold no dot";
        }

        return problem is null
            ? Path.Combine(Root, stem + Extension)
            : throw new RequestFailedException(JsonRpcCodes.InvalidParams, $"'{name}' cannot be a project name: {problem}.");
    }

    /// <summary>
    /// Tells whether <paramref name="path"/> is a fully qualified path of something below <see cref="Root"/>, not the
    /// folder itself. Case-insensitive, as Windows is. A path that fails to qualify, or that Windows would rewrite, is not.
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

        return full.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)
            && full[prefix.Length..].Split(Path.DirectorySeparatorChar).All(segment => FindProblem(segment) is null);
    }

    /// <summary>Says what is wrong with one path segment, or returns <c>null</c> when Windows would keep it as it is.</summary>
    private static string? FindProblem(string? segment)
    {
        if (string.IsNullOrWhiteSpace(segment))
        {
            return "it is empty";
        }

        if (segment.IndexOfAny(ForbiddenCharacters) >= 0)
        {
            return "it must be a bare file name, so no folders, drives or characters that Windows forbids in a file name";
        }

        if (segment != segment.Trim() || segment.EndsWith('.'))
        {
            return "it starts or ends with a space or ends with a dot, which Windows would change";
        }

        return DeviceName().IsMatch(segment) ? "it is a Windows device name" : null;
    }

    /// <summary>Windows reserves these names whatever the extension, in any case.</summary>
    [GeneratedRegex(@"^(CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|(COM|LPT)[0-9¹²³])(\..*)?\z", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex DeviceName();
}
