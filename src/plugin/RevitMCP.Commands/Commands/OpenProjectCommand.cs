using System.Text.Json;
using Autodesk.Revit.DB;
using RevitMCP.Bridge;
using RevitMCP.Commands.Dispatch;

namespace RevitMCP.Commands;

/// <summary>
/// Opens a project from the test folder and makes it active. For a project that is already open Revit only activates
/// it and keeps its unsaved changes, so that is not an error: <c>alreadyOpen</c> says which of the two happened.
/// </summary>
public sealed class OpenProjectCommand : ICommand
{
    public string Method => MethodNames.OpenProject;

    public bool NeedsDocument => false;

    public JsonElement Execute(CommandContext context, JsonElement parameters)
    {
        var path = TestFolder.Resolve(ProjectSupport.ReadName(parameters, Method));

        if (!File.Exists(path))
        {
            throw new RequestFailedException(
                JsonRpcCodes.InvalidParams,
                $"{path} does not exist. Check the name, or use create_project to make it.");
        }

        var alreadyOpen = context.UiApp.Application.Documents
            .Cast<Document>()
            .Any(document => string.Equals(document.PathName, path, StringComparison.OrdinalIgnoreCase));

        return ProjectSupport.Run(
            Method,
            () => ProjectSupport.OpenedDocument(context.UiApp.OpenAndActivateDocument(path)),
            (document, dialogs) => new
            {
                name = document.Title,
                path = document.PathName,
                alreadyOpen,
                isModified = document.IsModified,
                dialogs,
            });
    }
}
