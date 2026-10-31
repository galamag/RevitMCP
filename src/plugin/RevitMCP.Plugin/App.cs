using System.Diagnostics;
using System.Security.Cryptography;
using Autodesk.Revit.UI;
using RevitMCP.Bridge;
using RevitMCP.Plugin.Dispatch;

namespace RevitMCP.Plugin;

/// <summary>
/// Revit's entry point: hosts the bridge for the length of the session. A failure here must not cost the user
/// their Revit, so nothing is thrown at Revit: the reason goes to the log and the bridge stays off.
/// </summary>
public sealed class App : IExternalApplication
{
    private const int TokenBytes = 32;

    private static readonly TimeSpan StopTimeout = TimeSpan.FromSeconds(5);

    private static readonly TimeSpan DrainInterval = TimeSpan.FromSeconds(1);

    private static readonly string ConnectionPath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "RevitMCP",
        "connection.json");

    private BridgeServer? _server;
    private Timer? _drainTimer;

    public Result OnStartup(UIControlledApplication application)
    {
        try
        {
            StartBridge();
        }
        catch (Exception e)
        {
            Log.Error("The bridge stays off: its startup failed.", e);
            TearDown();
        }

        return Result.Succeeded;
    }

    public Result OnShutdown(UIControlledApplication application)
    {
        TearDown();
        return Result.Succeeded;
    }

    /// <summary>
    /// The bridge types stay out of this method and of the two above, so that even a missing
    /// <c>RevitMCP.Bridge.dll</c> surfaces inside a try: the runtime resolves them when it compiles a method.
    /// </summary>
    private void TearDown()
    {
        _drainTimer?.Dispose();

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
            DeleteConnectionFile();
        }
        catch (Exception e)
        {
            Log.Error("Could not delete the connection file.", e);
        }
    }

    private void StartBridge()
    {
        var commands = CommandRegistry.CreateDefault();
        if (!MayClaimConnectionFile())
        {
            return;
        }

        var token = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(TokenBytes));
        var clock = TimeProvider.System;
        var queue = new RequestQueue(clock);
        var handler = new CommandHandler(queue, commands);
        var signal = new ExternalEventSignal(ExternalEvent.Create(handler));
        handler.Signal = signal;

        _server = new BridgeServer(token, queue, new RequestStore(Limits.ResultCapacity), signal, clock);
        var port = _server.StartAsync().GetAwaiter().GetResult();
        ConnectionFile.Write(ConnectionPath, new ConnectionInfo(port, token, Environment.ProcessId, BridgeServer.ProtocolVersion));

        // The fallback for signals Revit left unserved or refused. It runs off the main thread, see SignalIfQueued.
        _drainTimer = new Timer(_ => handler.SignalIfQueued(), null, DrainInterval, DrainInterval);

        Log.Info($"The bridge listens on 127.0.0.1:{port}, protocol version {BridgeServer.ProtocolVersion}.");
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

    private void StopBridge()
    {
        if (_server?.StopAsync().Wait(StopTimeout) == false)
        {
            Log.Error($"The bridge did not stop within {StopTimeout.TotalSeconds:0} s.");
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
