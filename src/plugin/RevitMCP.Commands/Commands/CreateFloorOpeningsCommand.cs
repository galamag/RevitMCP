using System.Text.Json;
using Autodesk.Revit.DB;
using RevitMCP.Bridge;
using RevitMCP.Commands.Dispatch;

namespace RevitMCP.Commands;

/// <summary>
/// Cuts openings in floors from outlines of straight edges as one transaction, with <c>NewOpening(floor, profile, false)</c>,
/// a vertical cut. Live Revit: the height of the outline does not matter, and an opening that lies wholly outside its floor
/// is committed with no error, only with the warning "Opening not cutting anything". So the area of the floor is read
/// before and after each opening, after a regeneration, and an opening that takes nothing off it fails its item. An opening
/// across the edge of the floor is fine, and cuts what overlaps. The openings of a list are cut in order, so each sees the
/// area the ones before it left.
/// </summary>
public sealed class CreateFloorOpeningsCommand : ICommand
{
    /// <summary>An opening that takes less than this off the floor has cut nothing. A square millimetre is far above the noise of the area.</summary>
    private const double MinCutM2 = 1e-6;

    public string Method => MethodNames.CreateFloorOpenings;

    public bool NeedsDocument => true;

    public JsonElement Execute(CommandContext context, JsonElement parameters)
    {
        var document = context.Document!;
        var entries = ItemBatch.ReadItems(parameters, Method)
            .Select((item, index) => ReadOpening(document, item, index))
            .ToList();

        // Kept for the read-back, which comes after the whole batch: by then a floor holds all its openings.
        var cuts = new Dictionary<ElementId, Cut>();

        return ItemBatch.Run(
            document,
            Method,
            entries,
            input => CutOpening(document, input, cuts),
            element => Describe((Opening)element, cuts[element.Id]));
    }

    private static Opening CutOpening(Document document, OpeningInput input, Dictionary<ElementId, Cut> cuts)
    {
        var floor = document.GetElement(input.FloorId);
        var before = AreaM2(floor);

        var profile = new CurveArray();
        foreach (var curve in input.Outline)
        {
            profile.Append(curve);
        }

        var opening = document.Create.NewOpening(floor, profile, false)
            ?? throw new InvalidOperationException($"Revit gave no opening for floor {input.FloorId}.");

        document.Regenerate();
        var after = AreaM2(floor);

        if (before - after < MinCutM2)
        {
            throw new InvalidOperationException(
                $"Revit took the opening and it cut nothing: floor {input.FloorId} has {after:0.###} m² after it, and had {before:0.###} m² before. "
                + "The opening lies outside the floor, or inside an opening cut before it.");
        }

        cuts[opening.Id] = new Cut(before, after);

        return opening;
    }

    private BatchEntry<OpeningInput> ReadOpening(Document document, JsonElement item, int index)
    {
        var reader = new ItemReader(item, $"{Method} item {index}");
        var floor = reader.Instance<Floor>(document, "floorId", "floors");
        var level = document.GetElement(floor.LevelId) as Level
            ?? throw reader.Refuse($"floorId {item.GetProperty("floorId").GetRawText()} is a floor with no level, so its opening has no height to be drawn at.");

        return new BatchEntry<OpeningInput>(index, item, new OpeningInput(floor.Id, reader.Outline(document, "boundaryMm", level)));
    }

    /// <summary>The area of a floor as Revit computes it, in square metres.</summary>
    private static double AreaM2(Element floor) =>
        floor.get_Parameter(BuiltInParameter.HOST_AREA_COMPUTED) is { } area
            ? Units.InternalToSquareMetres(area.AsDouble())
            : throw new InvalidOperationException($"Floor {floor.Id} has no area to compare, so the opening cannot be checked.");

    private static object Describe(Opening opening, Cut cut) => new
    {
        floorId = opening.Host?.Id.ToString(),
        areaBeforeM2 = cut.Before,
        areaAfterM2 = cut.After,
        cutM2 = cut.Before - cut.After,
        floorAreaAfterCallM2 = opening.Host is { } host ? AreaM2(host) : (double?)null,
        boundaryMm = opening.IsRectBoundary
            ? null
            : opening.BoundaryCurves?.Cast<Curve>().Select(curve => new { x = Units.InternalToMm(curve.GetEndPoint(0).X), y = Units.InternalToMm(curve.GetEndPoint(0).Y) }).ToList(),
    };

    private sealed record OpeningInput(ElementId FloorId, CurveLoop Outline);

    /// <summary>The area of a floor in square metres just before and just after one opening.</summary>
    private sealed record Cut(double Before, double After);
}
