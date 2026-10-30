namespace RevitMCP.Bridge;

/// <summary>Protocol-wide limits shared by the plugin and its tests.</summary>
public static class Limits
{
    /// <summary>Maximum JSON payload size of a single frame, in bytes.</summary>
    public const int MaxFrameBytes = 16 * 1024 * 1024;
}
