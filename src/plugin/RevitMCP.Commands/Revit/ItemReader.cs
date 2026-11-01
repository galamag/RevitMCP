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
    /// <summary>The most choices a refusal lists, so a project with hundreds of them does not bury the message.</summary>
    private const int MaxListed = 50;

    /// <summary>The fewest points of an outline, which <c>registry.ts</c> states too.</summary>
    private const int MinOutlinePoints = 3;

    public RequestFailedException Refuse(string problem) => new(JsonRpcCodes.InvalidParams, $"{Where}: {problem}");

    public bool Has(string key) => Item.TryGetProperty(key, out var value) && value.ValueKind != JsonValueKind.Null;

    public string Text(string key) =>
        Item.TryGetProperty(key, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()!
            : throw Refuse($"{key} must be text.");

    public double Number(string key) =>
        Item.TryGetProperty(key, out var value) ? Finite(key, value) : throw Refuse($"{key} must be a number.");

    public double Number(string key, JsonElement value) => Finite(key, value);

    public double NumberOr(string key, double fallback) => Has(key) ? Number(key) : fallback;

    /// <summary>A whole number in <paramref name="min"/> to <paramref name="max"/>, as the contract states it.</summary>
    public int WholeNumber(string key, JsonElement value, int min, int max)
    {
        var number = Finite(key, value);

        return Math.Floor(number) == number && number >= min && number <= max
            ? (int)number
            : throw Refuse($"{key} must be a whole number from {min} to {max}, not {value.GetRawText()}.");
    }

    /// <summary>
    /// Reads the name of something to create. Revit forbids an empty name, spaces at either end and some characters, and
    /// a name it refuses inside the transaction would cost the item its error code.
    /// </summary>
    public string Name(string key, string what)
    {
        var name = Text(key);

        return string.IsNullOrWhiteSpace(name) || name != name.Trim() || !NamingUtils.IsValidName(name)
            ? throw Refuse($"'{name}' cannot be {what} name: Revit forbids an empty name, spaces at either end and the characters {{ }} [ ] | ; < > ? ` ~ \\ :")
            : name;
    }

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

    /// <summary>
    /// Reads an outline of straight edges, in the order given, at the height of <paramref name="level"/>. It closes by
    /// itself, from the last point back to the first, so a first point repeated at the end is two equal neighbours, and
    /// that is refused.
    /// </summary>
    public CurveLoop Outline(Document document, string key, Level level)
    {
        if (!Item.TryGetProperty(key, out var outline) || outline.ValueKind != JsonValueKind.Array || outline.GetArrayLength() < MinOutlinePoints)
        {
            throw Refuse($"{key} must be a list of at least {MinOutlinePoints} points.");
        }

        var elevationMm = Units.InternalToMm(level.ProjectElevation);
        var points = new List<XYZ>();
        foreach (var corner in outline.EnumerateArray())
        {
            var point = Point(key, corner);
            points.Add(Units.PointMm(point.X, point.Y, elevationMm));
        }

        var shortest = document.Application.ShortCurveTolerance;
        var loop = new CurveLoop();
        for (var index = 0; index < points.Count; index++)
        {
            var next = (index + 1) % points.Count;
            if (points[index].DistanceTo(points[next]) < shortest)
            {
                throw Refuse(
                    $"{key} points {index} and {next} are closer than the {Units.InternalToMm(shortest):0.###} mm Revit can draw. The outline closes by itself, so do not repeat the first point.");
            }

            loop.Append(Line.CreateBound(points[index], points[next]));
        }

        return BoundaryValidation.IsValidHorizontalBoundary([loop])
            ? loop
            : throw Refuse($"Revit does not take {key} as an outline: it must enclose an area, and its edges must not cross or touch.");
    }

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

    /// <summary>Reads a material by ID, as <c>list_materials</c> lists them.</summary>
    public Material Material(Document document, string key)
    {
        if (ElementIds.TryParse(ReadId(key), out var id) && document.GetElement(id) is Material material)
        {
            return material;
        }

        var valid = new FilteredElementCollector(document)
            .OfClass(typeof(Material))
            .Cast<Material>()
            .OrderBy(material => material.Name, StringComparer.Ordinal)
            .ThenBy(material => material.Id.Value)
            .Select(material => $"{material.Id} ('{material.Name}')")
            .ToList();

        throw Refuse($"{key} {Item.GetProperty(key).GetRawText()} is not a material. The materials of this project: {Listing(valid, ", see list_materials")}.");
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

        throw Refuse(
            $"{key} {Item.GetProperty(key).GetRawText()} is not a type of {category}. "
            + $"The types of {category} in this project: {Listing(valid, ", see list_types")}.");
    }

    /// <summary>
    /// Reads the type of a loaded family by ID, whatever its category, as <c>load_family</c> and <c>list_types</c> give them.
    /// </summary>
    public FamilySymbol FamilyType(Document document, string key)
    {
        if (ElementIds.TryParse(ReadId(key), out var id) && document.GetElement(id) is FamilySymbol symbol)
        {
            return symbol;
        }

        var valid = new FilteredElementCollector(document)
            .OfClass(typeof(FamilySymbol))
            .Cast<FamilySymbol>()
            .OrderBy(type => type.FamilyName, StringComparer.Ordinal)
            .ThenBy(type => type.Name, StringComparer.Ordinal)
            .ThenBy(type => type.Id.Value)
            .Select(type => $"{type.Id} ('{type.FamilyName}: {type.Name}')")
            .ToList();

        throw Refuse(
            $"{key} {Item.GetProperty(key).GetRawText()} is not a type of a loaded family. Take it from actual.typeIds of load_family, or from list_types with doors, windows, furniture or plumbing. "
            + $"The family types of this project: {Listing(valid, ", see list_types")}.");
    }

    /// <summary>Reads an element of the model by ID, with the same <paramref name="category"/> word as <c>list_types</c>.</summary>
    public T Instance<T>(Document document, string key, string category)
        where T : Element
    {
        if (!CategoryMap.TryFind(category, out var builtIn))
        {
            throw new ArgumentException($"'{category}' is not a category word.", nameof(category));
        }

        if (ElementIds.TryParse(ReadId(key), out var id) && document.GetElement(id) is T { Category: { } found } element && found.BuiltInCategory == builtIn)
        {
            return element;
        }

        var valid = new FilteredElementCollector(document)
            .OfCategory(builtIn)
            .WhereElementIsNotElementType()
            .OfType<T>()
            .Select(instance => instance.Id.ToString())
            .ToList();

        throw Refuse($"{key} {Item.GetProperty(key).GetRawText()} is not one of the {category} of this model. Its {category}: {Listing(valid)}.");
    }

    private static string Listing(List<string> valid, string hint = "") =>
        valid.Count == 0
            ? "none"
            : string.Join(", ", valid.Take(MaxListed)) + (valid.Count > MaxListed ? $", and {valid.Count - MaxListed} more{hint}" : string.Empty);

    private string ReadId(string key) =>
        Item.TryGetProperty(key, out var id) && id.ValueKind == JsonValueKind.String
            ? id.GetString()!
            : throw Refuse($"{key} must be an element id, as text.");

    private double Finite(string key, JsonElement value) =>
        value.ValueKind == JsonValueKind.Number && double.IsFinite(value.GetDouble())
            ? value.GetDouble()
            : throw Refuse($"{key} must be a number, not {value.GetRawText()}.");
}
