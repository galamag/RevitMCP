using System.Text.Json;
using RevitMCP.Bridge;
using RevitMCP.Commands.Dispatch;

namespace RevitMCP.Commands;

/// <summary>
/// Saves the active document, and only when its file is in the test folder. An optional <c>name</c> states which
/// project the caller means, so a document that became active in the meantime is refused instead of saved.
/// Revit keeps numbered backups such as <c>name.0001.rvt</c> beside the file.
/// </summary>
public sealed class SaveProjectCommand : ICommand
{
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

        if (expected is not null && !string.Equals(path, expected, StringComparison.OrdinalIgnoreCase))
        {
            throw new RequestFailedException(
                JsonRpcCodes.InvalidParams,
                $"{CommandHandler.NoActiveDocument}: {expected} is not the active document, {path} is, so nothing was saved. Use open_project to make it active first.");
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
