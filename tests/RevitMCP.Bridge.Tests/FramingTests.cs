using System.Buffers.Binary;
using System.Text;
using Xunit;

namespace RevitMCP.Bridge.Tests;

public class FramingTests
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static async Task<byte[]> FrameAsync(byte[] payload)
    {
        using var ms = new MemoryStream();
        await Framing.WriteAsync(ms, payload, Ct);
        return ms.ToArray();
    }

    private static byte[] Header(uint length)
    {
        var header = new byte[4];
        BinaryPrimitives.WriteUInt32BigEndian(header, length);
        return header;
    }

    [Fact]
    public async Task Roundtrip_Utf8Cyrillic()
    {
        var payload = Encoding.UTF8.GetBytes("Уровень 1");

        using var ms = new MemoryStream();
        await Framing.WriteAsync(ms, payload, Ct);
        ms.Position = 0;
        var read = await Framing.ReadAsync(ms, Ct);

        Assert.NotNull(read);
        Assert.Equal("Уровень 1", Encoding.UTF8.GetString(read));
    }

    [Fact]
    public async Task ZeroLengthFrame_Roundtrips()
    {
        using var ms = new MemoryStream();
        await Framing.WriteAsync(ms, [], Ct);
        ms.Position = 0;

        var read = await Framing.ReadAsync(ms, Ct);

        Assert.NotNull(read);
        Assert.Empty(read);
    }

    [Fact]
    public async Task FrameOfExactlyMaxBytes_IsAccepted()
    {
        var payload = new byte[Limits.MaxFrameBytes];
        payload[0] = 0x11;
        payload[^1] = 0x22;

        using var ms = new MemoryStream();
        await Framing.WriteAsync(ms, payload, Ct);
        ms.Position = 0;
        var read = await Framing.ReadAsync(ms, Ct);

        Assert.NotNull(read);
        Assert.Equal(Limits.MaxFrameBytes, read.Length);
        Assert.Equal(0x11, read[0]);
        Assert.Equal(0x22, read[^1]);
    }

    [Fact]
    public async Task Write_EmitsBigEndianLengthPrefix()
    {
        var frame = await FrameAsync(new byte[] { 0xAA, 0xBB, 0xCC });

        Assert.Equal(new byte[] { 0x00, 0x00, 0x00, 0x03, 0xAA, 0xBB, 0xCC }, frame);
    }

    [Fact]
    public async Task ReadsWhenBytesArriveOneAtATime()
    {
        var frame = await FrameAsync(Encoding.UTF8.GetBytes("Уровень 1"));
        using var stream = new OneByteAtATimeStream(frame);

        var read = await Framing.ReadAsync(stream, Ct);

        Assert.NotNull(read);
        Assert.Equal("Уровень 1", Encoding.UTF8.GetString(read));
    }

    [Fact]
    public async Task RejectsOversizedLength()
    {
        using var ms = new MemoryStream(Header((uint)Limits.MaxFrameBytes + 1));

        await Assert.ThrowsAsync<FrameTooLargeException>(() => Framing.ReadAsync(ms, Ct));
    }

    [Fact]
    public async Task RejectsHttpPost()
    {
        using var ms = new MemoryStream(Encoding.ASCII.GetBytes("POST / HTTP/1.1\r\n\r\n"));

        await Assert.ThrowsAsync<FrameTooLargeException>(() => Framing.ReadAsync(ms, Ct));
    }

    [Fact]
    public async Task WriteRejectsOversizedPayload()
    {
        using var ms = new MemoryStream();
        var payload = new byte[Limits.MaxFrameBytes + 1];

        await Assert.ThrowsAsync<FrameTooLargeException>(() => Framing.WriteAsync(ms, payload, Ct));
        Assert.Equal(0, ms.Length);
    }

    [Fact]
    public async Task CleanEofReturnsNull()
    {
        using var ms = new MemoryStream();

        var read = await Framing.ReadAsync(ms, Ct);

        Assert.Null(read);
    }

    [Fact]
    public async Task EofInsideHeaderThrows()
    {
        using var ms = new MemoryStream(new byte[] { 0x00, 0x00 });

        await Assert.ThrowsAsync<EndOfStreamException>(() => Framing.ReadAsync(ms, Ct));
    }

    [Fact]
    public async Task EofInsidePayloadThrows()
    {
        var frame = await FrameAsync(new byte[] { 1, 2, 3, 4, 5 });
        using var ms = new MemoryStream(frame, 0, frame.Length - 2);

        await Assert.ThrowsAsync<EndOfStreamException>(() => Framing.ReadAsync(ms, Ct));
    }

    /// <summary>Read-only stream that returns at most one byte per read call.</summary>
    private sealed class OneByteAtATimeStream(byte[] data) : Stream
    {
        private int _position;

        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => throw new NotSupportedException();
        public override long Position
        {
            get => throw new NotSupportedException();
            set => throw new NotSupportedException();
        }

        public override int Read(Span<byte> buffer)
        {
            if (buffer.IsEmpty || _position >= data.Length)
            {
                return 0;
            }

            buffer[0] = data[_position++];
            return 1;
        }

        public override int Read(byte[] buffer, int offset, int count) => Read(buffer.AsSpan(offset, count));

        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default) =>
            ValueTask.FromResult(Read(buffer.Span));

        public override void Flush() { }
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }
}
