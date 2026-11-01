using RevitMCP.Bridge;

namespace RevitMCP.Commands.Dispatch;

/// <summary>
/// The commands by method name. Must match <see cref="MethodNames.All"/> minus <see cref="MethodNames.Immediate"/>,
/// which the socket threads answer themselves, or construction throws and the bridge stays off.
/// </summary>
public sealed class CommandRegistry
{
    private readonly Dictionary<string, ICommand> _byMethod;

    public CommandRegistry(IEnumerable<ICommand> commands)
    {
        ArgumentNullException.ThrowIfNull(commands);

        _byMethod = commands.ToDictionary(command => command.Method, StringComparer.Ordinal);

        var expected = MethodNames.All.Except(MethodNames.Immediate, StringComparer.Ordinal).ToList();
        var missing = expected.Except(_byMethod.Keys, StringComparer.Ordinal).ToList();
        var unexpected = _byMethod.Keys.Except(expected, StringComparer.Ordinal).ToList();
        if (missing.Count > 0 || unexpected.Count > 0)
        {
            throw new InvalidOperationException(
                "The commands do not match MethodNames. "
                + $"Without a command: [{string.Join(", ", missing)}]. Not a queued method: [{string.Join(", ", unexpected)}].");
        }
    }

    /// <summary>Builds the registry of every command the plugin ships. The undo commands read <paramref name="undoTracker"/>.</summary>
    public static CommandRegistry CreateDefault(UndoTracker undoTracker) => new(
    [
        new GetModelInfoCommand(),
        new CreateProjectCommand(),
        new OpenProjectCommand(),
        new SaveProjectCommand(),
        new ListTypesCommand(),
        new ListMaterialsCommand(),
        new GetElementsCommand(),
        new GetWarningsCommand(),
        new Create3dViewCommand(),
        new GetViewSnapshotCommand(),
        new CreateMaterialsCommand(),
        new CreateTypeCommand(),
        new CreateLevelsCommand(),
        new CreateWallsCommand(),
        new CreateFloorsCommand(),
        new CreateRoofCommand(),
        new CreateCeilingsCommand(),
        new CreateFloorOpeningsCommand(),
        new CreateGroundCommand(),
        new LoadFamilyCommand(),
        new PlaceInstancesCommand(),
        new PlaceHostedCommand(),
        new AttachWallsCommand(),
        new DeleteElementsCommand(),
        new UndoLastOperationCommand(undoTracker),
        new GetLastUndoResultCommand(undoTracker),
    ]);

    /// <summary>Returns the command for this method, or <c>null</c>.</summary>
    public ICommand? Find(string method) => _byMethod.GetValueOrDefault(method);
}
