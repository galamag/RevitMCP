namespace RevitMCP.Bridge;

/// <summary>
/// The words of a <c>save_project_template</c> that failed. The tool saves to the <c>.rte</c> and then back over the
/// <c>.rvt</c>, and between the two Revit may hold the active document on the wrong file. Where it really is decides what
/// the caller may do next, so each message branches on the path Revit reports now and never on what was meant to happen.
/// This is plain text over plain strings, without Revit, so that its branches can be tested: live Revit cannot be made to
/// leave a document on a template without a person to close it.
/// </summary>
public static class TemplateSaveFailure
{
    /// <summary>What stands for the path when Revit could not give it.</summary>
    public const string UnreadablePath = "(unreadable)";

    /// <summary>The first <c>SaveAs</c>, to the <c>.rte</c>, threw. The project file was not written by it.</summary>
    /// <param name="actualPath">Where Revit says the active document is now.</param>
    /// <param name="templateFileExists">Whether something is at <paramref name="template"/> on the disk.</param>
    public static string WritingTemplate(string cause, string project, string template, string actualPath, bool templateFileExists)
    {
        var file = templateFileExists
            ? $"A partial file may remain at {template}. It was left there, so that name stays taken."
            : $"No file was left at {template}.";

        return Same(actualPath, project)
            ? $"{MethodNames.SaveProjectTemplate} failed writing the template: {cause} The active document is still {project}, and it was not changed. {file}"
            : Stranded(
                $"{MethodNames.SaveProjectTemplate} FAILED WRITING THE TEMPLATE AND MOVED THE ACTIVE DOCUMENT",
                cause,
                $"{file} The project file {project} is not written by that step.",
                project,
                template,
                actualPath);
    }

    /// <summary>The second <c>SaveAs</c>, back over the <c>.rvt</c>, threw, or came back without the document on the <c>.rvt</c>.</summary>
    /// <param name="actualPath">Where Revit says the active document is now.</param>
    public static string SavingBack(string cause, string project, string template, string actualPath) =>
        Same(actualPath, project)
            ? $"{MethodNames.SaveProjectTemplate} FAILED TO SAVE BACK OVER {project}: {cause} The active document is on {project}, so it did not stay on the template, "
                + $"and save_project can write it again. The template {template} was written. {ProjectNote(project)}"
            : Stranded(
                $"{MethodNames.SaveProjectTemplate} FAILED TO SAVE BACK TO THE PROJECT",
                cause,
                $"The template {template} was written and holds the project as it was. {ProjectNote(project)}",
                project,
                template,
                actualPath);

    /// <summary>
    /// The document is not on the project. The result says where it is first and in capitals, because it is easy to read past,
    /// then what is on the disk, and what the caller must not do.
    /// </summary>
    private static string Stranded(string headline, string cause, string files, string project, string template, string actualPath)
    {
        var where = Same(actualPath, template)
            ? $"THE ACTIVE DOCUMENT STAYED ON THE TEMPLATE {template}, not on {project}."
            : actualPath == UnreadablePath
                ? $"REVIT DID NOT SAY WHERE THE ACTIVE DOCUMENT IS NOW, so it MAY BE ON THE TEMPLATE {template} and not on {project}."
                : $"THE ACTIVE DOCUMENT IS NOW {actualPath}, NEITHER {project} NOR THE TEMPLATE {template}.";

        var restart = Same(actualPath, template)
            ? " restart-revit.ps1 will not close Revit while a template is open as a document."
            : string.Empty;

        return $"{headline}: {where} {cause} {files} "
            + "Do not work in that document and do not call save_project_template now; save_project refuses a document that is not a .rvt project. "
            + $"Nothing was deleted. Ask the user to look at Revit: that document has to be saved over {project} or closed.{restart}";
    }

    /// <summary>
    /// What is known of the project file after a save back that failed. A save back that works first renames the earlier file to
    /// the next numbered backup, as live Revit showed, so the earlier version should be there, and the project file itself may be
    /// missing or damaged if the write stopped halfway. How a failed write ends was not observed.
    /// </summary>
    private static string ProjectNote(string project) =>
        $"The project file {project} is in an unknown state: it may be the earlier version, or missing, or damaged if the write stopped halfway. "
        + $"Revit moves the earlier file to the next numbered backup before it writes the new one, such as {Path.ChangeExtension(project, ".0001.rvt")}, "
        + "so look for the highest numbered backup beside the project file.";

    private static bool Same(string left, string right) => string.Equals(left, right, StringComparison.OrdinalIgnoreCase);
}
