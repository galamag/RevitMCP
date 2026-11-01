namespace RevitMCP.Bridge;

/// <summary>
/// The only folder the project tools may touch, <c>%USERPROFILE%\Documents\RevitMCP</c>. A client names a project, never
/// a path. Names Windows would quietly rewrite are refused, because the file on disk would then not be the one the
/// checks here looked at.
/// </summary>
public static class TestFolder
{
    private const string Extension = ".rvt";

    /// <summary>
    /// Measured in live Revit: <c>SaveAs</c> takes 259 characters, but <c>Save</c> needs a backup path, five longer
    /// (<c>.0001</c>), to fit too. Without it Save fails, so a project that cannot be saved later is refused now.
    /// </summary>
    private const int MaxPathLength = 254;

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
        var path = Path.Combine(Root, stem + Extension);

        var problem = FindProblem(stem)
            ?? (stem!.Contains('.') ? $"apart from an optional {Extension} ending it may hold no dot" : null)
            ?? (path.Length > MaxPathLength
                ? $"it is too long, as Revit can only keep paths of up to {MaxPathLength} characters, so in {Root} a name can have at most {MaxPathLength - Path.Combine(Root, Extension).Length} characters"
                : null);

        return problem is null
            ? path
            : throw new RequestFailedException(JsonRpcCodes.InvalidParams, $"'{name}' cannot be a project name: {problem}.");
    }

    /// <summary>
    /// Tells whether <paramref name="path"/> is a fully qualified path of something below <see cref="Root"/>, not the
    /// folder itself. Case-insensitive, as Windows is. A path that fails to qualify, or that Windows would rewrite, is not.
    /// </summary>
    public static bool Contains(string path) => WindowsNames.TryGetNamesBelow(Root, path, out _);

    /// <summary>Says what is wrong with one path segment, or returns <c>null</c> when Windows would keep it as it is.</summary>
    private static string? FindProblem(string? segment) => WindowsNames.Check(segment) switch
    {
        NameProblem.Empty => "it is empty",
        NameProblem.ForbiddenCharacter => "it must be a bare file name, so no folders, drives or characters that Windows forbids in a file name",
        NameProblem.SpaceOrDotAtTheEnd => "it starts or ends with a space or ends with a dot, which Windows would change",
        NameProblem.DeviceName => "it is a Windows device name",
        _ => null,
    };
}
