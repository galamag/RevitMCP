using Autodesk.Revit.DB;

namespace RevitMCP.Commands;

/// <summary>Reads the shape of a wall. It only reads, so it opens no transaction.</summary>
internal static class WallGeometry
{
    /// <summary>
    /// The highest point of the real shape of <paramref name="wall"/>, in millimetres in model coordinates, or <c>null</c>
    /// when the wall has no solid. The top is read from the solids of the wall. Live Revit: a box follows a wall up to a
    /// roof, but both <see cref="Element.get_BoundingBox"/> and <see cref="GeometryElement.GetBoundingBox"/> keep the old
    /// height of a wall cut down to one, while a snapshot shows nothing above the roof.
    /// </summary>
    public static double? TopMm(Wall wall)
    {
        var top = wall.get_Geometry(new Options())?
            .OfType<Solid>()
            .SelectMany(solid => solid.Edges.Cast<Edge>())
            .SelectMany(edge => edge.Tessellate())
            .Select(point => (double?)point.Z)
            .Max();

        return top is { } height ? Units.InternalToMm(height) : null;
    }

    /// <summary>
    /// The top of the wall where each of <paramref name="points"/> stands, in millimetres in model coordinates: the highest height at
    /// which the solids of the wall meet the vertical line through the point. An entry is <c>null</c> where the line meets no solid, as
    /// it does inside a cut that reaches the top of the wall. <see cref="TopMm"/> is the highest point of the whole wall, and a wall that
    /// follows a roof has a top that is lower than that at all but one place, so a window is judged by the top where it stands.
    /// </summary>
    public static IReadOnlyList<double?> TopsAtMm(Wall wall, IReadOnlyList<XYZ> points)
    {
        var tops = new double?[points.Count];
        var box = wall.get_BoundingBox(null);

        if (box is null || wall.get_Geometry(new Options()) is not { } geometry)
        {
            return tops;
        }

        // The box may keep the old height of a wall cut down to a roof, which only makes the line longer than the wall.
        var low = box.Min.Z - 1;
        var high = box.Max.Z + 1;
        var solids = geometry.OfType<Solid>().Where(solid => solid.Faces.Size > 0 && solid.Volume > 0).ToList();
        var options = new SolidCurveIntersectionOptions();

        for (var index = 0; index < points.Count; index++)
        {
            var line = Line.CreateBound(new XYZ(points[index].X, points[index].Y, low), new XYZ(points[index].X, points[index].Y, high));

            foreach (var solid in solids)
            {
                SolidCurveIntersection meets;

                try
                {
                    meets = solid.IntersectWithCurve(line, options);
                }
                catch (Autodesk.Revit.Exceptions.ArgumentException)
                {
                    // Documented for a solid that is not a closed volume. It has no top to give.
                    continue;
                }

                for (var segment = 0; segment < meets.SegmentCount; segment++)
                {
                    var curve = meets.GetCurveSegment(segment);
                    var top = Math.Max(curve.GetEndPoint(0).Z, curve.GetEndPoint(1).Z);
                    tops[index] = tops[index] is { } held ? Math.Max(held, top) : top;
                }
            }
        }

        return tops.Select(top => top is { } feet ? Units.InternalToMm(feet) : (double?)null).ToList();
    }
}
