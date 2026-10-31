using System.Text.Json;
using Autodesk.Revit.DB;
using RevitMCP.Bridge;
using RevitMCP.Commands.Dispatch;

namespace RevitMCP.Commands;

/// <summary>
/// Creates wall, floor, ceiling and roof types as one transaction: a copy of a base type, with the layers asked for when
/// there are any. The layers go into a copy of the structure of the base, so what the base says besides its layers is
/// kept. An existing type is never changed: its name, matched exactly among the types of the same class, gives
/// <see cref="ItemStatus.AlreadyExisted"/> and what it really is, with a warning where that is not what the caller asked for.
/// </summary>
public sealed class CreateTypeCommand : ICommand
{
    /// <summary>The words of <see cref="CategoryMap"/> that name types with layers.</summary>
    private static readonly string[] Categories = ["walls", "floors", "ceilings", "roofs"];

    /// <summary>The layer functions of the contract, which <c>registry.ts</c> states too.</summary>
    private static readonly Dictionary<string, MaterialFunctionAssignment> Functions = new(StringComparer.Ordinal)
    {
        ["structure"] = MaterialFunctionAssignment.Structure,
        ["substrate"] = MaterialFunctionAssignment.Substrate,
        ["insulation"] = MaterialFunctionAssignment.Insulation,
        ["finish1"] = MaterialFunctionAssignment.Finish1,
        ["finish2"] = MaterialFunctionAssignment.Finish2,
        ["membrane"] = MaterialFunctionAssignment.Membrane,
    };

    /// <summary>A difference between two thicknesses below this is noise from converting units.</summary>
    private const double SameThicknessMm = 0.01;

    public string Method => MethodNames.CreateType;

    public bool NeedsDocument => true;

    public JsonElement Execute(CommandContext context, JsonElement parameters)
    {
        var document = context.Document!;
        var entries = ItemBatch.ReadItems(parameters, Method)
            .Select((item, index) => ReadType(document, item, index))
            .ToList();

        RefuseRepeatedNames(entries);

        return ItemBatch.Run(document, Method, entries, Build, element => Describe((HostObjAttributes)element));
    }

    private static HostObjAttributes Build(TypeInput input)
    {
        var type = (HostObjAttributes)input.Base.Duplicate(input.Name);

        if (input.Layers is { } layers)
        {
            var structure = type.GetCompoundStructure() ?? throw new InvalidOperationException($"The new type '{input.Name}' has no compound structure to put layers in.");
            structure.SetLayers(layers.ConvertAll(layer => layer.ToLayer()));
            type.SetCompoundStructure(structure);
        }

        return type;
    }

    private BatchEntry<TypeInput> ReadType(Document document, JsonElement item, int index)
    {
        var reader = new ItemReader(item, $"{Method} item {index}");
        var baseType = (HostObjAttributes)document.GetElement(reader.Type<HostObjAttributes>(document, "baseTypeId", ReadCategory(reader)));
        var name = reader.Name("name", "a type");
        var layers = reader.Has("layers") ? ReadLayers(document, reader, baseType) : null;
        var input = new TypeInput(baseType, name, layers);
        var existing = new FilteredElementCollector(document)
            .OfClass(baseType.GetType())
            .Cast<ElementType>()
            .FirstOrDefault(type => type.Name == name && type.FamilyName == baseType.FamilyName);

        return new BatchEntry<TypeInput>(index, item, input, existing is HostObjAttributes found ? ReportExisting(found, input, index, item) : null);
    }

    private static string ReadCategory(ItemReader reader)
    {
        var category = reader.Text("category");

        return Categories.Contains(category)
            ? category
            : throw reader.Refuse($"category must be one of {string.Join(", ", Categories)}, not '{category}'.");
    }

    /// <summary>
    /// Reads the layers and has Revit check the stack, on a copy of the structure of the base type. What Revit refuses
    /// would otherwise fail inside the transaction, and the item would lose its error code.
    /// </summary>
    private static List<LayerSpec> ReadLayers(Document document, ItemReader reader, HostObjAttributes baseType)
    {
        var raw = reader.Item.GetProperty("layers");

        if (raw.ValueKind != JsonValueKind.Array || raw.GetArrayLength() == 0)
        {
            throw reader.Refuse("layers must be a list of at least one layer, from the outside in for a wall and from the top down for the others.");
        }

        var structure = baseType.GetCompoundStructure()
            ?? throw reader.Refuse(
                $"baseTypeId {reader.Item.GetProperty("baseTypeId").GetRawText()} ('{baseType.FamilyName}: {baseType.Name}') has no layers to replace, as a curtain or glazed type has none. "
                + "Leave layers out to copy it as it is, or take another base type from list_types.");

        var layers = raw.EnumerateArray().Select((layer, position) => ReadLayer(document, reader, layer, position)).ToList();

        if (layers.All(layer => layer.Function == MaterialFunctionAssignment.Membrane))
        {
            throw reader.Refuse("layers hold nothing but membranes, which have no thickness, so there is no wall, floor, ceiling or roof. Add a layer with a thickness.");
        }

        try
        {
            structure.SetLayers(layers.ConvertAll(layer => layer.ToLayer()));
        }
        catch (Autodesk.Revit.Exceptions.InternalException e)
        {
            // Live Revit: a layer other than a membrane with no thickness, and a stack of membranes only, end here and not in IsValid. Both are checked above.
            Log.Error($"{reader.Where}: Revit refused to set the layers.", e);
            throw reader.Refuse("Revit does not take these layers as a structure, and gave no reason. Check that every layer other than a membrane has a thickness.");
        }

        if (!structure.IsValid(document, out var errors, out _))
        {
            throw reader.Refuse($"Revit does not take these layers as a structure: {Explain(errors)}");
        }

        return layers;
    }

    private static LayerSpec ReadLayer(Document document, ItemReader parent, JsonElement layer, int position)
    {
        if (layer.ValueKind != JsonValueKind.Object)
        {
            throw parent.Refuse($"layers[{position}] must be an object with thicknessMm, materialId and function, not {layer.GetRawText()}.");
        }

        var reader = new ItemReader(layer, $"{parent.Where} layers[{position}]");
        var thicknessMm = reader.Number("thicknessMm");
        var function = reader.Text("function");

        if (!Functions.TryGetValue(function, out var assignment))
        {
            throw reader.Refuse($"function must be one of {string.Join(", ", Functions.Keys)}, not '{function}'.");
        }

        if (assignment == MaterialFunctionAssignment.Membrane ? thicknessMm != 0 : thicknessMm <= 0)
        {
            throw reader.Refuse(
                assignment == MaterialFunctionAssignment.Membrane
                    ? $"a membrane has no thickness, so thicknessMm must be 0, not {thicknessMm}."
                    : $"thicknessMm must be above zero for a layer that is not a membrane, not {thicknessMm}.");
        }

        return new LayerSpec(Units.MmToInternal(thicknessMm), assignment, reader.Material(document, "materialId").Id);
    }

    private static string Explain(IDictionary<int, CompoundStructureError> errors) =>
        string.Join(
            " ",
            errors.OrderBy(entry => entry.Key).Select(entry => entry.Key < 0
                ? $"The structure as a whole: {entry.Value}."
                : $"Layer {entry.Key}: {Reason(entry.Value)}"));

    private static string Reason(CompoundStructureError error) => error switch
    {
        CompoundStructureError.NonmembraneTooThin or CompoundStructureError.ThinOuterLayer =>
            $"it is too thin, as a layer must be at least {Units.InternalToMm(CompoundStructure.GetMinimumLayerThickness()):0.###} mm unless it is a membrane.",
        CompoundStructureError.MembraneTooThick => "a membrane has no thickness, so thicknessMm must be 0.",
        CompoundStructureError.CoreTooThin => "the core of the structure is empty or holds a membrane.",
        CompoundStructureError.InvalidMaterialId => "materialId is not a material.",
        _ => $"{error}.",
    };

    private static ItemResult ReportExisting(HostObjAttributes type, TypeInput input, int index, JsonElement requested)
    {
        var warnings = new List<string>();

        if (type.FamilyName != input.Base.FamilyName)
        {
            warnings.Add($"Type '{type.Name}' belongs to the family '{type.FamilyName}', and the base type to '{input.Base.FamilyName}'. It was not changed.");
        }

        var expected = input.Layers?.ConvertAll(layer => layer.ToLayer()) ?? input.Base.GetCompoundStructure()?.GetLayers().ToList();
        var actual = type.GetCompoundStructure()?.GetLayers().ToList();

        warnings.AddRange(Compare(type, expected, actual, input.Layers is not null));

        return new ItemResult(
            index,
            ItemStatus.AlreadyExisted,
            type.Id.ToString(),
            requested,
            JsonSerializer.SerializeToElement(Describe(type), ProjectSupport.Options),
            warnings,
            null);
    }

    private static IEnumerable<string> Compare(HostObjAttributes type, List<CompoundStructureLayer>? expected, List<CompoundStructureLayer>? actual, bool asked)
    {
        var source = asked ? "asked for" : "of the base type";

        if (actual is null)
        {
            yield return $"Type '{type.Name}' has no layers, so the layers {source} are not there. It was not changed.";
            yield break;
        }

        if (expected is null)
        {
            yield return $"Type '{type.Name}' has layers, and the base type has none. It was not changed.";
            yield break;
        }

        if (expected.Count != actual.Count)
        {
            yield return $"Type '{type.Name}' has {actual.Count} layers, not the {expected.Count} {source}. It was not changed.";
            yield break;
        }

        for (var position = 0; position < actual.Count; position++)
        {
            var differences = new List<string>();

            if (Math.Abs(Units.InternalToMm(actual[position].Width - expected[position].Width)) > SameThicknessMm)
            {
                differences.Add($"thickness {Units.InternalToMm(actual[position].Width):0.###} mm, not {Units.InternalToMm(expected[position].Width):0.###} mm");
            }

            if (actual[position].MaterialId != expected[position].MaterialId)
            {
                differences.Add($"material {actual[position].MaterialId}, not {expected[position].MaterialId}");
            }

            if (actual[position].Function != expected[position].Function)
            {
                differences.Add($"function {FunctionWord(actual[position].Function)}, not {FunctionWord(expected[position].Function)}");
            }

            if (differences.Count > 0)
            {
                yield return $"Layer {position} of type '{type.Name}' has {string.Join(", ", differences)} ({source}). It was not changed.";
            }
        }
    }

    private void RefuseRepeatedNames(List<BatchEntry<TypeInput>> entries)
    {
        var repeated = entries.GroupBy(entry => (Class: entry.Input.Base.GetType().Name, Family: entry.Input.Base.FamilyName, entry.Input.Name)).FirstOrDefault(group => group.Count() > 1);

        if (repeated is not null)
        {
            throw new RequestFailedException(
                JsonRpcCodes.InvalidParams,
                $"{Method}: items {string.Join(" and ", repeated.Select(entry => entry.Index))} both name '{repeated.Key.Name}' for a type of the family '{repeated.Key.Family}'. A type name is unique within its family, so keep one.");
        }
    }

    private static object Describe(HostObjAttributes type)
    {
        var structure = type.GetCompoundStructure();

        return new
        {
            category = CategoryMap.KeyOf(type.Category),
            family = type.FamilyName,
            name = type.Name,
            widthMm = structure is null ? (double?)null : Units.InternalToMm(structure.GetWidth()),
            layers = structure?.GetLayers().Select(layer => new
            {
                thicknessMm = Units.InternalToMm(layer.Width),
                materialId = layer.MaterialId == ElementId.InvalidElementId ? null : layer.MaterialId.ToString(),
                function = FunctionWord(layer.Function),
            }).ToList(),
        };
    }

    /// <summary>The word of the contract for a function, or else the name Revit gives it, for a layer that came with a copied type.</summary>
    private static string FunctionWord(MaterialFunctionAssignment function) =>
        Functions.FirstOrDefault(entry => entry.Value == function).Key ?? function.ToString();

    private sealed record LayerSpec(double Width, MaterialFunctionAssignment Function, ElementId MaterialId)
    {
        public CompoundStructureLayer ToLayer() => new(Width, Function, MaterialId);
    }

    private sealed record TypeInput(HostObjAttributes Base, string Name, List<LayerSpec>? Layers);
}
