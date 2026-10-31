using System.Diagnostics;
using System.Reflection;
using System.Security.Cryptography;
using Autodesk.Revit.UI;
using RevitMCP.Bridge;
using RevitMCP.Commands.Dispatch;

namespace RevitMCP.Commands;

/// <summary>
/// Hosts the bridge for the length of the Revit session. <c>RevitMCP.Plugin.App</c>, the stable entry point,
/// only forwards to <see cref="Start"/> and <see cref="Stop"/>. A failure here must not cost the user their Revit,
/// so nothing is thrown at Revit: the reason goes to the log and the bridge stays off.
/// The signatures of <see cref="Start"/> and <see cref="Stop"/> are frozen: changing one changes the entry DLL,
/// and Revit then asks the user to trust the add-in again.
/// </summary>
public static class PluginHost
{
    private const int TokenBytes = 32;

    private static readonly TimeSpan StopTimeout = TimeSpan.FromSeconds(5);

    private static readonly TimeSpan DrainInterval = TimeSpan.FromSeconds(1);

    private static readonly string ConnectionPath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "RevitMCP",
        "connection.json");

    private static BridgeServer? _server;
    private static Timer? _drainTimer;
    private static DialogGuard? _dialogGuard;

    public static void Start(UIControlledApplication application)
    {
        ArgumentNullException.ThrowIfNull(application);

        try
        {
            StartBridge(application);
        }
        catch (Exception e)
        {
            Log.Error("The bridge stays off: its startup failed.", e);
            TearDown(application);
        }
    }

    public static void Stop(UIControlledApplication application)
    {
        ArgumentNullException.ThrowIfNull(application);

        TearDown(application);
    }

    /// <summary>
    /// The file version of this DLL plus the stamp of the build, so that a rebuild shows in <c>get_status</c>
    /// even when the file version stays put.
    /// </summary>
    internal static string DescribeBuild()
    {
        var assembly = typeof(PluginHost).Assembly;
        var version = assembly.GetCustomAttribute<AssemblyFileVersionAttribute>()?.Version
            ?? assembly.GetName().Version?.ToString()
            ?? "unknown";
        var stamp = assembly.GetCustomAttributes<AssemblyMetadataAttribute>()
            .FirstOrDefault(attribute => attribute.Key == "BuildStamp")?.Value;

        return string.IsNullOrEmpty(stamp) ? version : $"{version}+{stamp}";
    }

    /// <summary>
    /// The bridge types stay out of <see cref="Start"/> and <see cref="Stop"/>, so that even a missing
    /// <c>RevitMCP.Bridge.dll</c> surfaces inside a try: the runtime resolves them when it compiles a method.
    /// </summary>
    private static void TearDown(UIControlledApplication application)
    {
        _drainTimer?.Dispose();
        _drainTimer = null;

        try
        {
            StopBridge();
        }
        catch (Exception e)
        {
            Log.Error("The bridge did not stop cleanly.", e);
        }

        try
        {
            DetachDialogGuard(application);
        }
        catch (Exception e)
        {
            Log.Error("Could not detach the dialog guard.", e);
        }

        try
        {
            DeleteConnectionFile();
        }
        catch (Exception e)
        {
            Log.Error("Could not delete the connection file.", e);
        }
    }

    private static void StartBridge(UIControlledApplication application)
    {
        var commands = CommandRegistry.CreateDefault();
        if (!MayClaimConnectionFile())
        {
            return;
        }

        _dialogGuard = new DialogGuard();
        application.DialogBoxShowing += _dialogGuard.OnDialogBoxShowing;

        var token = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(TokenBytes));
        var clock = TimeProvider.System;
        var queue = new RequestQueue(clock);
        var handler = new CommandHandler(queue, commands, _dialogGuard);
        var signal = new ExternalEventSignal(ExternalEvent.Create(handler));
        handler.Signal = signal;

        _server = new BridgeServer(token, queue, new RequestStore(Limits.ResultCapacity), signal, clock, DescribeBuild());
        var port = _server.StartAsync().GetAwaiter().GetResult();
        ConnectionFile.Write(ConnectionPath, new ConnectionInfo(port, token, Environment.ProcessId, BridgeServer.ProtocolVersion));

        // The fallback for signals Revit left unserved or refused. It runs off the main thread, see SignalIfQueued.
        _drainTimer = new Timer(_ => handler.SignalIfQueued(), null, DrainInterval, DrainInterval);

        Log.Info($"The bridge listens on 127.0.0.1:{port}, protocol version {BridgeServer.ProtocolVersion}, build {DescribeBuild()}.");
    }

    private static bool MayClaimConnectionFile()
    {
        try
        {
            if (ConnectionFile.CanClaim(ConnectionPath, IsRevitRunning))
            {
                return true;
            }

            Log.Info($"The bridge stays off: {ConnectionPath} belongs to another running Revit.");
            return false;
        }
        catch (Exception e)
        {
            Log.Error($"The bridge stays off: could not read {ConnectionPath} to find its owner.", e);
            return false;
        }
    }

    /// <summary>Checks the name as well as the ID: a crash leaves the file behind, and Windows reuses process IDs.</summary>
    private static bool IsRevitRunning(int pid)
    {
        try
        {
            using var process = Process.GetProcessById(pid);
            return string.Equals(process.ProcessName, "Revit", StringComparison.OrdinalIgnoreCase);
        }
        catch (Exception e) when (e is ArgumentException or InvalidOperationException)
        {
            // No such process, or it exited between the two calls.
            return false;
        }
    }

    private static void StopBridge()
    {
        if (_server?.StopAsync().Wait(StopTimeout) == false)
        {
            Log.Error($"The bridge did not stop within {StopTimeout.TotalSeconds:0} s.");
        }
    }

    private static void DetachDialogGuard(UIControlledApplication application)
    {
        if (_dialogGuard is not null)
        {
            application.DialogBoxShowing -= _dialogGuard.OnDialogBoxShowing;
            _dialogGuard = null;
        }
    }

    /// <summary>Leaves the file alone unless it names this process: it may be another Revit's.</summary>
    private static void DeleteConnectionFile()
    {
        // CanClaim is false only for a file whose owner the delegate calls alive, so here, for one naming us.
        if (!ConnectionFile.CanClaim(ConnectionPath, pid => pid == Environment.ProcessId))
        {
            File.Delete(ConnectionPath);
        }
    }
}
