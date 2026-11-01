using System.Text.Json;
using Autodesk.Revit.DB;
using RevitMCP.Bridge;
using RevitMCP.Commands.Dispatch;

namespace RevitMCP.Commands;

/// <summary>
/// Saves the active project as a project template, <c>name.rte</c> in the test folder, and leaves the project where it was.
/// It changes no model content, so it is a save and not a transaction: no <see cref="Operation"/>, no Undo step. Live Revit
/// showed the way in two steps. <c>SaveAs</c> to the <c>.rte</c> writes the project as it is now, unsaved changes included,
/// and moves the active document onto the <c>.rte</c>, where <c>NewProjectDocument</c> cannot use it. So <c>SaveAs</c> goes
/// straight back over the <c>.rvt</c> with <c>OverwriteExistingFile</c>, which makes the <c>.rvt</c> hold that same state
/// and frees the <c>.rte</c>. The document keeps its identity through both, so the undo history stays in step with it.
/// A template is never overwritten, and nothing here deletes a file.
/// </summary>
public sealed class SaveProjectTemplateCommand : ICommand
{
    private const string ProjectExtension = ".rvt";

    public string Method => MethodNames.SaveProjectTemplate;

    public bool NeedsDocument => true;

    public JsonElement Execute(CommandContext context, JsonElement parameters)
    {
        var document = context.Document!;
        var template = TestFolder.ResolveTemplate(ProjectSupport.ReadName(parameters, Method));
        var project = document.PathName;

        Refuse(document, project, template);

        return ProjectSupport.Run(
            Method,
            () => SaveThroughTemplate(document, project, template),
            (saved, dialogs) => new
            {
                name = saved.Title,
                path = saved.PathName,
                templatePath = template,
                isModified = saved.IsModified,
                dialogs,
            });
    }

    /// <summary>Everything that can be refused is refused before Revit is touched, so a refusal leaves the document as it was.</summary>
    private static void Refuse(Document document, string project, string template)
    {
        if (string.IsNullOrEmpty(project))
        {
            throw new RequestFailedException(
                JsonRpcCodes.InternalError,
                $"'{document.Title}' was never saved, so it has no project file to return to. Use create_project to make a project in the test folder.");
        }

        if (!TestFolder.Contains(project))
        {
            throw new RequestFailedException(
                JsonRpcCodes.InternalError,
                $"The active document is outside {TestFolder.Root}, so save_project_template leaves it alone: {project}");
        }

        if (!string.Equals(Path.GetExtension(project), ProjectExtension, StringComparison.OrdinalIgnoreCase))
        {
            throw new RequestFailedException(
                JsonRpcCodes.InternalError,
                $"The active document is {project}, which is not a {ProjectExtension} project, so there is no project file to return to and nothing was saved. "
                + "Use open_project to make the project active first.");
        }

        // Revit refuses to overwrite a read-only file, and the save back would then fail with the document on the template.
        if (File.Exists(project) && File.GetAttributes(project).HasFlag(FileAttributes.ReadOnly))
        {
            throw new RequestFailedException(
                JsonRpcCodes.InternalError,
                $"{project} is read-only, so the project could not be saved back over it once the template was written, and the active document would stay on the template. "
                + "Nothing was saved. Ask the user to clear the read-only attribute of that file.");
        }

        if (Path.Exists(template))
        {
            throw new RequestFailedException(
                JsonRpcCodes.InvalidParams,
                $"{template} already exists, and save_project_template overwrites nothing. Pick another name.");
        }
    }

    /// <summary>
    /// A failure says where the document is now and what became of the files, read from Revit and the disk, because what to
    /// do next depends on it. The cause goes to the log on its own, as the message holds a path built from the request.
    /// </summary>
    private static Document SaveThroughTemplate(Document document, string project, string template)
    {
        try
        {
            // Without OverwriteExistingFile, Revit itself refuses a template that appeared since the check.
            document.SaveAs(template);
        }
        catch (Exception e)
        {
            Log.Error($"{MethodNames.SaveProjectTemplate} failed writing the template.", e);
            throw new RequestFailedException(
                JsonRpcCodes.InternalError,
                $"{MethodNames.SaveProjectTemplate} failed writing the template: {e.Message} {WhereItStands(document, project, template)}");
        }

        try
        {
            document.SaveAs(project, new SaveAsOptions { OverwriteExistingFile = true });
        }
        catch (Exception e)
        {
            Log.Error($"{MethodNames.SaveProjectTemplate} could not save back to the project file.", e);
            throw StayedOnTemplate(project, template, $"Revit said: {e.Message}", document);
        }

        // The save came back without an error, yet the document must really be on the project file again.
        if (!string.Equals(PathOf(document), project, StringComparison.OrdinalIgnoreCase))
        {
            throw StayedOnTemplate(project, template, "Revit reported no error, but the document is not on the project file.", document);
        }

        return document;
    }

    /// <summary>
    /// The one failure that leaves the session in a state a person must end: the document stays on the <c>.rte</c>. The
    /// result says so first and in capitals, because it is easy to read past, and says what the caller must not do.
    /// </summary>
    private static RequestFailedException StayedOnTemplate(string project, string template, string cause, Document document) =>
        new(
            JsonRpcCodes.InternalError,
            $"{MethodNames.SaveProjectTemplate} FAILED TO SAVE BACK TO THE PROJECT: THE ACTIVE DOCUMENT STAYED ON THE TEMPLATE {PathOf(document)}, not on {project}. "
            + $"{cause} The template {template} was written and holds the project as it was; the project file on disk may be older than that. "
            + "Do not call save_project or save_project_template now: save_project would write into the template. "
            + $"Nothing was deleted. Ask the user to look at Revit: that document has to be saved over {project} or closed, "
            + "and restart-revit.ps1 will not close Revit while a template is open as a document.");

    private static string WhereItStands(Document document, string project, string template)
    {
        var path = PathOf(document);
        var onProject = string.Equals(path, project, StringComparison.OrdinalIgnoreCase);
        var file = File.Exists(template)
            ? $"A partial file may remain at {template}. It was left there, so that name stays taken."
            : $"No file was left at {template}.";

        return onProject
            ? $"The active document is still {project}, and it was not changed. {file}"
            : $"The active document is now {path}, not {project}. {file}";
    }

    /// <summary>The path of the document, or a note that it could not be read: this runs while a failure is on its way.</summary>
    private static string PathOf(Document document)
    {
        try
        {
            return document.PathName;
        }
        catch (Exception e)
        {
            Log.Error("Could not read the path of the document after a failed save_project_template.", e);
            return "(unreadable)";
        }
    }
}
