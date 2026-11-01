using System.Text.Json;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Architecture;
using RevitMCP.Bridge;
using RevitMCP.Commands.Dispatch;
using RegenerationFailedException = Autodesk.Revit.Exceptions.RegenerationFailedException;

namespace RevitMCP.Commands;

/// <summary>
/// Builds one stairs per call through <see cref="EditScopeOperation"/>, as a scope holds one stairs: straight with one run, or
/// with two runs and an automatic landing between them. So <see cref="ItemBatch.Run"/> does not fit, and this keeps only the
/// shape of its answer. Live Revit (probe, step 2): a run makes <c>round(length / tread) + 1</c> risers and is fitted to that
/// length; the height of a run's line is in model coordinates; a second run must start at the height where the first ends, with
/// any split of the risers as long as they add up; and stairs short of their risers are committed with only a warning. So the
/// risers of each run are worked out and compared before anything changes, and the height of a second run is worked out here.
/// What Revit decides on runs that exist, whether a landing can join them and whether the stairs reach the top level, is read
/// inside the scope, and what is wrong there fails the item with the scope cancelled. <see cref="Stairs.TopElevation"/> reads
/// the level even for stairs that stop short, so the real top comes from the last run. Railings come by themselves, when the
/// scope closes.
/// </summary>
public sealed class CreateStairsCommand : ICommand
{
    /// <summary>The fewest risers of a run, and so of a stairs, as a run of one has no tread. <c>registry.ts</c> states it too.</summary>
    private const int MinRisers = 2;

    /// <summary>The most risers of one stairs, which <c>registry.ts</c> states too. Far above any storey.</summary>
    private const int MaxRisers = 500;

    /// <summary>The most runs of one stairs, which <c>registry.ts</c> states too.</summary>
    private const int MaxRuns = 2;

    /// <summary>A height closer than this to the one asked for is the same one: the noise of converting units.</summary>
    private const double SameHeightMm = 0.1;

    private const string NotAttempted = "Not attempted: Revit could not start the stairs edit mode, so nothing was built. See errors.";

    public string Method => MethodNames.CreateStairs;

    public bool NeedsDocument => true;

    public JsonElement Execute(CommandContext context, JsonElement parameters)
    {
        var document = context.Document!;
        var items = ItemBatch.ReadItems(parameters, Method);

        if (items.Count != 1)
        {
            throw new RequestFailedException(JsonRpcCodes.InvalidParams, $"{Method} builds one stairs in one call, and got {items.Count} items. Send them one call at a time.");
        }

        var item = items[0];
        var input = ReadStairs(document, item);
        var results = new ItemResult?[1];

        var outcome = EditScopeOperation.Run(document, Method, input.BaseLevelId, input.TopLevelId, (scope, stairsId) =>
        {
            try
            {
                Build(document, stairsId, input);
                results[0] = new ItemResult(0, ItemStatus.Created, stairsId.ToString(), item, null, [], null);
            }
            catch (RegenerationFailedException e)
            {
                // Revit's own text is only "Failed to regenerate.", so say what that means for this item.
                Fail($"Revit could not build these stairs and gave no reason: {e.Message}", e);
            }
            catch (Exception e)
            {
                Fail(e.Message, e);
            }

            void Fail(string message, Exception e)
            {
                Log.Error($"{Method} failed.", e);
                results[0] = new ItemResult(0, ItemStatus.Failed, null, item, null, [], message);
                scope.Abort($"The stairs failed, so nothing landed: {message}");
            }
        });

        if (outcome.Committed)
        {
            ItemBatch.ReadBackAll(document, results, element => Describe(document, (Stairs)element), null, Method);
        }

        var batch = new BatchResult();
        batch.Add(results[0] ?? new ItemResult(0, ItemStatus.RolledBack, null, item, null, [], NotAttempted));

        return batch.ToJson(outcome);
    }

    /// <summary>Everything here runs inside the scope, so what it throws cancels the scope and fails the item.</summary>
    private static void Build(Document document, ElementId stairsId, StairsInput input)
    {
        var stairs = (Stairs)document.GetElement(stairsId);

        // First: a new stairs starts with the type used last, and the type brings the defaults of the rest.
        stairs.ChangeTypeId(input.TypeId);
        stairs.DesiredRisersNumber = input.DesiredRisers;

        var riserHeight = (input.TopElevation - input.BaseElevation) / input.DesiredRisers;
        var runs = new List<StairsRun>();
        var risersBelow = 0;

        foreach (var run in input.Runs)
        {
            // Worked out here and never taken from input. Live Revit rounds it to a multiple of the riser height, and half a riser or more off leaves the second run at a height no landing joins.
            var height = input.BaseElevation + (risersBelow * riserHeight);
            var line = Line.CreateBound(
                new XYZ(Units.MmToInternal(run.Start.X), Units.MmToInternal(run.Start.Y), height),
                new XYZ(Units.MmToInternal(run.End.X), Units.MmToInternal(run.End.Y), height));

            var created = StairsRun.CreateStraightRun(document, stairsId, line, StairsRunJustification.Center);
            created.ActualRunWidth = Units.MmToInternal(input.WidthMm);

            runs.Add(created);
            risersBelow += run.Risers;
        }

        if (runs.Count == MaxRuns)
        {
            Join(document, runs[0], runs[1]);
        }

        document.Regenerate();
        Verify(stairs, runs, input);
    }

    /// <summary>The lower run goes first: live Revit says yes to the other order, and then throws an exception the API does not list.</summary>
    private static void Join(Document document, StairsRun lower, StairsRun upper)
    {
        if (!StairsLanding.CanCreateAutomaticLanding(document, lower.Id, upper.Id))
        {
            throw new InvalidOperationException(
                "Revit cannot join the two runs with a landing. The second run must go on from the end of the first: back beside it, at a corner or straight on. Runs that overlap, cross or climb side by side in one direction cannot be joined. Move the second run.");
        }

        if (StairsLanding.CreateAutomaticLanding(document, lower.Id, upper.Id).Count == 0)
        {
            throw new InvalidOperationException("Revit said a landing can join the two runs, and made none.");
        }
    }

    /// <summary>
    /// Compares the stairs with the request while the scope can still be cancelled. Live Revit commits stairs that stop short
    /// or run past the top level, with only a warning, and once the scope has closed that is in the model.
    /// </summary>
    private static void Verify(Stairs stairs, List<StairsRun> runs, StairsInput input)
    {
        var treadMm = Units.InternalToMm(stairs.ActualTreadDepth);

        if (stairs.ActualRisersNumber != input.DesiredRisers)
        {
            throw new InvalidOperationException(
                $"Revit made {stairs.ActualRisersNumber} risers of the {input.DesiredRisers} asked for in desiredRisers, at a tread depth of {Units.FormatNumber(treadMm)} mm, so the stairs would not meet the top level. "
                + $"{NeededLength(input.DesiredRisers, input.Runs.Count, treadMm)}");
        }

        var topMm = Units.InternalToMm(stairs.BaseElevation + runs[^1].TopElevation);
        var wantedMm = Units.InternalToMm(input.TopElevation);

        if (Math.Abs(topMm - wantedMm) > SameHeightMm)
        {
            throw new InvalidOperationException($"The last run of the stairs ends at {Units.FormatNumber(topMm)} mm and the top level is at {Units.FormatNumber(wantedMm)} mm, so the stairs would not meet it.");
        }
    }

    private StairsInput ReadStairs(Document document, JsonElement item)
    {
        var reader = new ItemReader(item, $"{Method} item 0");
        var baseLevel = reader.Level(document, "baseLevelId");
        var topLevel = reader.Level(document, "topLevelId");

        if (topLevel.ProjectElevation <= baseLevel.ProjectElevation)
        {
            throw reader.Refuse(
                $"topLevelId ('{topLevel.Name}', {Units.FormatNumber(Units.InternalToMm(topLevel.ProjectElevation))} mm) must lie above baseLevelId ('{baseLevel.Name}', {Units.FormatNumber(Units.InternalToMm(baseLevel.ProjectElevation))} mm).");
        }

        var typeId = reader.Type<StairsType>(document, "typeId", "stairs");
        var type = (StairsType)document.GetElement(typeId);
        var typeName = $"'{type.FamilyName}: {type.Name}'";

        var widthMm = reader.Number("widthMm");

        if (widthMm <= 0)
        {
            throw reader.Refuse($"widthMm must be above 0, not {Units.FormatNumber(widthMm)}.");
        }

        var desired = item.TryGetProperty("desiredRisers", out var value)
            ? reader.WholeNumber("desiredRisers", value, MinRisers, MaxRisers)
            : throw reader.Refuse($"desiredRisers must be a whole number from {MinRisers} to {MaxRisers}.");

        var treadMm = Units.InternalToMm(type.MinTreadDepth);
        var runs = ReadRuns(reader, item, treadMm, typeName);
        var risers = runs.Sum(run => run.Risers);

        if (desired < runs.Count * MinRisers)
        {
            throw reader.Refuse($"desiredRisers is {desired}, and {runs.Count} runs take at least {runs.Count * MinRisers}, as a run has at least {MinRisers} risers.");
        }

        if (risers != desired)
        {
            var riserMm = Units.InternalToMm(topLevel.ProjectElevation - baseLevel.ProjectElevation) / desired;
            var offMm = Units.FormatNumber(Math.Abs(desired - risers) * riserMm);
            var effect = risers < desired ? $"so the stairs would stop {offMm} mm below level '{topLevel.Name}'" : $"so the stairs would run {offMm} mm past level '{topLevel.Name}'";

            throw reader.Refuse($"{Counted(runs, treadMm, typeName)}, and desiredRisers is {desired}, {effect}. {NeededLength(desired, runs.Count, treadMm)}");
        }

        return new StairsInput(
            baseLevel.Id,
            topLevel.Id,
            baseLevel.ProjectElevation,
            topLevel.ProjectElevation,
            typeId,
            runs,
            widthMm,
            desired);
    }

    private static List<RunInput> ReadRuns(ItemReader reader, JsonElement item, double treadMm, string typeName)
    {
        if (!item.TryGetProperty("runsMm", out var list) || list.ValueKind != JsonValueKind.Array || list.GetArrayLength() is 0 or > MaxRuns)
        {
            throw reader.Refuse("runsMm must list one or two runs, each with startMm and endMm: one run makes straight stairs, and two make stairs with a landing between them.");
        }

        var runs = new List<RunInput>();

        foreach (var (run, index) in list.EnumerateArray().Select((run, index) => (run, index)))
        {
            if (run.ValueKind != JsonValueKind.Object)
            {
                throw reader.Refuse($"run {index} must be an object with startMm and endMm, not {run.GetRawText()}.");
            }

            var runReader = new ItemReader(run, $"{reader.Where}, run {index}");
            var start = runReader.Point("startMm");
            var end = runReader.Point("endMm");
            var lengthMm = double.Hypot(end.X - start.X, end.Y - start.Y);
            var risers = (int)Math.Round(lengthMm / treadMm, MidpointRounding.AwayFromZero) + 1;

            if (risers < MinRisers)
            {
                throw runReader.Refuse(
                    $"it is {Units.FormatNumber(lengthMm)} mm long, shorter than half of the {Units.FormatNumber(treadMm)} mm tread depth of type {typeName}, so it has no tread. A run of N risers is (N - 1) x {Units.FormatNumber(treadMm)} mm long.");
            }

            runs.Add(new RunInput(start, end, lengthMm, risers));
        }

        return runs;
    }

    /// <summary>What the runs make, in words.</summary>
    private static string Counted(List<RunInput> runs, double treadMm, string typeName)
    {
        var tread = $"at the {Units.FormatNumber(treadMm)} mm tread depth of type {typeName}: a run makes its length / tread depth, rounded, plus 1";

        return runs.Count == 1
            ? $"the run is {Units.FormatNumber(runs[0].LengthMm)} mm long, which makes {runs[0].Risers} risers {tread}"
            : $"the runs are {Units.FormatNumber(runs[0].LengthMm)} and {Units.FormatNumber(runs[1].LengthMm)} mm long, which makes {runs[0].Risers} + {runs[1].Risers} = {runs[0].Risers + runs[1].Risers} risers {tread}";
    }

    /// <summary>The length that gives the risers asked for: a run of N risers is (N - 1) treads long.</summary>
    private static string NeededLength(int risers, int runCount, double treadMm)
    {
        if (runCount == 1)
        {
            return $"{risers} risers needs a run of {Units.FormatNumber((risers - 1) * treadMm)} mm, as a run of N risers is (N - 1) x {Units.FormatNumber(treadMm)} mm long.";
        }

        var first = risers / 2;

        return $"Two runs of {risers} risers need {Units.FormatNumber((risers - 2) * treadMm)} mm together, for example {Units.FormatNumber((first - 1) * treadMm)} and {Units.FormatNumber((risers - first - 1) * treadMm)} mm, "
            + $"as a run of N risers is (N - 1) x {Units.FormatNumber(treadMm)} mm long.";
    }

    private static object Describe(Document document, Stairs stairs)
    {
        var runs = stairs.GetStairsRuns().Select(id => (StairsRun)document.GetElement(id)).ToList();
        var landings = stairs.GetStairsLandings().Select(id => (StairsLanding)document.GetElement(id));

        return new
        {
            risers = stairs.ActualRisersNumber,
            riserHeightMm = Units.InternalToMm(stairs.ActualRiserHeight),
            treadDepthMm = Units.InternalToMm(stairs.ActualTreadDepth),
            topElevationMm = Units.InternalToMm(stairs.BaseElevation + runs.Max(run => run.TopElevation)),
            footprintMm = FootprintMm(runs.Select(run => run.GetFootprintBoundary()).Concat(landings.Select(landing => landing.GetFootprintBoundary()))),
            railingIds = stairs.GetAssociatedRailings().Select(id => id.ToString()).ToList(),
        };
    }

    /// <summary>The rectangle that holds all the loops, as the four corners a floor opening takes. Revit keeps the footprint of each part apart.</summary>
    private static List<object> FootprintMm(IEnumerable<CurveLoop> loops)
    {
        var points = loops.SelectMany(loop => loop).SelectMany(curve => curve.Tessellate()).ToList();
        var minX = Units.InternalToMm(points.Min(point => point.X));
        var maxX = Units.InternalToMm(points.Max(point => point.X));
        var minY = Units.InternalToMm(points.Min(point => point.Y));
        var maxY = Units.InternalToMm(points.Max(point => point.Y));

        return [new { x = minX, y = minY }, new { x = maxX, y = minY }, new { x = maxX, y = maxY }, new { x = minX, y = maxY }];
    }

    /// <param name="Risers">What Revit will make of the length, by the rule of a run.</param>
    private sealed record RunInput(PlanPointMm Start, PlanPointMm End, double LengthMm, int Risers);

    /// <param name="BaseElevation">The height of the base level in the model, in internal units, as the height of a run is.</param>
    /// <param name="TopElevation">The height of the top level in the same way.</param>
    private sealed record StairsInput(
        ElementId BaseLevelId,
        ElementId TopLevelId,
        double BaseElevation,
        double TopElevation,
        ElementId TypeId,
        List<RunInput> Runs,
        double WidthMm,
        int DesiredRisers);
}
