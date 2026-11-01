using System.Text.Json;
using Autodesk.Revit.DB;
using RevitMCP.Bridge;
using RevitMCP.Commands.Dispatch;

namespace RevitMCP.Commands;

/// <summary>
/// Loads families from the library (<see cref="LibraryFolder"/>) as one transaction, the whole family or one named type of it.
/// Live Revit: a load outside a transaction returns false and loads nothing, and the return value does not say whether the
/// family was there before, because a reload of a catalog family returns true and resets its sizes. So a family and a type
/// are looked up in the document by <see cref="Family.Name"/> and the type name before anything is loaded, and what is found is
/// <see cref="ItemStatus.AlreadyExisted"/> with no call to Revit. Nothing already loaded is changed.
/// A type catalog (a <c>.txt</c> beside the <c>.rfa</c>) loads every row with a whole-family load, and the sizes in it are
/// silently ignored by Revit when its columns are named in another language than the interface, so the caller gives the
/// size: <c>widthMm</c> and <c>heightMm</c> are written on the type, and read back from it. A size that cannot be written
/// fails the item after the load, and the batch rolls back, so nothing stays loaded. The element of an item is the family for a
/// whole-family load and the type for a named one. <c>familyId</c> comes from the family Revit gives back, as a catalog brings
/// nested families too.
/// </summary>
public sealed class LoadFamilyCommand : ICommand
{
    /// <summary>The extension of the type catalog that sits beside a family file.</summary>
    private const string CatalogExtension = ".txt";

    /// <summary>Two sizes closer than this are the same one: the noise of converting units.</summary>
    private const double SameSizeMm = 0.01;

    /// <summary>
    /// How family names are compared, everywhere: exactly. Revit keeps family names case-sensitive (live: the file spelled in lower case
    /// made a second family, with the types of the file loaded again), and the name here is the file name as stored on disk, never the
    /// spelling a caller gave, so an exact match is the match Revit makes.
    /// </summary>
    private static readonly StringComparer FamilyNames = StringComparer.Ordinal;

    public string Method => MethodNames.LoadFamily;

    public bool NeedsDocument => true;

    public JsonElement Execute(CommandContext context, JsonElement parameters)
    {
        var document = context.Document!;
        var families = new FilteredElementCollector(document).OfClass(typeof(Family)).Cast<Family>().ToList();
        var entries = ItemBatch.ReadItems(parameters, Method)
            .Select((item, index) => ReadFamily(document, families, item, index))
            .ToList();

        RefuseRepeats(entries);

        // Kept for the read-back, which comes after the commit and gets the element only.
        var loaded = new Dictionary<ElementId, LoadInput>();

        return ItemBatch.Run(
            document,
            Method,
            entries,
            input => Build(document, input, loaded),
            element => Describe(document, element),
            element => loaded.TryGetValue(element.Id, out var input) ? CatalogWarnings(element, input) : []);
    }

    private static Element Build(Document document, LoadInput input, Dictionary<ElementId, LoadInput> loaded)
    {
        Element element;

        if (input.TypeName is { } typeName)
        {
            var held = FindFamily(document, input.FamilyName);
            var heldTypes = held is null ? [] : new HashSet<ElementId>(held.GetFamilySymbolIds());

            if (!document.LoadFamilySymbol(input.FullPath, typeName, out var symbol) || symbol is null)
            {
                // Live Revit: a type of another file with the name of a family that is in the project is not added to it, whether or not
                // the catalog has the row (rows of AISC 15.0 into the family of AISC 14.1), and Revit says nothing of why.
                throw new InvalidOperationException(
                    held is null
                        ? $"Revit loaded nothing for type '{typeName}' of {input.FileName}: it is neither a type stored in the family nor a row of its type catalog. "
                            + "The first column of the .txt beside the .rfa holds the names of the rows."
                        : $"Revit loaded nothing for type '{typeName}' of {input.FileName}. The project holds a family called '{held.Name}' already, and Revit adds a type to it only from the file that family came from. "
                            + "So either typeName is not a type of this file (stored in the family, or a row of its type catalog), or the family came from another library file of the same name, and this tool cannot tell which file a family came from.");
            }

            if (heldTypes.Contains(symbol.Id))
            {
                // The look-up before the transaction is exact, and Revit's may not be. A reload resets the sizes written on the type, and rolling back undoes that.
                throw new InvalidOperationException(
                    $"Revit took typeName '{typeName}' for type '{symbol.Name}', which the project holds already, so loading it again could reset its size. Nothing was loaded. Give the name as it is: '{symbol.Name}'.");
            }

            WriteSizes(document, symbol, input);
            element = symbol;
        }
        else
        {
            if (!document.LoadFamily(input.FullPath, out var family) || family is null)
            {
                throw new InvalidOperationException(
                    $"Revit loaded nothing from {input.FileName} and gave no family. If the family is in the project under another name, list its types with list_types.");
            }

            element = family;
        }

        loaded[element.Id] = input;

        return element;
    }

    /// <summary>
    /// Writes the sizes asked for on the type, regenerates, and reads them back. A size Revit does not hold after that fails the
    /// item: the type is in the document, but not the one that was asked for. A size that Revit holds and that moves nothing else
    /// fails it too. Live Revit: the width and height of a bare opening (<c>Дверь-Проем</c>, <c>Окно-Квадратный проем</c>) take any value
    /// and read it back, while the opening is cut at its rough size as before, so the read-back alone proves nothing. A size drives a type
    /// when, with the type active (its geometry is empty before), the box of its solids or one of its other lengths moves with it:
    /// a door panel and a fixed window move both, a bare opening neither.
    /// </summary>
    private static void WriteSizes(Document document, FamilySymbol symbol, LoadInput input)
    {
        var sizes = AskedSizes(input);

        if (sizes.Count == 0)
        {
            return;
        }

        if (!symbol.IsActive)
        {
            symbol.Activate();
            document.Regenerate();
        }

        var before = FamilySizes.ShapeOf(symbol);
        var written = new HashSet<long>();
        var changes = false;

        foreach (var (which, word, asked) in sizes)
        {
            var parameter = symbol.get_Parameter(which)
                ?? throw new InvalidOperationException(
                    $"Type '{symbol.Name}' of family '{symbol.FamilyName}' has no {word} parameter that Revit names as such, so {word}Mm cannot be set. Leave {word}Mm out.");

            if (parameter.StorageType != StorageType.Double || parameter.IsReadOnly)
            {
                throw new InvalidOperationException(
                    $"The {word} of type '{symbol.Name}' of family '{symbol.FamilyName}' cannot be written: it is read-only, as the family computes it itself, so {word}Mm cannot be set. Nothing was loaded.");
            }

            changes |= Math.Abs(Units.InternalToMm(parameter.AsDouble()) - asked) > SameSizeMm;
            written.Add(parameter.Id.Value);

            if (!parameter.Set(Units.MmToInternal(asked)))
            {
                throw new InvalidOperationException($"Revit refused {Units.FormatNumber(asked)} mm as the {word} of type '{symbol.Name}' of family '{symbol.FamilyName}'.");
            }
        }

        document.Regenerate();

        foreach (var (which, word, asked) in sizes)
        {
            var actual = FamilySizes.ParameterMm(symbol, which);

            if (actual is null || Math.Abs(actual.Value - asked) > SameSizeMm)
            {
                throw new InvalidOperationException(
                    $"Revit took {Units.FormatNumber(asked)} mm as the {word} of type '{symbol.Name}' of family '{symbol.FamilyName}', and the type holds {(actual is null ? "no value" : $"{Units.FormatNumber(actual.Value)} mm")}. Nothing was loaded.");
            }
        }

        // A size the type holds already moves nothing and proves nothing, so only a size that changed is looked at.
        if (changes && !FamilySizes.Moved(before, FamilySizes.ShapeOf(symbol), written))
        {
            throw new InvalidOperationException(
                $"Revit took {string.Join(" and ", sizes.Select(size => $"{size.Word}Mm {Units.FormatNumber(size.Mm)}"))} for type '{symbol.Name}' of family '{symbol.FamilyName}' and reads it back, but nothing else in the type moved: "
                + "its geometry and its other lengths are as they were, so the family does not use its Width and Height and a size written there changes nothing. "
                + "A bare opening is such a family: it keeps its size in its Rough Width and Rough Height, and place_hosted reads it there. Nothing was loaded. Leave widthMm and heightMm out.");
        }
    }

    private BatchEntry<LoadInput> ReadFamily(Document document, List<Family> families, JsonElement item, int index)
    {
        var reader = new ItemReader(item, $"{Method} item {index}");
        var fullPath = ResolvePath(reader);
        var typeName = reader.Has("typeName") ? ReadTypeName(reader) : null;
        var widthMm = reader.Has("widthMm") ? ReadSize(reader, "widthMm") : (double?)null;
        var heightMm = reader.Has("heightMm") ? ReadSize(reader, "heightMm") : (double?)null;

        if (typeName is null && (widthMm is not null || heightMm is not null))
        {
            throw reader.Refuse("widthMm and heightMm are written on one type, so name it in typeName: a row of the type catalog, or a type stored in the family.");
        }

        var input = new LoadInput(
            fullPath,
            Path.GetFileName(fullPath),
            Path.GetFileNameWithoutExtension(fullPath),
            typeName,
            widthMm,
            heightMm,
            File.Exists(Path.ChangeExtension(fullPath, CatalogExtension)));

        var existing = families.FirstOrDefault(family => FamilyNames.Equals(family.Name, input.FamilyName));

        return new BatchEntry<LoadInput>(index, item, input, existing is null ? null : ReportExisting(document, existing, input, index, item));
    }

    /// <summary>
    /// The path inside the library, of a file that exists, with every name as it is on disk: Windows takes a path in lower case or
    /// with 8.3 short names for the same file, and the name of the family follows the file name as stored. What is not a file of the
    /// library is refused here, naming the item.
    /// </summary>
    private static string ResolvePath(ItemReader reader)
    {
        var path = reader.Text("path");
        string fullPath;

        try
        {
            fullPath = LibraryFolder.Resolve(path);
        }
        catch (RequestFailedException e)
        {
            throw reader.Refuse(e.Message);
        }

        return LibraryFolder.FindOnDisk(fullPath)
            ?? throw reader.Refuse($"path '{path}' is not a file of the library: there is no such file in {LibraryFolder.Root}.");
    }

    private static string ReadTypeName(ItemReader reader)
    {
        var typeName = reader.Text("typeName");

        return string.IsNullOrWhiteSpace(typeName)
            ? throw reader.Refuse("typeName must not be empty. Leave it out to load the whole family.")
            : typeName;
    }

    private static double ReadSize(ItemReader reader, string key)
    {
        var size = reader.Number(key);

        return size > 0 ? size : throw reader.Refuse($"{key} must be above zero, not {size}.");
    }

    /// <summary>
    /// What is in the list twice cannot be told apart before the transaction, as nothing of the first is loaded yet when the
    /// second is looked up. So it is refused: a file once, a type of it once, and either the whole family or its types by name.
    /// </summary>
    private void RefuseRepeats(List<BatchEntry<LoadInput>> entries)
    {
        foreach (var family in entries.GroupBy(entry => entry.Input.FamilyName, FamilyNames))
        {
            var items = family.ToList();

            if (items.Select(entry => entry.Input.FullPath).Distinct(StringComparer.OrdinalIgnoreCase).Count() > 1)
            {
                throw new RequestFailedException(
                    JsonRpcCodes.InvalidParams,
                    $"{Method}: items {Join(items)} are different files that are all called '{family.Key}'. Revit keeps one family for a name, so load one of them.");
            }

            var whole = items.Where(entry => entry.Input.TypeName is null).ToList();

            if (whole.Count > 1)
            {
                throw new RequestFailedException(JsonRpcCodes.InvalidParams, $"{Method}: items {Join(whole)} both load the whole family '{family.Key}'. Keep one.");
            }

            if (whole.Count == 1 && items.Count > 1)
            {
                throw new RequestFailedException(
                    JsonRpcCodes.InvalidParams,
                    $"{Method}: item {whole[0].Index} loads the whole family '{family.Key}', which brings all its types, and items {Join(items.Where(entry => entry.Index != whole[0].Index))} name a type of it. Load the whole family, or its types one by one.");
            }

            var repeated = items.GroupBy(entry => entry.Input.TypeName!, StringComparer.Ordinal).FirstOrDefault(group => group.Count() > 1);

            if (repeated is not null)
            {
                throw new RequestFailedException(
                    JsonRpcCodes.InvalidParams,
                    $"{Method}: items {Join(repeated)} both load type '{repeated.Key}' of family '{family.Key}'. A type is loaded once, so keep one.");
            }
        }

        static string Join(IEnumerable<BatchEntry<LoadInput>> entries) => string.Join(" and ", entries.Select(entry => entry.Index));
    }

    /// <summary>
    /// The report on a family or a type that is in the document already, or <c>null</c> for a type that is not, though its family
    /// is: the item loads that type. Nothing is changed, so a size asked for that differs from the one it has is a warning, and so
    /// is a family that came with a catalog and has rows that are not loaded.
    /// </summary>
    private static ItemResult? ReportExisting(Document document, Family family, LoadInput input, int index, JsonElement requested)
    {
        Element element = family;
        var warnings = new List<string>();

        if (input.TypeName is { } typeName)
        {
            var symbol = SymbolsOf(document, family).FirstOrDefault(found => found.Name == typeName);

            if (symbol is null)
            {
                return null;
            }

            element = symbol;
            warnings.AddRange(SizeWarnings(symbol, input));
        }
        else if (input.HasCatalog)
        {
            warnings.Add(
                $"Family '{family.Name}' is in the project with {family.GetFamilySymbolIds().Count} types and was not loaded again. It has a type catalog, and a row of it that is not among those types is not loaded: name it in typeName to load it.");
        }

        return new ItemResult(
            index,
            ItemStatus.AlreadyExisted,
            element.Id.ToString(),
            requested,
            JsonSerializer.SerializeToElement(Describe(document, element), ProjectSupport.Options),
            warnings,
            null);
    }

    private static IEnumerable<string> SizeWarnings(FamilySymbol symbol, LoadInput input)
    {
        foreach (var (which, word, asked) in AskedSizes(input))
        {
            var actual = FamilySizes.ParameterMm(symbol, which);

            if (actual is null)
            {
                yield return $"Type '{symbol.Name}' has no {word} that Revit names as such, so the {Units.FormatNumber(asked)} mm asked for is not there. It was not changed.";
            }
            else if (Math.Abs(actual.Value - asked) > SameSizeMm)
            {
                yield return $"Type '{symbol.Name}' has a {word} of {Units.FormatNumber(actual.Value)} mm, not the {Units.FormatNumber(asked)} mm asked for. It was not changed.";
            }
        }
    }

    /// <summary>The sizes the item asks for, each with the parameter that Revit names as the width or the height of a type.</summary>
    private static List<(BuiltInParameter Parameter, string Word, double Mm)> AskedSizes(LoadInput input)
    {
        var sizes = new List<(BuiltInParameter Parameter, string Word, double Mm)>();

        if (input.WidthMm is { } width)
        {
            sizes.Add((BuiltInParameter.FAMILY_WIDTH_PARAM, "width", width));
        }

        if (input.HeightMm is { } height)
        {
            sizes.Add((BuiltInParameter.FAMILY_HEIGHT_PARAM, "height", height));
        }

        return sizes;
    }

    /// <summary>
    /// For a type or a family that this call loaded: a catalog does not set the sizes of its rows here, so one loaded without
    /// the sizes holds the size of the family itself. That is what the warning says, with the size the type really has.
    /// </summary>
    private static IReadOnlyList<string> CatalogWarnings(Element element, LoadInput input)
    {
        if (!input.HasCatalog || (input.WidthMm is not null && input.HeightMm is not null))
        {
            return [];
        }

        if (element is not FamilySymbol symbol)
        {
            return
            [
                $"Family '{input.FamilyName}' came with a type catalog, and Revit ignores the size columns of a catalog here, so all its types hold the sizes of the family itself and not those of their rows. "
                + "Load a row with typeName, widthMm and heightMm to set a size.",
            ];
        }

        var width = FamilySizes.ParameterMm(symbol, BuiltInParameter.FAMILY_WIDTH_PARAM);
        var height = FamilySizes.ParameterMm(symbol, BuiltInParameter.FAMILY_HEIGHT_PARAM);
        var holds = width is null || height is null
            ? "holds the sizes of the family itself"
            : $"is {Units.FormatNumber(width.Value)} x {Units.FormatNumber(height.Value)} mm, the size of the family itself";

        // Advice that would fail the next call is no advice: the size of a GOST door is computed by the family and cannot be written.
        var advice = CanWrite(symbol, BuiltInParameter.FAMILY_WIDTH_PARAM) && CanWrite(symbol, BuiltInParameter.FAMILY_HEIGHT_PARAM)
            ? " Give widthMm and heightMm to set the size."
            : width is not null && height is not null
                ? " The family computes this size itself, so it cannot be set."
                : string.Empty;

        return
        [
            $"Type '{symbol.Name}' comes from a type catalog, and Revit ignores the size columns of a catalog here, so it {holds} and not the size its name or its row says.{advice}",
        ];
    }

    /// <summary>The family the project holds under <paramref name="familyName"/>, or <c>null</c>.</summary>
    private static Family? FindFamily(Document document, string familyName) =>
        new FilteredElementCollector(document).OfClass(typeof(Family)).Cast<Family>().FirstOrDefault(family => FamilyNames.Equals(family.Name, familyName));

    private static List<FamilySymbol> SymbolsOf(Document document, Family family) =>
        family.GetFamilySymbolIds()
            .Select(document.GetElement)
            .OfType<FamilySymbol>()
            .OrderBy(symbol => symbol.Name, StringComparer.Ordinal)
            .ThenBy(symbol => symbol.Id.Value)
            .ToList();

    /// <summary>Whether the type has this size parameter, it can be written, and it holds a size: one that reads 0 is not used by the family, and a size written there is refused.</summary>
    private static bool CanWrite(FamilySymbol symbol, BuiltInParameter which) =>
        symbol.get_Parameter(which) is { StorageType: StorageType.Double, IsReadOnly: false } parameter && parameter.AsDouble() > 0;

    private static object Describe(Document document, Element element)
    {
        var (family, symbols) = element switch
        {
            FamilySymbol symbol => (symbol.Family, new List<FamilySymbol> { symbol }),
            Family whole => (whole, SymbolsOf(document, whole)),
            _ => throw new InvalidOperationException($"Element {element.Id} is neither a family nor a type of one."),
        };

        return new
        {
            familyId = family.Id.ToString(),
            typeIds = symbols.ConvertAll(symbol => new
            {
                id = symbol.Id.ToString(),
                name = symbol.Name,
                widthMm = FamilySizes.ParameterMm(symbol, BuiltInParameter.FAMILY_WIDTH_PARAM),
                heightMm = FamilySizes.ParameterMm(symbol, BuiltInParameter.FAMILY_HEIGHT_PARAM),
            }),
        };
    }

    private sealed record LoadInput(
        string FullPath,
        string FileName,
        string FamilyName,
        string? TypeName,
        double? WidthMm,
        double? HeightMm,
        bool HasCatalog);
}
