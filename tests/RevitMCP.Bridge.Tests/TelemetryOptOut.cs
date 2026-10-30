using System.Runtime.CompilerServices;

namespace RevitMCP.Bridge.Tests;

internal static class TelemetryOptOut
{
    // CA2255 (module initializers in libraries) does not apply: this is a test executable, and the variable
    // must be set before the Microsoft.Testing.Platform host starts, so that no telemetry leaves the machine.
#pragma warning disable CA2255
    [ModuleInitializer]
    internal static void Init() =>
        Environment.SetEnvironmentVariable("TESTINGPLATFORM_TELEMETRY_OPTOUT", "1");
#pragma warning restore CA2255
}
