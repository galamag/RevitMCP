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
}
