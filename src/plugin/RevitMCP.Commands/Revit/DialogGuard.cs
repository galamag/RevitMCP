using Autodesk.Revit.UI;
using Autodesk.Revit.UI.Events;

namespace RevitMCP.Commands;

/// <summary>A dialog the guard closed. <see cref="Message"/> is empty for a dialog box, which exposes no text.</summary>
public sealed record DialogRecord(string DialogId, string Message);

/// <summary>
/// Closes the dialogs Revit raises while a command runs, because nobody may be there to answer them and one left open
/// blocks the main thread. Subscribed once at startup, it acts only between <see cref="Activate"/> and the disposal
/// of its result, so a dialog the user opened outside a command stays theirs. Everything here runs on the main thread.
/// </summary>
public sealed class DialogGuard
{
    /// <summary>
    /// Tried in order until Revit accepts one, since a dialog takes only the buttons it has. A refusal comes first,
    /// as nobody agreed to what the dialog asks. The last two only acknowledge a dialog that offers no choice.
    /// </summary>
    private static readonly TaskDialogResult[] Answers =
    [
        TaskDialogResult.Cancel,
        TaskDialogResult.No,
        TaskDialogResult.Ok,
        TaskDialogResult.Close,
    ];

    private readonly List<DialogRecord> _recorded = [];

    /// <summary>The guard of the running command, if any. <see cref="Operation.Run"/> reads its dialogs from here.</summary>
    internal static DialogGuard? Active { get; private set; }

    /// <summary>Starts closing dialogs. Disposing the result stops it and drops what nobody took.</summary>
    public IDisposable Activate()
    {
        Active = this;
        return new Activation(this);
    }

    /// <summary>Returns the dialogs closed since the last call and forgets them.</summary>
    public IReadOnlyList<DialogRecord> TakeRecorded()
    {
        var taken = _recorded.ToList();
        _recorded.Clear();
        return taken;
    }

    /// <summary>The handler for <c>DialogBoxShowing</c>. No exception leaves it, because it runs inside Revit.</summary>
    public void OnDialogBoxShowing(object? sender, DialogBoxShowingEventArgs args)
    {
        if (Active != this)
        {
            return;
        }

        try
        {
            ArgumentNullException.ThrowIfNull(args);

            var message = args switch
            {
                TaskDialogShowingEventArgs task => task.Message,
                MessageBoxShowingEventArgs box => box.Message,
                _ => string.Empty,
            };
            _recorded.Add(new DialogRecord(args.DialogId, message));

            if (Answers.Any(answer => args.OverrideResult((int)answer)))
            {
                Log.Info($"Closed a dialog during a command: '{Log.Clean(args.DialogId)}', '{Log.Clean(message)}'.");
            }
            else
            {
                Log.Error($"No answer closes this dialog, so it stays open: '{Log.Clean(args.DialogId)}', '{Log.Clean(message)}'.");
            }
        }
        catch (Exception e)
        {
            Log.Error("The dialog guard failed.", e);
        }
    }

    private sealed class Activation(DialogGuard guard) : IDisposable
    {
        public void Dispose()
        {
            guard._recorded.Clear();
            Active = null;
        }
    }
}
