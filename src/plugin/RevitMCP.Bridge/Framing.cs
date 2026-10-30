using System.Buffers.Binary;

namespace RevitMCP.Bridge;

/// <summary>
/// Length-prefixed message framing: a 4-byte big-endian payload length followed by the payload bytes.
/// </summary>
public static class Framing
{
    private const int HeaderBytes = 4;

    /// <summary>Writes one frame and flushes the stream.</summary>
    /// <exception cref="FrameTooLargeException">The payload is larger than <see cref="Limits.MaxFrameBytes"/>.</exception>
    public static async Task WriteAsync(Stream stream, byte[] payload, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(stream);
        ArgumentNullException.ThrowIfNull(payload);

        if (payload.Length > Limits.MaxFrameBytes)
        {
            throw new FrameTooLargeException(payload.Length);
        }

        // Header and payload go out in a single write so a socket does not send them as separate segments.
        var frame = new byte[HeaderBytes + payload.Length];
        BinaryPrimitives.WriteUInt32BigEndian(frame, (uint)payload.Length);
        payload.CopyTo(frame, HeaderBytes);

        await stream.WriteAsync(frame, cancellationToken).ConfigureAwait(false);
        await stream.FlushAsync(cancellationToken).ConfigureAwait(false);
    }

    /// <summary>Reads one frame. Returns <c>null</c> when the stream was closed cleanly between frames.</summary>
    /// <exception cref="FrameTooLargeException">The declared length is larger than <see cref="Limits.MaxFrameBytes"/>.</exception>
    /// <exception cref="EndOfStreamException">The stream ended inside the header or the payload.</exception>
    public static async Task<byte[]?> ReadAsync(Stream stream, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(stream);

        var header = new byte[HeaderBytes];
        var headerRead = await ReadFullyAsync(stream, header, cancellationToken).ConfigureAwait(false);
        if (headerRead == 0)
        {
            return null;
        }

        if (headerRead < HeaderBytes)
        {
            throw new EndOfStreamException("The stream ended inside the frame header.");
        }

        var length = BinaryPrimitives.ReadUInt32BigEndian(header);
        if (length > Limits.MaxFrameBytes)
        {
            throw new FrameTooLargeException(length);
        }

        var payload = new byte[length];
        var payloadRead = await ReadFullyAsync(stream, payload, cancellationToken).ConfigureAwait(false);
        if (payloadRead < payload.Length)
        {
            throw new EndOfStreamException("The stream ended inside the frame payload.");
        }

        return payload;
    }

    /// <summary>Reads until <paramref name="buffer"/> is full or the stream ends; returns the bytes read.</summary>
    private static async Task<int> ReadFullyAsync(Stream stream, byte[] buffer, CancellationToken cancellationToken)
    {
        var total = 0;
        while (total < buffer.Length)
        {
            var read = await stream.ReadAsync(buffer.AsMemory(total), cancellationToken).ConfigureAwait(false);
            if (read == 0)
            {
                break;
            }

            total += read;
        }

        return total;
    }
}
