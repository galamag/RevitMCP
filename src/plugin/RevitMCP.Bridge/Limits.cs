namespace RevitMCP.Bridge;

/// <summary>Protocol-wide limits shared by the plugin and its tests.</summary>
public static class Limits
{
    /// <summary>Maximum JSON payload size of a single frame, in bytes.</summary>
    public const int MaxFrameBytes = 16 * 1024 * 1024;

    /// <summary>How long a request may wait in the queue before it is cancelled as expired.</summary>
    public static readonly TimeSpan QueueTtl = TimeSpan.FromSeconds(120);

    /// <summary>How often the server sweeps the queue for requests past <see cref="QueueTtl"/>.</summary>
    public static readonly TimeSpan ExpirySweepInterval = TimeSpan.FromSeconds(1);

    /// <summary>How many requests, and so how many results, the request store keeps.</summary>
    public const int ResultCapacity = 256;

    /// <summary>
    /// How many connections the server holds at once. The token sits inside the frame, so reading a frame
    /// costs up to <see cref="MaxFrameBytes"/> before the sender is known; this cap bounds that memory.
    /// </summary>
    public const int MaxConnections = 4;
}
