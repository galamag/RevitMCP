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
/// A template is never overwritten, and nothing here deletes a file. The save over the <c>.rvt</c> renames the earlier file to the
/// next numbered backup, <c>name.0001.rvt</c>, first, as the file times in the test folder showed. A failure reads where the
/// document is from Revit and says so, see <see cref="TemplateSaveFailure"/>.
/// </summary>
public sealed class SaveProjectTemplateCommand : ICommand
{
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

        ProjectSupport.RequireProjectFile(project, MethodNames.SaveProjectTemplate, "has no project file to return to");

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
            // OverwriteExistingFile is false by default and is said here on purpose. RevitAPI.xml says false makes SaveAs fail
            // when a file is already at the target, and that, not the check in Refuse, is what keeps a template that appeared
            // in between safe. That case was not provoked live.
            document.SaveAs(template, new SaveAsOptions { OverwriteExistingFile = false });
        }
        catch (Exception e)
        {
            Log.Error($"{MethodNames.SaveProjectTemplate} failed writing the template.", e);
            throw new RequestFailedException(
                JsonRpcCodes.InternalError,
                TemplateSaveFailure.WritingTemplate($"Revit said: {e.Message}", project, template, PathOf(document), File.Exists(template)));
        }

        try
        {
            document.SaveAs(project, new SaveAsOptions { OverwriteExistingFile = true });
        }
        catch (Exception e)
        {
            Log.Error($"{MethodNames.SaveProjectTemplate} could not save back to the project file.", e);
            throw new RequestFailedException(
                JsonRpcCodes.InternalError,
                TemplateSaveFailure.SavingBack($"Revit said: {e.Message}", project, template, PathOf(document)));
        }

        // The save came back without an error, yet the document must really be on the project file again.
        var path = PathOf(document);
        if (!string.Equals(path, project, StringComparison.OrdinalIgnoreCase))
        {
            throw new RequestFailedException(
                JsonRpcCodes.InternalError,
                TemplateSaveFailure.SavingBack("Revit reported no error, but the document is not on the project file.", project, template, path));
        }

        return document;
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
            return TemplateSaveFailure.UnreadablePath;
        }
    }
}
