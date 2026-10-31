using System.Text.Json;
using Autodesk.Revit.DB;
using RevitMCP.Bridge;
using RevitMCP.Commands.Dispatch;

namespace RevitMCP.Commands;

/// <summary>
/// Attaches the tops of walls to roofs as one transaction. No element is created, so the item's element is the wall:
/// <see cref="ItemStatus.Created"/> means a new attachment, and <see cref="ItemStatus.AlreadyExisted"/> one that was there.
/// </summary>
public sealed class AttachWallsCommand : ICommand
{
    public string Method => MethodNames.AttachWalls;

    public bool NeedsDocument => true;

    public JsonElement Execute(CommandContext context, JsonElement parameters)
    {
        var document = context.Document!;
        var entries = ItemBatch.ReadItems(parameters, Method)
            .Select((item, index) => ReadAttachment(document, item, index))
            .ToList();

        RefuseRepeatedPairs(entries);

        return ItemBatch.Run(document, Method, entries, Attach, element => Describe((Wall)element));
    }

    private static Wall Attach(AttachInput input)
    {
        input.Wall.AddAttachment(input.RoofId, AttachmentLocation.Top);

        return input.Wall;
    }

    private BatchEntry<AttachInput> ReadAttachment(Document document, JsonElement item, int index)
    {
        var reader = new ItemReader(item, $"{Method} item {index}");
        var wall = reader.Instance<Wall>(document, "wallId", "walls");
        var roof = reader.Instance<RoofBase>(document, "roofId", "roofs");
        var settled = wall.GetAttachmentIds(AttachmentLocation.Top).Contains(roof.Id) ? ReportExisting(wall, index, item) : null;

        return new BatchEntry<AttachInput>(index, item, new AttachInput(wall, roof.Id), settled);
    }

    private static ItemResult ReportExisting(Wall wall, int index, JsonElement requested) =>
        new(
            index,
            ItemStatus.AlreadyExisted,
            wall.Id.ToString(),
            requested,
            JsonSerializer.SerializeToElement(Describe(wall), ProjectSupport.Options),
            [],
            null);

    private void RefuseRepeatedPairs(List<BatchEntry<AttachInput>> entries)
    {
        var repeated = entries.GroupBy(entry => (entry.Input.Wall.Id, entry.Input.RoofId)).FirstOrDefault(group => group.Count() > 1);

        if (repeated is not null)
        {
            throw new RequestFailedException(
                JsonRpcCodes.InvalidParams,
                $"{Method}: items {string.Join(" and ", repeated.Select(entry => entry.Index))} both attach wall {repeated.Key.Item1} to roof {repeated.Key.Item2}, so keep one.");
        }
    }

    /// <summary>
    /// The top is read from the solids of the wall. Live Revit: a box follows a wall up to a roof, but both
    /// <see cref="Element.get_BoundingBox"/> and <see cref="GeometryElement.GetBoundingBox"/> keep the old height of a
    /// wall cut down to one, while a snapshot shows nothing above the roof.
    /// </summary>
    private static object Describe(Wall wall)
    {
        var top = wall.get_Geometry(new Options())?
            .OfType<Solid>()
            .SelectMany(solid => solid.Edges.Cast<Edge>())
            .SelectMany(edge => edge.Tessellate())
            .Select(point => (double?)point.Z)
            .Max();

        return new
        {
            attachedToIds = wall.GetAttachmentIds(AttachmentLocation.Top).Select(id => id.ToString()).ToList(),
            topMm = top is { } height ? Units.InternalToMm(height) : (double?)null,
        };
    }

    private sealed record AttachInput(Wall Wall, ElementId RoofId);
}
