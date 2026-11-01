using Autodesk.Revit.DB;

namespace RevitMCP.Commands;

/// <summary>
/// What can be seen of a family type: every length it holds, by parameter, and the box of its solids. Two shapes of one type, before and
/// after a change, say whether the change moved anything.
/// </summary>
internal sealed record TypeShape(IReadOnlyDictionary<long, double> Lengths, double[]? Box);

/// <summary>Reads the size of a family type, the one way for every command that needs it. It only reads, so it opens no transaction.</summary>
internal static class FamilySizes
{
    /// <summary>Two lengths closer than this, in feet, are the same: the noise of floating point, a third of a micron.</summary>
    private const double SameLength = 1e-9;

    /// <summary>The same for the box of a type, in feet. Tessellation of the same shape is exact to far less than this.</summary>
    private const double SameBox = 1e-6;

    /// <summary>A size parameter of a type in millimetres, or <c>null</c> when the type has none that Revit names as such.</summary>
    public static double? ParameterMm(FamilySymbol symbol, BuiltInParameter which) =>
        symbol.get_Parameter(which) is { StorageType: StorageType.Double } parameter ? Units.InternalToMm(parameter.AsDouble()) : null;

    /// <summary>
    /// The width and the height of the opening a door or window type cuts, in millimetres, each <c>null</c> when the type says none above zero.
    /// Live Revit: a type that is a bare opening (<c>Дверь-Проем</c>, <c>Окно-Квадратный проем</c>) reads a Width and a Height of 0 and keeps
    /// its size in the Rough Width and the Rough Height; a value written into its Width changes nothing, and the opening is cut at the rough size.
    /// So a size above zero in Width and Height is the size, and one that reads 0 falls back on the rough size.
    /// </summary>
    public static (double? WidthMm, double? HeightMm, bool FromRough) OpeningMm(FamilySymbol symbol)
    {
        var (widthMm, widthRough) = Pick(symbol, BuiltInParameter.FAMILY_WIDTH_PARAM, BuiltInParameter.FAMILY_ROUGH_WIDTH_PARAM);
        var (heightMm, heightRough) = Pick(symbol, BuiltInParameter.FAMILY_HEIGHT_PARAM, BuiltInParameter.FAMILY_ROUGH_HEIGHT_PARAM);

        return (widthMm, heightMm, widthRough || heightRough);
    }

    private static (double? Mm, bool Rough) Pick(FamilySymbol symbol, BuiltInParameter size, BuiltInParameter rough) =>
        ParameterMm(symbol, size) is > 0 and { } held
            ? (held, false)
            : ParameterMm(symbol, rough) is > 0 and { } roughMm
                ? (roughMm, true)
                : (null, false);

    /// <summary>What a type looks like now. The geometry of a type that is not active is empty, so a caller that compares shapes activates it first.</summary>
    public static TypeShape ShapeOf(FamilySymbol symbol)
    {
        var lengths = new Dictionary<long, double>();

        foreach (Parameter parameter in symbol.Parameters)
        {
            if (parameter.StorageType == StorageType.Double && parameter.HasValue)
            {
                lengths[parameter.Id.Value] = parameter.AsDouble();
            }
        }

        double[]? box = null;

        if (symbol.get_Geometry(new Options { DetailLevel = ViewDetailLevel.Fine }) is { } geometry)
        {
            Grow(geometry, ref box);
        }

        return new TypeShape(lengths, box);
    }

    /// <summary>Whether anything moved between two shapes of one type, leaving out the parameters in <paramref name="written"/>, which the caller changed itself.</summary>
    public static bool Moved(TypeShape before, TypeShape after, IReadOnlySet<long> written)
    {
        foreach (var (id, value) in after.Lengths)
        {
            if (!written.Contains(id) && (!before.Lengths.TryGetValue(id, out var was) || Math.Abs(was - value) > SameLength))
            {
                return true;
            }
        }

        if (before.Box is null || after.Box is null)
        {
            return before.Box is not null || after.Box is not null;
        }

        return before.Box.Zip(after.Box).Any(pair => Math.Abs(pair.First - pair.Second) > SameBox);
    }

    /// <summary>Grows <paramref name="box"/> (min x, y, z, then max x, y, z) over the solids of a geometry, whether they stand in it or in an instance of a symbol.</summary>
    private static void Grow(GeometryElement geometry, ref double[]? box)
    {
        foreach (var item in geometry)
        {
            if (item is Solid { Faces.Size: > 0 } solid)
            {
                foreach (Edge edge in solid.Edges)
                {
                    foreach (var point in edge.Tessellate())
                    {
                        box ??= [point.X, point.Y, point.Z, point.X, point.Y, point.Z];
                        box[0] = Math.Min(box[0], point.X);
                        box[1] = Math.Min(box[1], point.Y);
                        box[2] = Math.Min(box[2], point.Z);
                        box[3] = Math.Max(box[3], point.X);
                        box[4] = Math.Max(box[4], point.Y);
                        box[5] = Math.Max(box[5], point.Z);
                    }
                }
            }
            else if (item is GeometryInstance instance)
            {
                Grow(instance.GetSymbolGeometry(), ref box);
            }
        }
    }
}
