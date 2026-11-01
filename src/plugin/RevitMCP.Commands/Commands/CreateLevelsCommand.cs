using System.Text.Json;
using Autodesk.Revit.DB;
using RevitMCP.Bridge;
using RevitMCP.Commands.Dispatch;

namespace RevitMCP.Commands;

/// <summary>
/// Creates levels, each with a floor plan unless told otherwise, as one transaction. An existing level is never
/// changed: its name, matched exactly, gives <see cref="ItemStatus.AlreadyExisted"/> and what it really is, with a
/// warning where that is not what the caller asked for.
/// </summary>
public sealed class CreateLevelsCommand : ICommand
{
    /// <summary>A smaller difference between two elevations is noise from converting units.</summary>
    private const double SameElevationMm = 0.01;

    public string Method => MethodNames.CreateLevels;

    public bool NeedsDocument => true;

    public JsonElement Execute(CommandContext context, JsonElement parameters)
    {
        var document = context.Document!;
        var levels = new FilteredElementCollector(document).OfClass(typeof(Level)).Cast<Level>().ToList();
        var items = ItemBatch.ReadItems(parameters, Method);
        var entries = items.Select((item, index) => ReadLevel(document, levels, item, index)).ToList();

        RefuseRepeatedNames(entries);

        var planType = entries.Any(entry => entry.Settled is null && entry.Input.CreatePlan) ? FindPlanType(document) : null;

        return ItemBatch.Run(document, Method, entries, input => Build(document, input, planType), element => Describe(document, (Level)element));
    }

    private static Level Build(Document document, LevelInput input, ElementId? planType)
    {
        var level = Level.Create(document, Units.MmToInternal(input.ElevationMm));
        level.Name = input.Name;

        // After the name, because the plan takes its name from the level.
        if (input.CreatePlan)
        {
            ViewPlan.Create(document, planType, level.Id);
        }

        return level;
    }

    private BatchEntry<LevelInput> ReadLevel(Document document, List<Level> levels, JsonElement item, int index)
    {
        var reader = new ItemReader(item, $"{Method} item {index}");
        var name = reader.Text("name");

        if (string.IsNullOrWhiteSpace(name) || name != name.Trim() || !NamingUtils.IsValidName(name))
        {
            throw reader.Refuse(
                $"'{name}' cannot be a level name: Revit forbids an empty name, spaces at either end and the characters {{ }} [ ] | ; < > ? ` ~ \\ :");
        }

        var input = new LevelInput(name, reader.Number("elevationMm"), reader.FlagOr("createPlan", true));
        var existing = levels.FirstOrDefault(level => level.Name == name);

        return new BatchEntry<LevelInput>(index, item, input, existing is null ? null : ReportExisting(document, existing, input, index, item));
    }

    private static ItemResult ReportExisting(Document document, Level level, LevelInput input, int index, JsonElement requested)
    {
        var warnings = new List<string>();
        var elevationMm = Units.InternalToMm(level.ProjectElevation);

        if (Math.Abs(elevationMm - input.ElevationMm) > SameElevationMm)
        {
            warnings.Add($"Level '{level.Name}' stands at {elevationMm:0.###} mm, not at the {input.ElevationMm:0.###} mm asked for. It was not moved.");
        }

        if (input.CreatePlan && FindFloorPlan(document, level) is null)
        {
            warnings.Add($"Level '{level.Name}' has no floor plan, and none was created, because an existing level is left as it is.");
        }

        return new ItemResult(
            index,
            ItemStatus.AlreadyExisted,
            level.Id.ToString(),
            requested,
            JsonSerializer.SerializeToElement(Describe(document, level), ProjectSupport.Options),
            warnings,
            null);
    }

    private void RefuseRepeatedNames(List<BatchEntry<LevelInput>> entries)
    {
        var repeated = entries.GroupBy(entry => entry.Input.Name, StringComparer.Ordinal).FirstOrDefault(group => group.Count() > 1);

        if (repeated is not null)
        {
            throw new RequestFailedException(
                JsonRpcCodes.InvalidParams,
                $"{Method}: items {string.Join(" and ", repeated.Select(entry => entry.Index))} both name '{repeated.Key}'. A level name is unique, so keep one.");
        }
    }

    private static object Describe(Document document, Level level)
    {
        var plan = FindFloorPlan(document, level);

        return new
        {
            name = level.Name,
            elevationMm = Units.InternalToMm(level.ProjectElevation),
            planViewId = plan?.Id.ToString(),
            planViewName = plan?.Name,
        };
    }

    /// <summary>
    /// The floor plan of a level. <c>Level.FindAssociatedPlanViewId</c> is not used: it returns the first floor or
    /// structural plan, so it can name a structural plan, or miss the floor plan behind one.
    /// <see cref="CreateRoomSeparatorsCommand"/> draws in this plan, and so tells a level that has one.
    /// </summary>
    internal static ViewPlan? FindFloorPlan(Document document, Level level) =>
        new FilteredElementCollector(document)
            .OfClass(typeof(ViewPlan))
            .Cast<ViewPlan>()
            .Where(view => !view.IsTemplate && view.ViewType == ViewType.FloorPlan && view.GenLevel?.Id == level.Id)
            .OrderBy(view => view.Id.Value)
            .FirstOrDefault();

    /// <summary>Found by family, because the names of view types are localized.</summary>
    private ElementId FindPlanType(Document document) =>
        new FilteredElementCollector(document)
            .OfClass(typeof(ViewFamilyType))
            .Cast<ViewFamilyType>()
            .Where(type => type.ViewFamily == ViewFamily.FloorPlan)
            .OrderBy(type => type.Id.Value)
            .FirstOrDefault()?.Id
            ?? throw new RequestFailedException(JsonRpcCodes.InternalError, $"{Method}: this project has no floor plan view type.");

    private sealed record LevelInput(string Name, double ElevationMm, bool CreatePlan);
}
