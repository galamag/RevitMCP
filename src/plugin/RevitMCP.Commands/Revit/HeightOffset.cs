using Autodesk.Revit.DB;

namespace RevitMCP.Commands;

/// <summary>
/// Writes the height offset parameter of a new element and checks that it stayed. Revit gives a new ceiling an offset of
/// its own (2600 mm above the level, live Revit) and a new toposolid 0, so an element that is left alone sits where Revit
/// put it and not where the caller said. This runs inside the batch transaction, so a refusal is an item that fails
/// and nothing lands.
/// </summary>
internal static class HeightOffset
{
    /// <summary>A difference between two heights below this is noise from converting units.</summary>
    private const double SameHeightMm = 0.01;

    /// <param name="offset">The height in Revit's internal units, above the level of the element.</param>
    /// <param name="what">What the element is, for the message of a failure.</param>
    public static void Apply(Document document, Element element, BuiltInParameter parameter, double offset, string what)
    {
        var target = element.get_Parameter(parameter);

        if (target is null || target.IsReadOnly)
        {
            throw new InvalidOperationException($"The new {what} has no height offset that can be written, so it would stay where Revit put it.");
        }

        if (!target.Set(offset))
        {
            throw new InvalidOperationException($"Revit would not take a height offset of {Units.InternalToMm(offset):0.###} mm for the new {what}.");
        }

        // Read after a regeneration, so that the value is the one the element is built with.
        document.Regenerate();
        var real = element.get_Parameter(parameter).AsDouble();

        if (Math.Abs(Units.InternalToMm(real - offset)) > SameHeightMm)
        {
            throw new InvalidOperationException(
                $"The new {what} has a height offset of {Units.InternalToMm(real):0.###} mm after Revit built it, not the {Units.InternalToMm(offset):0.###} mm asked for.");
        }
    }
}
