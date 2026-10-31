using Autodesk.Revit.DB;

namespace RevitMCP.Commands;

/// <summary>
/// The JSON shapes that describe where an element is, in millimetres, so every command answers in the same form.
/// The values are anonymous objects for <c>JsonSerializer</c>, with the keys in lower case.
/// </summary>
internal static class ElementJson
{
    /// <summary>A model point as <c>{ x, y, z }</c> in millimetres.</summary>
    public static object PointMm(XYZ point) => new
    {
        x = Units.InternalToMm(point.X),
        y = Units.InternalToMm(point.Y),
        z = Units.InternalToMm(point.Z),
    };

    /// <summary>A bounding box as <c>{ min, max }</c> of points, or <c>null</c> when Revit knows no box.</summary>
    public static object? BoxMm(BoundingBoxXYZ? box) =>
        box is null ? null : new { min = PointMm(box.Min), max = PointMm(box.Max) };
}
