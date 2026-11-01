using Autodesk.Revit.DB;

namespace RevitMCP.Commands;

/// <summary>
/// Reads a door or window that stands in the model, the one way for <c>place_hosted</c>, which only ever sees walls, and for <c>get_elements</c>, which reads
/// any model. It only reads, so it opens no transaction, and a member that a host or a family does not have gives <c>null</c> and not an exception: one skylight
/// in a roof must not fail a read of the whole model.
/// </summary>
internal static class OpeningReader
{
    /// <summary>Whether an instance is a door or a window. Furniture and plumbing are instances of a family too, and they are not.</summary>
    public static bool IsOpening(FamilyInstance instance) =>
        instance.Category?.BuiltInCategory is BuiltInCategory.OST_Doors or BuiltInCategory.OST_Windows;

    /// <summary>What can be read of a door or window, by key, in the order the tools answer it. The rooms are read now, so they follow what the model holds at this call.</summary>
    public static Dictionary<string, object?> Describe(FamilyInstance instance)
    {
        var (widthMm, heightMm, _) = instance.Symbol is { } symbol ? FamilySizes.OpeningMm(symbol) : default;

        return new Dictionary<string, object?>
        {
            ["hostId"] = instance.Host?.Id.ToString(),
            ["offsetAlongWallMm"] = OffsetAlongWallMm(instance),
            ["sillHeightMm"] = SillMm(instance),
            ["widthMm"] = widthMm,
            ["heightMm"] = heightMm,
            ["facingFlipped"] = instance.FacingFlipped,
            ["handFlipped"] = instance.HandFlipped,
            ["fromRoomId"] = instance.FromRoom?.Id.ToString(),
            ["toRoomId"] = instance.ToRoom?.Id.ToString(),
            ["cutsWall"] = instance.Host is Wall wall && CutsWall(wall, instance.Id),
        };
    }

    /// <summary>The sill height of an instance in millimetres, above its level, or <c>null</c> when it has none.</summary>
    public static double? SillMm(FamilyInstance instance) =>
        instance.get_Parameter(BuiltInParameter.INSTANCE_SILL_HEIGHT_PARAM) is { StorageType: StorageType.Double } parameter ? Units.InternalToMm(parameter.AsDouble()) : null;

    public static bool CutsWall(Wall wall, ElementId instanceId) => wall.FindInserts(false, false, false, false).Contains(instanceId);

    /// <summary>
    /// The distance in millimetres from the start of the axis of the wall to the point of the instance, the centre of the opening, or <c>null</c> when that is not
    /// a question for it: a host that is no straight wall, or a family that does not sit in a wall. It is measured on the axis and not read from
    /// <see cref="FamilyInstance.HostParameter"/>, for two reasons. RevitAPI.xml has that member throw for a host that is no wall and for a work-plane-based family.
    /// And live Revit counts it from where the wall started when it was drawn: a wall whose start was moved 1000 mm out by the wall it joins read 0 where the
    /// opening stood 1000 mm from the new start. Live Revit: a door or window that is a panel of a curtain wall reads <c>null</c> here.
    /// </summary>
    private static double? OffsetAlongWallMm(FamilyInstance instance)
    {
        if (instance.Host is not Wall { Location: LocationCurve { Curve: Line axis } }
            || instance.Location is not LocationPoint location
            || instance.Symbol?.Family.FamilyPlacementType != FamilyPlacementType.OneLevelBasedHosted)
        {
            return null;
        }

        return Units.InternalToMm((location.Point - axis.GetEndPoint(0)).DotProduct(axis.Direction));
    }
}
