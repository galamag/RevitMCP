using System.Text.Json;
using Autodesk.Revit.DB;
using RevitMCP.Bridge;

namespace RevitMCP.Commands;

/// <summary>A point of a floor plan in millimetres. Its height comes from a level.</summary>
internal readonly record struct PlanPointMm(double X, double Y);

/// <summary>
/// Reads one item of a batch. All of this runs before the transaction opens, so a refusal keeps its code, and it names
/// the item. Nothing is substituted: an ID that does not fit refuses the call and lists the values that would.
/// </summary>
internal readonly record struct ItemReader(JsonElement Item, string Where)
{
    /// <summary>The most types a refusal lists, so a project with hundreds of them does not bury the message.</summary>
    private const int MaxListedTypes = 50;

    public RequestFailedException Refuse(string problem) => new(JsonRpcCodes.InvalidParams, $"{Where}: {problem}");

    public bool Has(string key) => Item.TryGetProperty(key, out var value) && value.ValueKind != JsonValueKind.Null;

    public string Text(string key) =>
        Item.TryGetProperty(key, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()!
            : throw Refuse($"{key} must be text.");

    public double Number(string key) =>
        Item.TryGetProperty(key, out var value) ? Finite(key, value) : throw Refuse($"{key} must be a number.");

    public double NumberOr(string key, double fallback) => Has(key) ? Number(key) : fallback;

    public bool FlagOr(string key, bool fallback)
    {
        if (!Has(key))
        {
            return fallback;
        }

        return Item.GetProperty(key).ValueKind switch
        {
            JsonValueKind.True => true,
            JsonValueKind.False => false,
            _ => throw Refuse($"{key} must be true or false."),
        };
    }

    public PlanPointMm Point(string key) =>
        Item.TryGetProperty(key, out var value)
            ? Point(key, value)
            : throw Refuse($"{key} must be a point with x and y in millimetres.");

    public PlanPointMm Point(string key, JsonElement point) =>
        point.ValueKind == JsonValueKind.Object
        && point.TryGetProperty("x", out var x)
        && point.TryGetProperty("y", out var y)
            ? new PlanPointMm(Finite($"{key}.x", x), Finite($"{key}.y", y))
            : throw Refuse($"{key} must be a point with x and y in millimetres.");

    /// <summary>Reads a level by ID, as <c>get_model_info</c> lists them.</summary>
    public Level Level(Document document, string key)
    {
        if (ElementIds.TryParse(ReadId(key), out var id) && document.GetElement(id) is Level level)
        {
            return level;
        }

        var valid = new FilteredElementCollector(document)
            .OfClass(typeof(Level))
            .Cast<Level>()
            .OrderBy(level => level.ProjectElevation)
            .Select(level => $"{level.Id} ('{level.Name}', {Units.InternalToMm(level.ProjectElevation):0.###} mm)");

        throw Refuse($"{key} {Item.GetProperty(key).GetRawText()} is not a level. The levels of this project: {string.Join(", ", valid)}.");
    }

    /// <summary>Reads a type by ID, with the same <paramref name="category"/> word as <c>list_types</c>.</summary>
    public ElementId Type<T>(Document document, string key, string category)
        where T : ElementType
    {
        if (!CategoryMap.TryFind(category, out var builtIn))
        {
            throw new ArgumentException($"'{category}' is not a category word.", nameof(category));
        }

        if (ElementIds.TryParse(ReadId(key), out var id)
            && document.GetElement(id) is T { Category: { } found }
            && found.BuiltInCategory == builtIn)
        {
            return id;
        }

        var valid = new FilteredElementCollector(document)
            .OfCategory(builtIn)
            .WhereElementIsElementType()
            .OfType<T>()
            .OrderBy(type => type.FamilyName, StringComparer.Ordinal)
            .ThenBy(type => type.Name, StringComparer.Ordinal)
            .ThenBy(type => type.Id.Value)
            .Select(type => $"{type.Id} ('{type.FamilyName}: {type.Name}')")
            .ToList();

        var listed = valid.Count == 0
            ? "none"
            : string.Join(", ", valid.Take(MaxListedTypes)) + (valid.Count > MaxListedTypes ? $", and {valid.Count - MaxListedTypes} more, see list_types" : string.Empty);

        throw Refuse(
            $"{key} {Item.GetProperty(key).GetRawText()} is not a type of {category}. "
            + $"The types of {category} in this project: {listed}.");
    }

    private string ReadId(string key) =>
        Item.TryGetProperty(key, out var id) && id.ValueKind == JsonValueKind.String
            ? id.GetString()!
            : throw Refuse($"{key} must be an element id, as text.");

    private double Finite(string key, JsonElement value) =>
        value.ValueKind == JsonValueKind.Number && double.IsFinite(value.GetDouble())
            ? value.GetDouble()
            : throw Refuse($"{key} must be a number, not {value.GetRawText()}.");
}
