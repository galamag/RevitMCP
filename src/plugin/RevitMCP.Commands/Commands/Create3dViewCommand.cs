using System.Text.Json;
using Autodesk.Revit.DB;
using RevitMCP.Bridge;
using RevitMCP.Commands.Dispatch;

namespace RevitMCP.Commands;

/// <summary>
/// Creates a 3D view as one transaction. Everything that can be refused is refused before it opens, so a refusal keeps
/// its code. The camera of a perspective view comes from the input, while an isometric view keeps the default direction
/// of Revit and refuses a camera, as ignoring one would report a view the caller did not ask for.
/// </summary>
public sealed class Create3dViewCommand : ICommand
{
    private const string Isometric = "isometric";
    private const string Perspective = "perspective";

    /// <summary>A shorter distance between the eye and the target gives no direction worth trusting.</summary>
    private const double MinCameraDistanceMm = 1;

    private static readonly Dictionary<string, DisplayStyle> Styles = new(StringComparer.Ordinal)
    {
        ["shading"] = DisplayStyle.Shading,
        ["realistic"] = DisplayStyle.Realistic,
        ["rendering"] = DisplayStyle.Rendering,
    };

    public string Method => MethodNames.Create3dView;

    public bool NeedsDocument => true;

    public JsonElement Execute(CommandContext context, JsonElement parameters)
    {
        var document = context.Document!;
        var name = ReadViewName(document, parameters);
        var kind = ReadKind(parameters);
        var style = ReadStyle(parameters, out var styleWord);
        var camera = ReadCamera(parameters, kind);
        var typeId = Find3dViewType(document);

        View3D? view = null;
        var outcome = Operation.Run(document, Method, scope =>
        {
            view = kind == Perspective ? View3D.CreatePerspective(document, typeId) : View3D.CreateIsometric(document, typeId);
            view.Name = name;
            view.DisplayStyle = style;

            if (camera is not null)
            {
                view.SetOrientation(camera);
                view.SaveOrientation();

                // Live Revit: a new perspective view clips at about 36 m, so a camera further away got a flat empty picture.
                if (view.get_Parameter(BuiltInParameter.VIEWER_BOUND_ACTIVE_FAR)?.Set(0) != true)
                {
                    scope.Abort("Revit refused to turn off the far clip of the view, so far things would stay invisible.");
                }
            }

            if (view.Name != name)
            {
                scope.Abort($"Revit named the view '{view.Name}' instead of '{name}'.");
            }
        });

        return JsonSerializer.SerializeToElement(
            new
            {
                committed = outcome.Committed,
                viewId = outcome.Committed ? view!.Id.ToString() : null,
                name,
                kind,
                displayStyle = outcome.Committed ? Describe(view!.DisplayStyle, styleWord) : null,
                warnings = outcome.Warnings,
                errors = outcome.Errors,
                dialogs = outcome.Dialogs,
            },
            ProjectSupport.Options);
    }

    /// <summary>Reports what the view really has, so a style Revit changed by itself does not pass as the one asked for.</summary>
    private static string Describe(DisplayStyle actual, string requested) =>
        Styles.GetValueOrDefault(requested) == actual ? requested : actual.ToString();

    private string ReadViewName(Document document, JsonElement parameters)
    {
        var name = ProjectSupport.ReadName(parameters, Method);

        if (string.IsNullOrWhiteSpace(name) || name != name.Trim() || !NamingUtils.IsValidName(name))
        {
            throw new RequestFailedException(
                JsonRpcCodes.InvalidParams,
                $"'{name}' cannot be a view name: Revit forbids an empty name, spaces at either end and the characters {{ }} [ ] | ; < > ? ` ~ \\ :");
        }

        var taken = new FilteredElementCollector(document)
            .OfClass(typeof(View3D))
            .FirstOrDefault(view => string.Equals(view.Name, name, StringComparison.OrdinalIgnoreCase));

        return taken is null
            ? name
            : throw new RequestFailedException(
                JsonRpcCodes.InvalidParams,
                $"A 3D view named '{taken.Name}' already exists with id {taken.Id}, and {Method} renames nothing. Pick another name, or use that view.");
    }

    private string ReadKind(JsonElement parameters)
    {
        var kind = ReadText(parameters, "kind");

        return kind is Isometric or Perspective
            ? kind
            : throw new RequestFailedException(
                JsonRpcCodes.InvalidParams,
                $"'{kind}' is not a kind of {Method}. Use {Isometric} or {Perspective}.");
    }

    private DisplayStyle ReadStyle(JsonElement parameters, out string word)
    {
        word = ReadText(parameters, "displayStyle");

        return Styles.TryGetValue(word, out var style)
            ? style
            : throw new RequestFailedException(
                JsonRpcCodes.InvalidParams,
                $"'{word}' is not a displayStyle of {Method}. Use one of: {string.Join(", ", Styles.Keys)}.");
    }

    private static string ReadText(JsonElement parameters, string key) =>
        parameters.TryGetProperty(key, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()!
            : string.Empty;

    /// <summary>Returns <c>null</c> for an isometric view.</summary>
    private ViewOrientation3D? ReadCamera(JsonElement parameters, string kind)
    {
        var eye = ReadPoint(parameters, "eyeMm");
        var target = ReadPoint(parameters, "targetMm");

        if (kind == Isometric)
        {
            return eye is null && target is null
                ? null
                : throw new RequestFailedException(
                    JsonRpcCodes.InvalidParams,
                    $"An {Isometric} view takes no eyeMm or targetMm. Leave them out, or ask for a {Perspective} view.");
        }

        if (eye is null || target is null)
        {
            throw new RequestFailedException(JsonRpcCodes.InvalidParams, $"A {Perspective} view needs both eyeMm and targetMm.");
        }

        if (eye.DistanceTo(target) < Units.MmToInternal(MinCameraDistanceMm))
        {
            throw new RequestFailedException(JsonRpcCodes.InvalidParams, "eyeMm and targetMm are the same point, so the camera has no direction.");
        }

        return Aim(eye, target);
    }

    /// <summary>Keeps the horizon level. A camera that looks straight up or down has none, so north is up in the picture.</summary>
    private static ViewOrientation3D Aim(XYZ eye, XYZ target)
    {
        var forward = (target - eye).Normalize();
        var side = forward.CrossProduct(XYZ.BasisZ);
        var up = side.IsZeroLength() ? XYZ.BasisY : side.CrossProduct(forward).Normalize();

        return new ViewOrientation3D(eye, up, forward);
    }

    private XYZ? ReadPoint(JsonElement parameters, string key)
    {
        if (!parameters.TryGetProperty(key, out var point) || point.ValueKind == JsonValueKind.Null)
        {
            return null;
        }

        return Units.PointMm(ReadCoordinate(point, key, "x"), ReadCoordinate(point, key, "y"), ReadCoordinate(point, key, "z"));
    }

    private double ReadCoordinate(JsonElement point, string key, string axis) =>
        point.ValueKind == JsonValueKind.Object
        && point.TryGetProperty(axis, out var value)
        && value.ValueKind == JsonValueKind.Number
            ? value.GetDouble()
            : throw new RequestFailedException(JsonRpcCodes.InvalidParams, $"{Method}: {key} needs a number in {axis}.");

    private ElementId Find3dViewType(Document document) =>
        new FilteredElementCollector(document)
            .OfClass(typeof(ViewFamilyType))
            .Cast<ViewFamilyType>()
            .Where(type => type.ViewFamily == ViewFamily.ThreeDimensional)
            .OrderBy(type => type.Id.Value)
            .FirstOrDefault()?.Id
            ?? throw new RequestFailedException(JsonRpcCodes.InternalError, $"{Method}: this project has no 3D view type.");
}
