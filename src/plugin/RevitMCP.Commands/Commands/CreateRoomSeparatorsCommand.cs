using System.Text.Json;
using Autodesk.Revit.DB;
using RevitMCP.Bridge;
using RevitMCP.Commands.Dispatch;

namespace RevitMCP.Commands;

/// <summary>
/// Draws room separation lines as one transaction. Live Revit (probe, step 8): <c>NewRoomBoundaryLines</c> takes its level from the
/// view and not from the plane or the curve, so the view is the one thing that matters, and it is always the floor plan of the level
/// (<see cref="CreateLevelsCommand.FindFloorPlan"/>). A level without one is refused before the transaction, and so nothing else
/// is ever passed: not the active view, which can be a 3D view, and not any view of a kind that was not looked at. A separator from
/// a 3D view closed Revit with an access violation in the probe, which of the calls did it is not known, and
/// the sketch plane that a view holds is not read here either, as <c>SketchPlane.Create(document, level.Id)</c> needs no view.
/// The line is drawn at the height of the level. A line that stops short of a wall and of another separator divides nothing, and Revit
/// says nothing about it, so the tool text says so and the areas of the rooms are what tells. What Revit made is read back inside
/// the transaction and compared with the request.
/// </summary>
public sealed class CreateRoomSeparatorsCommand : ICommand
{
    /// <summary>A position closer than this to the one asked for is the same one: the noise of converting units.</summary>
    private const double SamePositionMm = 0.1;

    public string Method => MethodNames.CreateRoomSeparators;

    public bool NeedsDocument => true;

    public JsonElement Execute(CommandContext context, JsonElement parameters)
    {
        var document = context.Document!;
        var entries = ItemBatch.ReadItems(parameters, Method)
            .Select((item, index) => ReadSeparator(document, item, index))
            .ToList();

        return ItemBatch.Run(document, Method, entries, input => Build(document, input), Describe);
    }

    private static ModelCurve Build(Document document, SeparatorInput input)
    {
        var plan = document.GetElement(input.PlanId) as ViewPlan
            ?? throw new InvalidOperationException($"View {input.PlanId} is not a plan view, so no separator is drawn in it.");

        // Checked again where the view is used: the one view that must never get here is a 3D view.
        if (plan.IsTemplate || plan.ViewType != ViewType.FloorPlan || plan.GenLevel?.Id != input.LevelId)
        {
            throw new InvalidOperationException($"View {input.PlanId} is not the floor plan of level {input.LevelId}, so no separator is drawn in it.");
        }

        var plane = SketchPlane.Create(document, input.LevelId);
        var curves = new CurveArray();
        curves.Append(input.Line);

        var made = document.Create.NewRoomBoundaryLines(plane, curves, plan);
        document.Regenerate();

        return Verify(made, input);
    }

    /// <summary>Compares what Revit made with the request: one separation line, on the level, from the start to the end in either direction.</summary>
    private static ModelCurve Verify(ModelCurveArray? made, SeparatorInput input)
    {
        if (made is null || made.Size != 1)
        {
            throw new InvalidOperationException($"Revit made {made?.Size ?? 0} lines for this item and not the one asked for.");
        }

        if (made.get_Item(0) is not ModelCurve line || line.Category?.BuiltInCategory != BuiltInCategory.OST_RoomSeparationLines)
        {
            throw new InvalidOperationException("Revit made a line that is not a room separation line.");
        }

        if (line.LevelId != input.LevelId)
        {
            throw new InvalidOperationException($"Revit put the separator on level {line.LevelId} and not on level {input.LevelId}.");
        }

        var curve = line.GeometryCurve;
        var from = input.StartMm;
        var to = input.EndMm;

        var forwards = curve.IsBound && Meets(curve.GetEndPoint(0), from) && Meets(curve.GetEndPoint(1), to);
        var backwards = curve.IsBound && Meets(curve.GetEndPoint(0), to) && Meets(curve.GetEndPoint(1), from);

        if (!forwards && !backwards)
        {
            throw new InvalidOperationException(
                $"Revit made separator {line.Id}, but it does not run from {Format(from)} to {Format(to)} mm, as startMm and endMm asked.");
        }

        return line;
    }

    private static bool Meets(XYZ point, PlanPointMm wanted) =>
        Math.Abs(Units.InternalToMm(point.X) - wanted.X) <= SamePositionMm && Math.Abs(Units.InternalToMm(point.Y) - wanted.Y) <= SamePositionMm;

    private BatchEntry<SeparatorInput> ReadSeparator(Document document, JsonElement item, int index)
    {
        var reader = new ItemReader(item, $"{Method} item {index}");
        var level = reader.Level(document, "levelId");
        var start = reader.Point("startMm");
        var end = reader.Point("endMm");

        var shortest = document.Application.ShortCurveTolerance;

        if (Units.MmToInternal(double.Hypot(end.X - start.X, end.Y - start.Y)) < shortest)
        {
            throw reader.Refuse(
                $"startMm and endMm are closer than the {Units.FormatNumber(Units.InternalToMm(shortest))} mm Revit can draw, so there is no line between them.");
        }

        var plan = CreateLevelsCommand.FindFloorPlan(document, level)
            ?? throw reader.Refuse(
                $"level {level.Id} ('{level.Name}') has no floor plan view. A room separator takes its level from the plan it is drawn in, and the active view is never used, so there is nowhere to draw it. "
                + $"Levels that have a floor plan: {PlanLevels(document)}. create_levels makes a plan with the level unless createPlan is false.");

        var elevationMm = Units.InternalToMm(level.ProjectElevation);
        var line = Line.CreateBound(Units.PointMm(start.X, start.Y, elevationMm), Units.PointMm(end.X, end.Y, elevationMm));

        return new BatchEntry<SeparatorInput>(index, item, new SeparatorInput(level.Id, plan.Id, line, start, end));
    }

    private static string PlanLevels(Document document)
    {
        var named = new FilteredElementCollector(document)
            .OfClass(typeof(Level))
            .Cast<Level>()
            .Where(level => CreateLevelsCommand.FindFloorPlan(document, level) is not null)
            .OrderBy(level => level.ProjectElevation)
            .Select(level => $"{level.Id} ('{level.Name}')")
            .ToList();

        return named.Count == 0 ? "none" : string.Join(", ", named);
    }

    private static object Describe(Element element)
    {
        var curve = ((ModelCurve)element).GeometryCurve;

        return new
        {
            levelId = element.LevelId.ToString(),
            startMm = PlanPoint(curve.GetEndPoint(0)),
            endMm = PlanPoint(curve.GetEndPoint(1)),
        };
    }

    private static object PlanPoint(XYZ point) => new { x = Units.InternalToMm(point.X), y = Units.InternalToMm(point.Y) };

    private static string Format(PlanPointMm point) => $"({Units.FormatNumber(point.X)}, {Units.FormatNumber(point.Y)})";

    /// <param name="PlanId">The floor plan of the level, the only view the separator is drawn in.</param>
    private sealed record SeparatorInput(ElementId LevelId, ElementId PlanId, Line Line, PlanPointMm StartMm, PlanPointMm EndMm);
}
