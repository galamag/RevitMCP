namespace RevitMCP.Bridge;

/// <summary>
/// Thrown when a frame length exceeds <see cref="Limits.MaxFrameBytes"/>. On the read side this also
/// covers a peer that is not speaking the framing protocol at all, for example an HTTP client.
/// </summary>
public sealed class FrameTooLargeException(long length)
    : Exception($"Frame length {length} exceeds the limit of {Limits.MaxFrameBytes} bytes.")
{
    /// <summary>The offending frame length, in bytes.</summary>
    public long Length { get; } = length;
}
