using System.Runtime.CompilerServices;
using Autodesk.Revit.UI;
using RevitMCP.Commands;

namespace RevitMCP.Plugin;

/// <summary>
/// Revit's entry point, and nothing else: it hands both calls to <see cref="PluginHost"/> in RevitMCP.Commands.
/// Revit asks the user to trust an unsigned add-in whenever this DLL changes, so keep it minimal and free of
/// anything that varies between builds. It does not use <c>Log</c> either: if RevitMCP.Commands.dll is missing,
/// the failure must still reach the catch here.
/// </summary>
public sealed class App : IExternalApplication
{
    public Result OnStartup(UIControlledApplication application)
    {
        try
        {
            Start(application);
        }
        catch (Exception e)
        {
            Report("OnStartup failed, so the bridge stays off.", e);
        }

        return Result.Succeeded;
    }

    public Result OnShutdown(UIControlledApplication application)
    {
        try
        {
            Stop(application);
        }
        catch (Exception e)
        {
            Report("OnShutdown failed.", e);
        }

        return Result.Succeeded;
    }

    /// <summary>
    /// The only places that name <see cref="PluginHost"/>. The runtime loads RevitMCP.Commands.dll when it compiles
    /// a method that uses it, so these stay separate from the methods with the try blocks above, and are never inlined into them.
    /// </summary>
    [MethodImpl(MethodImplOptions.NoInlining)]
    private static void Start(UIControlledApplication application) => PluginHost.Start(application);

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static void Stop(UIControlledApplication application) => PluginHost.Stop(application);

    /// <summary>Appends to the same file as <c>Log</c>. Never throws, because it runs inside Revit.</summary>
    private static void Report(string message, Exception exception)
    {
        try
        {
            var path = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "RevitMCP",
                "plugin.log");
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            File.AppendAllText(
                path,
                $"{DateTimeOffset.Now:O} [{Environment.ProcessId}] ERROR {message}{Environment.NewLine}{exception}{Environment.NewLine}");
        }
        catch (Exception)
        {
            // Nothing is worth failing Revit's startup for.
        }
    }
}
