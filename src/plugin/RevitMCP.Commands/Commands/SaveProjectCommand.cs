using System.Text.Json;
using RevitMCP.Bridge;
using RevitMCP.Commands.Dispatch;

namespace RevitMCP.Commands;

/// <summary>
/// Saves the active document, and only when its file is a <c>.rvt</c> in the test folder. An optional <c>name</c> states which
/// project the caller means, so a document that became active in the meantime is refused instead of saved.
/// Revit keeps numbered backups such as <c>name.0001.rvt</c> beside the file.
/// </summary>
public sealed class SaveProjectCommand : ICommand
{
    /// <summary>
    /// The prefix of the refusal when another document is active. It is not <see cref="CommandHandler.NoActiveDocument"/>,
    /// which means that nothing is active, and which the server answers with advice that would be wrong here.
    /// </summary>
    private const string WrongActiveDocument = "wrong_active_document";

    public string Method => MethodNames.SaveProject;

    public bool NeedsDocument => true;

    public JsonElement Execute(CommandContext context, JsonElement parameters)
    {
        var document = context.Document!;
        var expected = parameters.TryGetProperty("name", out _)
            ? TestFolder.Resolve(ProjectSupport.ReadName(parameters, Method))
            : null;
        var path = document.PathName;

        if (string.IsNullOrEmpty(path))
        {
            throw new RequestFailedException(
                JsonRpcCodes.InternalError,
                $"'{document.Title}' was never saved, so it has no file to save to. Use create_project to make a project in the test folder.");
        }

        if (!TestFolder.Contains(path))
        {
            throw new RequestFailedException(
                JsonRpcCodes.InternalError,
                $"The active document is outside {TestFolder.Root}, so save_project leaves it alone: {path}");
        }

        // A document that a save_project_template could not return to its project sits on a .rte, which Contains accepts.
        ProjectSupport.RequireProjectFile(path, Method, "would write into it instead of into a project");

        if (expected is not null && !string.Equals(path, expected, StringComparison.OrdinalIgnoreCase))
        {
            throw new RequestFailedException(
                JsonRpcCodes.InvalidParams,
                $"{WrongActiveDocument}: {expected} is not the active document, {path} is, so nothing was saved. Use open_project to make it active first.");
        }

        return ProjectSupport.Run(
            Method,
            () =>
            {
                document.Save();
                return document;
            },
            (saved, dialogs) => new { name = saved.Title, path = saved.PathName, dialogs });
    }
}
