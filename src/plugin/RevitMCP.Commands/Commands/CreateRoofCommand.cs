using System.Text.Json;
using Autodesk.Revit.DB;
using RevitMCP.Bridge;
using RevitMCP.Commands.Dispatch;

namespace RevitMCP.Commands;

/// <summary>
/// Creates footprint roofs from outlines of straight edges as one transaction. Edge N runs from point N to the next one.
/// Slopes are set on the sketch curve found by its ends, not by its place in an array, because a slope on the wrong edge
/// raises the wrong side of the house without any error. Revit keeps the order of the array it hands back, while
/// <see cref="FootPrintRoof.GetProfiles"/> starts at another edge. Live Revit: <c>set_Overhang</c> refuses a sketched
/// roof with "The roof is not created by pick walls", and the API cannot pick walls. So an overhang moves the outline
/// out, and each sloped eave goes down by as much as its slope falls over the overhang, which leaves the roof above the
/// original outline as it would be without an overhang.
/// </summary>
public sealed class CreateRoofCommand : ICommand
{
    private const double MaxSlopeDeg = 90;

    public string Method => MethodNames.CreateRoof;

    public bool NeedsDocument => true;

    public JsonElement Execute(CommandContext context, JsonElement parameters)
    {
        var document = context.Document!;
        var entries = ItemBatch.ReadItems(parameters, Method)
            .Select((item, index) => ReadRoof(document, item, index))
            .ToList();

        // Kept for the read-back, so that actual lists the edges in the order of the caller.
        var eaves = new Dictionary<ElementId, IReadOnlyList<Line>>();

        return ItemBatch.Run(
            document,
            Method,
            entries,
            input =>
            {
                var roof = Build(document, input);
                eaves[roof.Id] = input.Eaves;
                return roof;
            },
            element => Describe(document, (FootPrintRoof)element, eaves[element.Id]));
    }

    private static FootPrintRoof Build(Document document, RoofInput input)
    {
        var footprint = new CurveArray();
        foreach (var eave in input.Eaves)
        {
            footprint.Append(eave);
        }

        // Must hold an array before the call, or Revit fails with "Value cannot be null".
        var created = new ModelCurveArray();
        var roof = document.Create.NewFootPrintRoof(footprint, input.Level, input.Type, out created);
        var curves = created.Cast<ModelCurve>().ToList();

        foreach (var (eave, slopeDeg) in input.Eaves.Zip(input.SlopesDeg))
        {
            var curve = CurveOf(document, curves, eave);
            roof.set_DefinesSlope(curve, slopeDeg is not null);

            if (slopeDeg is { } degrees)
            {
                var slope = Math.Tan(Units.DegToRad(degrees));
                roof.set_SlopeAngle(curve, slope);
                roof.set_Offset(curve, -input.Overhang * slope);
            }
        }

        return roof;
    }

    /// <summary>The sketch curve of an eave, by its ends, in either direction. Heights are not compared.</summary>
    private static ModelCurve CurveOf(Document document, IEnumerable<ModelCurve> curves, Line eave)
    {
        var tolerance = document.Application.ShortCurveTolerance;

        return curves.FirstOrDefault(curve => SameEnds(curve.GeometryCurve, eave, tolerance))
            ?? throw new InvalidOperationException(
                $"Revit changed the outline: it has no edge from {PlanText(eave.GetEndPoint(0))} to {PlanText(eave.GetEndPoint(1))}, so a slope could land on the wrong side.");
    }

    private static bool SameEnds(Curve curve, Curve eave, double tolerance)
    {
        var (start, end) = (OnPlan(curve.GetEndPoint(0)), OnPlan(curve.GetEndPoint(1)));
        var (from, to) = (OnPlan(eave.GetEndPoint(0)), OnPlan(eave.GetEndPoint(1)));

        return (start.DistanceTo(from) < tolerance && end.DistanceTo(to) < tolerance)
            || (start.DistanceTo(to) < tolerance && end.DistanceTo(from) < tolerance);
    }

    private static XYZ OnPlan(XYZ point) => new(point.X, point.Y, 0);

    private static string PlanText(XYZ point) => $"({Units.InternalToMm(point.X):0.###}, {Units.InternalToMm(point.Y):0.###}) mm";

    private BatchEntry<RoofInput> ReadRoof(Document document, JsonElement item, int index)
    {
        var reader = new ItemReader(item, $"{Method} item {index}");
        var typeId = reader.Type<RoofType>(document, "typeId", "roofs");
        var level = reader.Level(document, "levelId");
        var outline = reader.Outline(document, "outlineMm", level);
        var slopes = ReadSlopes(reader, outline.NumberOfCurves());
        var overhangMm = reader.NumberOr("overhangMm", 0);

        if (overhangMm < 0)
        {
            throw reader.Refuse($"overhangMm must not be negative, and it is {overhangMm}.");
        }

        var overhang = Units.MmToInternal(overhangMm);
        var eaves = overhang > 0 ? MoveOut(document, reader, outline, overhang) : outline;

        return new BatchEntry<RoofInput>(index, item, new RoofInput(eaves.Cast<Line>().ToList(), slopes, level, (RoofType)document.GetElement(typeId), overhang));
    }

    /// <summary>
    /// Moves an outline out by <paramref name="overhang"/>, whichever way it runs. The result must keep every edge in
    /// its place, because the slopes follow the edges by position. Live Revit: a notch narrower than twice the overhang
    /// makes <see cref="CurveLoop.CreateViaOffset(CurveLoop, double, XYZ)"/> throw an InternalException, which its
    /// documentation does not list.
    /// </summary>
    private static CurveLoop MoveOut(Document document, ItemReader reader, CurveLoop outline, double overhang)
    {
        var tooMuch = reader.Refuse(
            $"overhangMm {Units.InternalToMm(overhang):0.###} is too much for this outline: moving its edges out by that closes a notch or loses an edge. Use a smaller overhang.");

        CurveLoop eaves;
        try
        {
            // Revit moves a curve to its right, seen from above the normal. That is outwards for a counter-clockwise loop.
            eaves = CurveLoop.CreateViaOffset(outline, overhang, outline.IsCounterclockwise(XYZ.BasisZ) ? XYZ.BasisZ : XYZ.BasisZ.Negate());
        }
        catch (Exception e) when (e is Autodesk.Revit.Exceptions.InvalidOperationException or Autodesk.Revit.Exceptions.InternalException)
        {
            throw tooMuch;
        }

        var tolerance = document.Application.ShortCurveTolerance;
        var moved = eaves.Cast<Curve>().ToList();
        var original = outline.Cast<Curve>().ToList();
        var kept = moved.Count == original.Count && moved.Zip(original).All(pair => IsMovedBy(pair.First, pair.Second, overhang, tolerance));

        return kept && BoundaryValidation.IsValidHorizontalBoundary([eaves]) ? eaves : throw tooMuch;
    }

    private static bool IsMovedBy(Curve moved, Curve original, double distance, double tolerance)
    {
        if (moved is not Line line || original is not Line edge || !line.Direction.IsAlmostEqualTo(edge.Direction))
        {
            return false;
        }

        var across = (line.GetEndPoint(0) - edge.GetEndPoint(0)).CrossProduct(edge.Direction).GetLength();

        return Math.Abs(across - distance) < tolerance;
    }

    private static double?[] ReadSlopes(ItemReader reader, int edges)
    {
        if (!reader.Item.TryGetProperty("edgeSlopesDeg", out var slopes) || slopes.ValueKind != JsonValueKind.Array)
        {
            throw reader.Refuse("edgeSlopesDeg must be a list with one entry per edge of the outline: degrees, or null for an edge without a slope.");
        }

        if (slopes.GetArrayLength() != edges)
        {
            throw reader.Refuse($"edgeSlopesDeg has {slopes.GetArrayLength()} entries, and the outline has {edges} edges, so it needs {edges}.");
        }

        var read = slopes.EnumerateArray()
            .Select((slope, edge) => slope.ValueKind == JsonValueKind.Null ? (double?)null : ReadSlope(reader, slope, edge))
            .ToArray();

        return read.Any(slope => slope is not null)
            ? read
            : throw reader.Refuse("edgeSlopesDeg needs a slope on at least one edge, as a roof with none is flat. A flat roof is not what this tool builds.");
    }

    private static double ReadSlope(ItemReader reader, JsonElement slope, int edge)
    {
        var degrees = reader.Number($"edgeSlopesDeg[{edge}]", slope);

        return degrees is > 0 and < MaxSlopeDeg
            ? degrees
            : throw reader.Refuse($"edgeSlopesDeg[{edge}] is {degrees}, and a slope is above 0 and below {MaxSlopeDeg} degrees. Use null for an edge without a slope.");
    }

    private static object Describe(Document document, FootPrintRoof roof, IReadOnlyList<Line> eaves)
    {
        var curves = roof.GetProfiles().Cast<ModelCurveArray>().SelectMany(loop => loop.Cast<ModelCurve>()).ToList();
        var box = roof.get_BoundingBox(null);

        return new
        {
            edges = eaves.Select(eave => DescribeEdge(roof, CurveOf(document, curves, eave))).ToList(),
            typeId = roof.GetTypeId().ToString(),
            levelId = roof.LevelId.ToString(),
            boundingBoxMm = box is null ? null : new { min = PointMm(box.Min), max = PointMm(box.Max) },
        };
    }

    /// <summary>Revit disables <c>SlopeAngle</c> on an edge that defines no slope, and reading it then throws.</summary>
    private static object DescribeEdge(FootPrintRoof roof, ModelCurve curve)
    {
        var geometry = curve.GeometryCurve;
        var definesSlope = roof.get_DefinesSlope(curve);

        return new
        {
            startMm = PlanPoint(geometry.GetEndPoint(0)),
            endMm = PlanPoint(geometry.GetEndPoint(1)),
            definesSlope,
            slopeDeg = definesSlope ? Units.RadToDeg(Math.Atan(roof.get_SlopeAngle(curve))) : (double?)null,
            eaveOffsetMm = Units.InternalToMm(roof.get_Offset(curve)),
        };
    }

    private static object PlanPoint(XYZ point) => new { x = Units.InternalToMm(point.X), y = Units.InternalToMm(point.Y) };

    private static object PointMm(XYZ point) => new
    {
        x = Units.InternalToMm(point.X),
        y = Units.InternalToMm(point.Y),
        z = Units.InternalToMm(point.Z),
    };

    private sealed record RoofInput(IReadOnlyList<Line> Eaves, IReadOnlyList<double?> SlopesDeg, Level Level, RoofType Type, double Overhang);
}
