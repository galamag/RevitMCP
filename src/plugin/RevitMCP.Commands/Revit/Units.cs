using System.Globalization;
using Autodesk.Revit.DB;

namespace RevitMCP.Commands;

/// <summary>
/// The only place that converts between the external contract (millimetres, degrees) and Revit's internal units.
/// It sits in the root namespace on purpose: from there and below, <c>Units</c> means this class, and
/// <see cref="Autodesk.Revit.DB.Units"/> does not clash with it, because a using directive is searched last.
/// </summary>
public static class Units
{
    public static double MmToInternal(double millimetres) =>
        UnitUtils.ConvertToInternalUnits(millimetres, UnitTypeId.Millimeters);

    public static double InternalToMm(double value) =>
        UnitUtils.ConvertFromInternalUnits(value, UnitTypeId.Millimeters);

    public static double InternalToSquareMetres(double value) =>
        UnitUtils.ConvertFromInternalUnits(value, UnitTypeId.SquareMeters);

    public static double DegToRad(double degrees) =>
        UnitUtils.Convert(degrees, UnitTypeId.Degrees, UnitTypeId.Radians);

    public static double RadToDeg(double radians) =>
        UnitUtils.Convert(radians, UnitTypeId.Radians, UnitTypeId.Degrees);

    /// <summary>A number, such as a length in millimetres or an angle, as text for a message, with a point for the decimals whatever the culture of the machine.</summary>
    public static string FormatNumber(double millimetres) => millimetres.ToString("0.###", CultureInfo.InvariantCulture);

    public static XYZ PointMm(double x, double y, double z = 0) =>
        new(MmToInternal(x), MmToInternal(y), MmToInternal(z));
}
