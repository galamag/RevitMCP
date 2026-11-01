using System.Diagnostics.CodeAnalysis;
using System.Text.RegularExpressions;

namespace RevitMCP.Bridge;

/// <summary>What is wrong with one file or folder name, for the folders the tools may touch.</summary>
internal enum NameProblem
{
    None,
    Empty,
    ForbiddenCharacter,
    SpaceOrDotAtTheEnd,
    DeviceName,
}

/// <summary>
/// The checks that <see cref="TestFolder"/> and <see cref="LibraryFolder"/> share: which names Windows would quietly rewrite or
/// take for something else, so that the file on disk would not be the one the checks looked at, and whether a full path lies
/// below a folder. Each folder words the refusal itself.
/// </summary>
internal static partial class WindowsNames
{
    private static readonly char[] ForbiddenCharacters = Path.GetInvalidFileNameChars();

    /// <summary>Says what is wrong with one name, or <see cref="NameProblem.None"/> when Windows would keep it as it is.</summary>
    public static NameProblem Check(string? name)
    {
        if (string.IsNullOrWhiteSpace(name))
        {
            return NameProblem.Empty;
        }

        if (name.IndexOfAny(ForbiddenCharacters) >= 0)
        {
            return NameProblem.ForbiddenCharacter;
        }

        if (name != name.Trim() || name.EndsWith('.'))
        {
            return NameProblem.SpaceOrDotAtTheEnd;
        }

        return DeviceName().IsMatch(name) ? NameProblem.DeviceName : NameProblem.None;
    }

    /// <summary>
    /// Takes the names of a fully qualified <paramref name="path"/> below <paramref name="root"/>, not the folder itself, when all
    /// of them are names Windows keeps as they are. Case-insensitive, as Windows is. A path that fails to qualify, or that Windows
    /// would rewrite, has none.
    /// </summary>
    public static bool TryGetNamesBelow(string root, string path, [NotNullWhen(true)] out string[]? names)
    {
        names = null;

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

        var prefix = root + Path.DirectorySeparatorChar;

        if (!full.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        var found = full[prefix.Length..].Split(Path.DirectorySeparatorChar);

        if (!found.All(name => Check(name) == NameProblem.None))
        {
            return false;
        }

        names = found;

        return true;
    }

    /// <summary>
    /// Windows reserves these names whatever the extension, in any case, and drops the spaces between the name and the dot, so
    /// <c>NUL .txt</c> is the device too.
    /// </summary>
    [GeneratedRegex(@"^(CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|(COM|LPT)[0-9¹²³]) *(\..*)?\z", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex DeviceName();
}
