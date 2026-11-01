using System.Text.Json;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Architecture;
using RevitMCP.Bridge;
using RevitMCP.Commands.Dispatch;

namespace RevitMCP.Commands;

/// <summary>
/// Creates rooms at points as one transaction. Live Revit (probe, step 8): <c>NewRoom</c> never returns null and never throws, and
/// the room it makes always has a <c>Location</c>, the point asked for, so the only sign that a room encloses nothing is an area of 0
/// once the document is regenerated. A point outside any closed contour, on the axis of a wall, on a level without walls, and a
/// second room in a region that has a room already all give that, and Revit adds only a warning. So the area is read after each room,
/// and a room with none fails its item, which rolls the whole batch back. The name and the number go through
/// <see cref="BuiltInParameter.ROOM_NAME"/> and <see cref="BuiltInParameter.ROOM_NUMBER"/>, as <c>Element.Name</c> reads both
/// together (<c>Гостиная 101</c>), and are read back and compared. The upper limit of a room is left to Revit, which puts it on the
/// level of the room with a limit offset of 2438.4 mm. The area does not depend on it: walls of 1000, 2000 and 3000 mm gave the same
/// area (live Revit). A level without a floor plan is no obstacle either, as long as walls stand on it. Revit accepts a number that two
/// rooms share and only warns, <c>Elements have duplicate "Number" values.</c>, which comes back in the warnings of the call.
/// </summary>
public sealed class CreateRoomsCommand : ICommand
{
    public string Method => MethodNames.CreateRooms;

    public bool NeedsDocument => true;

    public JsonElement Execute(CommandContext context, JsonElement parameters)
    {
        var document = context.Document!;
        var entries = ItemBatch.ReadItems(parameters, Method)
            .Select((item, index) => ReadRoom(document, item, index))
            .ToList();

        return ItemBatch.Run(
            document,
            Method,
            entries,
            input => Build(document, input),
            element => Describe((Room)element),
            problemAfterCommit: element => EmptyAfterCommit((Room)element));
    }

    /// <summary>The name of a room as Revit shows it on a plan, without the number that <c>Element.Name</c> adds.</summary>
    internal static string? NameOf(Room room) => room.get_Parameter(BuiltInParameter.ROOM_NAME)?.AsString();

    internal static string? NumberOf(Room room) => room.get_Parameter(BuiltInParameter.ROOM_NUMBER)?.AsString();

    private static Room Build(Document document, RoomInput input)
    {
        var level = (Level)document.GetElement(input.LevelId);
        var room = document.Create.NewRoom(level, new UV(Units.MmToInternal(input.PointMm.X), Units.MmToInternal(input.PointMm.Y)))
            ?? throw new InvalidOperationException($"Revit gave no room at {Format(input.PointMm)} mm on level '{input.LevelName}'.");

        if (room.LevelId != input.LevelId)
        {
            throw new InvalidOperationException($"Revit put the room on level {room.LevelId}, and levelId asked for level {input.LevelId} ('{input.LevelName}').");
        }

        SetText(room, BuiltInParameter.ROOM_NAME, input.Name, "name");

        if (input.Number is { } number)
        {
            SetText(room, BuiltInParameter.ROOM_NUMBER, number, "number");
        }

        document.Regenerate();

        if (!(room.Area > 0))
        {
            throw new InvalidOperationException(
                $"Revit made the room, but it has an area of 0, so it encloses nothing: pointMm {Format(input.PointMm)} mm on level '{input.LevelName}' lies in no closed region. "
                + "Either no closed contour of walls and room separators surrounds the point (a missing wall, a gap between walls, a point on the axis of a wall, "
                + "or a level that has no walls all leave it open), or a room stands in that region already, as Revit allows one room to a region: divide the region with create_room_separators first.");
        }

        return room;
    }

    /// <summary>Writes a text parameter of the room and reads it back, as a value Revit refused or changed is not what was asked for.</summary>
    private static void SetText(Room room, BuiltInParameter which, string value, string what)
    {
        var parameter = room.get_Parameter(which)
            ?? throw new InvalidOperationException($"The room has no {what} parameter, so the {what} cannot be set.");

        if (parameter.IsReadOnly || !parameter.Set(value))
        {
            throw new InvalidOperationException($"Revit refused '{value}' as the {what} of the room.");
        }

        if (parameter.AsString() != value)
        {
            throw new InvalidOperationException($"Revit holds '{parameter.AsString()}' as the {what} of the room and not the '{value}' asked for.");
        }
    }

    private BatchEntry<RoomInput> ReadRoom(Document document, JsonElement item, int index)
    {
        var reader = new ItemReader(item, $"{Method} item {index}");
        var level = reader.Level(document, "levelId");
        var point = reader.Point("pointMm");
        var name = reader.Text("name");

        if (string.IsNullOrWhiteSpace(name))
        {
            throw reader.Refuse("name must not be empty or only spaces.");
        }

        string? number = null;

        if (reader.Has("number"))
        {
            number = reader.Text("number");

            if (string.IsNullOrWhiteSpace(number))
            {
                throw reader.Refuse("number must not be empty or only spaces. Leave it out and Revit numbers the room itself.");
            }
        }

        return new BatchEntry<RoomInput>(index, item, new RoomInput(level.Id, level.Name, point, name, number));
    }

    private static object Describe(Room room) => new
    {
        name = NameOf(room),
        number = NumberOf(room),
        areaM2 = Units.InternalToSquareMetres(room.Area),
        perimeterMm = Units.InternalToMm(room.Perimeter),
    };

    /// <summary>
    /// The room had an area when the transaction was about to end. Revit works on it once more when it commits, so a room whose area is gone then
    /// is not a room that landed: <see cref="ItemBatch"/> fails the item, and it names the room, which stays in the model with an area of 0.
    /// Nothing is known to leave a room like that, but the check stays: a created room with an area of 0 must never be reported.
    /// </summary>
    private static string? EmptyAfterCommit(Room room) =>
        room.Area > 0
            ? null
            : "The room has an area of 0 after the commit, though it had one inside the transaction, so it encloses nothing now.";

    private static string Format(PlanPointMm point) => $"({Units.FormatNumber(point.X)}, {Units.FormatNumber(point.Y)})";

    private sealed record RoomInput(ElementId LevelId, string LevelName, PlanPointMm PointMm, string Name, string? Number);
}
