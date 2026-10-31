using System.Collections.Concurrent;
using System.Net;
using System.Net.Sockets;
using System.Text.Json;
using System.Threading.Channels;
using Xunit;

namespace RevitMCP.Bridge.Tests;

/// <summary>
/// A protocol client over real loopback TCP. Responses are sorted by request ID as they arrive, and every
/// wait has a fixed timeout, so a broken server fails a test instead of hanging the suite.
/// </summary>
internal sealed class BridgeTestClient : IAsyncDisposable
{
    public const string ValidToken = "test-token-0123456789abcdef";

    /// <summary>Where responses with <c>"id": null</c> are filed.</summary>
    public const string NullId = "<null id>";

    public static readonly TimeSpan Timeout = TimeSpan.FromSeconds(20);

    private readonly TcpClient _tcp;
    private readonly NetworkStream _stream;
    private readonly SemaphoreSlim _writeLock = new(1, 1);
    private readonly ConcurrentDictionary<string, Channel<JsonElement>> _inbox = new();
    private readonly Task _reader;

    private BridgeTestClient(TcpClient tcp)
    {
        _tcp = tcp;
        _stream = tcp.GetStream();
        _reader = Task.Run(ReadAllAsync);
    }

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    public static async Task<BridgeTestClient> ConnectAsync(int port)
    {
        var tcp = new TcpClient(AddressFamily.InterNetwork);
        await tcp.ConnectAsync(IPAddress.Loopback, port).WaitAsync(Timeout, Ct);
        return new BridgeTestClient(tcp);
    }

    /// <summary>Sends one request frame. A <c>null</c> token or version leaves that field out.</summary>
    public Task SendAsync(
        string id,
        string method,
        object? parameters = null,
        string? token = ValidToken,
        int? protocolVersion = BridgeServer.ProtocolVersion)
    {
        var request = new Dictionary<string, object?>
        {
            ["jsonrpc"] = "2.0",
            ["id"] = id,
            ["method"] = method,
            ["params"] = parameters ?? new { },
        };
        if (token is not null)
        {
            request["token"] = token;
        }

        if (protocolVersion is not null)
        {
            request["protocolVersion"] = protocolVersion;
        }

        return SendRawAsync(JsonSerializer.SerializeToUtf8Bytes(request));
    }

    public async Task SendRawAsync(byte[] payload)
    {
        await _writeLock.WaitAsync(Ct);
        try
        {
            await Framing.WriteAsync(_stream, payload, Ct).WaitAsync(Timeout, Ct);
        }
        finally
        {
            _writeLock.Release();
        }
    }

    /// <summary>Writes bytes with no framing of their own, for tests that send a bad header.</summary>
    public async Task SendBytesAsync(byte[] bytes)
    {
        await _stream.WriteAsync(bytes, Ct).AsTask().WaitAsync(Timeout, Ct);
        await _stream.FlushAsync(Ct).WaitAsync(Timeout, Ct);
    }

    /// <summary>Returns the next response carrying this ID.</summary>
    public async Task<JsonElement> ReceiveAsync(string id) =>
        await Inbox(id).Reader.ReadAsync(Ct).AsTask().WaitAsync(Timeout, Ct);

    public async Task<JsonElement> CallAsync(
        string id,
        string method,
        object? parameters = null,
        string? token = ValidToken,
        int? protocolVersion = BridgeServer.ProtocolVersion)
    {
        await SendAsync(id, method, parameters, token, protocolVersion);
        return await ReceiveAsync(id);
    }

    /// <summary>Completes once the server has closed the connection.</summary>
    public Task AssertClosedAsync() => _reader.WaitAsync(Timeout, Ct);

    public async ValueTask DisposeAsync()
    {
        _tcp.Dispose();
        await _reader.WaitAsync(Timeout, CancellationToken.None);
    }

    private Channel<JsonElement> Inbox(string id) => _inbox.GetOrAdd(id, _ => Channel.CreateUnbounded<JsonElement>());

    private async Task ReadAllAsync()
    {
        try
        {
            while (await Framing.ReadAsync(_stream, CancellationToken.None) is { } frame)
            {
                using var document = JsonDocument.Parse(frame);
                var id = document.RootElement.GetProperty("id").GetString() ?? NullId;
                Inbox(id).Writer.TryWrite(document.RootElement.Clone());
            }
        }
        catch (Exception e) when (e is IOException or SocketException or ObjectDisposedException)
        {
            // An abrupt close: the server resets a connection it refuses while bytes are still unread.
        }
    }
}
