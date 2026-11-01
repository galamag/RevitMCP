using System.Text.Json;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitMCP.Bridge;
using RevitMCP.Commands.Dispatch;

namespace RevitMCP.Commands;

/// <summary>
/// Creates a project from a template, saves it in the test folder and makes it active. The template is the default one,
/// or the <c>.rte</c> in the test folder that <c>templateName</c> names, as <c>save_project_template</c> makes it. Live
/// Revit showed the order: a new document stays hidden and pathless until <c>OpenAndActivateDocument</c>, which then gives
/// that same document a window, so nothing is closed on success. Refusals come before Revit is touched.
/// </summary>
public sealed class CreateProjectCommand : ICommand
{
    private const string DefaultTemplate = @"C:\ProgramData\Autodesk\RVT 2027\Templates\Russian\DefaultRUSRUS.rte";

    private const string TemplateNameKey = "templateName";

    public string Method => MethodNames.CreateProject;

    public bool NeedsDocument => false;

    public JsonElement Execute(CommandContext context, JsonElement parameters)
    {
        var path = TestFolder.Resolve(ProjectSupport.ReadName(parameters, Method));
        var custom = parameters.TryGetProperty(TemplateNameKey, out _)
            ? TestFolder.ResolveTemplate(ProjectSupport.ReadName(parameters, Method, TemplateNameKey))
            : null;

        if (Path.Exists(path))
        {
            throw new RequestFailedException(
                JsonRpcCodes.InvalidParams,
                $"{path} already exists, and create_project overwrites nothing. Pick another name, or use open_project to continue it.");
        }

        var template = custom ?? DefaultTemplate;
        if (custom is not null)
        {
            RefuseCustomTemplate(context.UiApp, custom);
        }
        else if (!File.Exists(template))
        {
            throw new RequestFailedException(
                JsonRpcCodes.InternalError,
                $"The project template {template} is missing, so create_project cannot start. It comes with the Russian content of Revit 2027.");
        }

        Directory.CreateDirectory(TestFolder.Root);

        return ProjectSupport.Run(
            Method,
            () => Create(context.UiApp, path, template),
            (document, dialogs) => new { name = document.Title, path = document.PathName, dialogs });
    }

    /// <summary>
    /// A template that is not there, or that Revit holds open as a document, is refused now. For the open one live Revit
    /// raises a file access dialog the guard has to close, and then fails with a message that names no cause.
    /// </summary>
    private static void RefuseCustomTemplate(UIApplication app, string template)
    {
        if (!File.Exists(template))
        {
            throw new RequestFailedException(
                JsonRpcCodes.InvalidParams,
                $"{template} does not exist, so no project was created. Check the name, or use save_project_template to make a template from the active project.");
        }

        var open = app.Application.Documents
            .Cast<Document>()
            .Any(document => string.Equals(document.PathName, template, StringComparison.OrdinalIgnoreCase));
        if (open)
        {
            throw new RequestFailedException(
                JsonRpcCodes.InvalidParams,
                $"{template} is open in Revit as a document, and Revit cannot start a project from a template that is open. Nothing was created. Ask the user to close that document in Revit, or to save it over the project it came from.");
        }
    }

    /// <summary>
    /// A failure says what became of the file, read from the disk, because a retry depends on it and nothing here
    /// deletes: whatever is at <paramref name="path"/> keeps that name taken.
    /// </summary>
    private static Document Create(UIApplication app, string path, string template)
    {
        var document = app.Application.NewProjectDocument(template);

        try
        {
            document.SaveAs(path);
        }
        catch (Exception e)
        {
            CloseHidden(document);
            throw Failure(e, File.Exists(path)
                ? $"A partial file may remain at {path}. It was left there, so that name stays taken."
                : $"No file was left at {path}.");
        }

        try
        {
            return ProjectSupport.OpenedDocument(app.OpenAndActivateDocument(path));
        }
        catch (Exception e)
        {
            CloseHidden(document);
            throw Failure(e, File.Exists(path)
                ? $"The project was saved at {path} and that file still exists. Use open_project to reach it."
                : $"The project was saved at {path}, but that file is gone now.");
        }
    }

    /// <summary>Logs the cause on its own, as the message holds a path built from the request, which stays out of the log.</summary>
    private static RequestFailedException Failure(Exception cause, string fileState)
    {
        Log.Error($"{MethodNames.CreateProject} failed after it started a document.", cause);

        return new RequestFailedException(
            JsonRpcCodes.InternalError,
            $"{MethodNames.CreateProject} failed: {cause.Message} {fileState}");
    }

    /// <summary>
    /// A failed step leaves the document open with no window, where nobody can reach it. Live Revit closes such a
    /// document without a dialog. This runs while a failure is on its way, so it must not replace that failure.
    /// </summary>
    private static void CloseHidden(Document document)
    {
        try
        {
            if (!document.Close(false))
            {
                Log.Error("Revit refused to close the hidden document of a failed create_project.");
            }
        }
        catch (Exception e)
        {
            Log.Error("Could not close the hidden document of a failed create_project.", e);
        }
    }
}
