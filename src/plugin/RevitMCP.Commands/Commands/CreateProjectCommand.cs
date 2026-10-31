using System.Text.Json;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitMCP.Bridge;
using RevitMCP.Commands.Dispatch;

namespace RevitMCP.Commands;

/// <summary>
/// Creates a project from the template, saves it in the test folder and makes it active. Live Revit showed the order:
/// a new document stays hidden and pathless until <c>OpenAndActivateDocument</c>, which then gives that same document
/// a window, so nothing is closed on success. Refusals come before Revit is touched.
/// </summary>
public sealed class CreateProjectCommand : ICommand
{
    private const string Template = @"C:\ProgramData\Autodesk\RVT 2027\Templates\Russian\DefaultRUSRUS.rte";

    public string Method => MethodNames.CreateProject;

    public bool NeedsDocument => false;

    public JsonElement Execute(CommandContext context, JsonElement parameters)
    {
        var path = TestFolder.Resolve(ProjectSupport.ReadName(parameters, Method));

        if (Path.Exists(path))
        {
            throw new RequestFailedException(
                JsonRpcCodes.InvalidParams,
                $"{path} already exists, and create_project overwrites nothing. Pick another name, or use open_project to continue it.");
        }

        if (!File.Exists(Template))
        {
            throw new RequestFailedException(
                JsonRpcCodes.InternalError,
                $"The project template {Template} is missing, so create_project cannot start. It comes with the Russian content of Revit 2027.");
        }

        Directory.CreateDirectory(TestFolder.Root);

        return ProjectSupport.Run(
            Method,
            () => Create(context.UiApp, path),
            (document, dialogs) => new { name = document.Title, path = document.PathName, dialogs });
    }

    private static Document Create(UIApplication app, string path)
    {
        var document = app.Application.NewProjectDocument(Template);
        try
        {
            document.SaveAs(path);
            return app.OpenAndActivateDocument(path).Document;
        }
        catch (Exception)
        {
            CloseHidden(document);
            throw;
        }
    }

    /// <summary>
    /// A failed step leaves the document open with no window, where nobody can reach it. Live Revit closes such a
    /// document without a dialog. This runs while an exception is on its way, so it must not replace that exception.
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
