using System.Text.Json;
using Autodesk.Revit.DB;
using RevitMCP.Bridge;
using RevitMCP.Commands.Dispatch;

namespace RevitMCP.Commands;

/// <summary>
/// Exports one view of the active document to a PNG in <see cref="Folder"/> and answers with its path, and the server
/// reads the file, so the image never travels over the bridge. An export changes no model, so it runs outside a
/// transaction and leaves no Undo step. Every export gets its own file name, so a stale file can never pass for this
/// one. Nothing removes old files.
/// </summary>
public sealed class GetViewSnapshotCommand : ICommand
{
    private const int DefaultWidthPx = 1600;

    /// <summary>The limits of <c>widthPx</c>, which <c>registry.ts</c> states too.</summary>
    private const int MinWidthPx = 100;
    private const int MaxWidthPx = 4096;

    private static readonly string Folder = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "RevitMCP",
        "snapshots");

    /// <summary>The kinds of view that draw the model or paper. The others are tables and browsers, with no picture to export.</summary>
    private static readonly HashSet<ViewType> Exportable =
    [
        ViewType.FloorPlan,
        ViewType.CeilingPlan,
        ViewType.EngineeringPlan,
        ViewType.AreaPlan,
        ViewType.Elevation,
        ViewType.Section,
        ViewType.Detail,
        ViewType.ThreeD,
        ViewType.DraftingView,
        ViewType.Legend,
        ViewType.DrawingSheet,
    ];

    public string Method => MethodNames.GetViewSnapshot;

    public bool NeedsDocument => true;

    public JsonElement Execute(CommandContext context, JsonElement parameters)
    {
        var document = context.Document!;
        var view = ReadView(document, parameters);
        var widthPx = ReadWidth(parameters);
        var path = string.Empty;

        return ProjectSupport.Run(
            Method,
            () =>
            {
                path = Export(document, view, widthPx);
                return document;
            },
            (_, dialogs) => new { viewId = view.Id.ToString(), viewName = view.Name, path, dialogs });
    }

    private View ReadView(Document document, JsonElement parameters)
    {
        var text = parameters.TryGetProperty("viewId", out var viewId) && viewId.ValueKind == JsonValueKind.String
            ? viewId.GetString()!
            : throw new RequestFailedException(JsonRpcCodes.InvalidParams, $"{Method} needs viewId as a string.");

        var element = document.GetElement(ElementIds.Parse(text, Method));

        return element is View { IsTemplate: false } view && Exportable.Contains(view.ViewType)
            ? view
            : throw new RequestFailedException(
                JsonRpcCodes.InvalidParams,
                $"{Refuse(element, text)} Views that can be exported: {ListExportable(document)}.");
    }

    private static string Refuse(Element? element, string text) => element switch
    {
        null => $"No element has the id {text}.",
        View { IsTemplate: true } => $"The view {text} is a view template, which has no picture.",
        View view => $"The view {text} is a {view.ViewType}, which has no picture to export.",
        _ => $"The element {text} is not a view.",
    };

    private static string ListExportable(Document document) => string.Join(
        ", ",
        new FilteredElementCollector(document)
            .OfClass(typeof(View))
            .Cast<View>()
            .Where(view => !view.IsTemplate && Exportable.Contains(view.ViewType))
            .OrderBy(view => view.Id.Value)
            .Select(view => $"{view.Id} ({view.ViewType} '{view.Name}')"));

    private int ReadWidth(JsonElement parameters)
    {
        if (!parameters.TryGetProperty("widthPx", out var width))
        {
            return DefaultWidthPx;
        }

        return width.ValueKind == JsonValueKind.Number && width.TryGetInt32(out var pixels) && pixels is >= MinWidthPx and <= MaxWidthPx
            ? pixels
            : throw new RequestFailedException(
                JsonRpcCodes.InvalidParams,
                $"{Method}: widthPx must be a whole number from {MinWidthPx} to {MaxWidthPx}, not {width.GetRawText()}.");
    }

    private static string Export(Document document, View view, int widthPx)
    {
        Directory.CreateDirectory(Folder);

        using var options = new ImageExportOptions
        {
            ExportRange = ExportRange.SetOfViews,
            FilePath = Path.Combine(Folder, Guid.NewGuid().ToString("N")),
            ZoomType = ZoomFitType.FitToPage,
            FitDirection = FitDirectionType.Horizontal,
            PixelSize = widthPx,
            HLRandWFViewsFileType = ImageFileType.PNG,
            ShadowViewsFileType = ImageFileType.PNG,
        };
        options.SetViewsAndSheets([view.Id]);

        document.ExportImage(options);

        var path = Path.Combine(Folder, options.FilePath + ImageExportOptions.GetFileName(document, view.Id));

        return File.Exists(path)
            ? path
            : throw new RequestFailedException(JsonRpcCodes.InternalError, $"Revit reported no error, but left no image at {path}.");
    }
}
