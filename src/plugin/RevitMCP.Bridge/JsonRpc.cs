using System.Buffers;
using System.Text.Encodings.Web;
using System.Text.Json;

namespace RevitMCP.Bridge;

/// <summary>Error codes of the bridge protocol.</summary>
public static class JsonRpcCodes
{
    public const int Unauthorized = -32001;
    public const int ProtocolMismatch = -32002;

    /// <summary>The request never ran: it expired or was cancelled in the queue.</summary>
    public const int QueueExpired = -32003;

    /// <summary>The request store is full of unfinished requests; nothing was enqueued.</summary>
    public const int Busy = -32004;

    public const int MethodNotFound = -32601;
    public const int InvalidParams = -32602;
    public const int InternalError = -32603;
}

internal sealed record JsonRpcError(int Code, string Message);

/// <summary>
/// One request frame. Its fields are not validated yet, because the sender is not known to be trusted.
/// <see cref="Params"/> is a clone, so it stays valid after the frame's <see cref="JsonDocument"/> is gone.
/// </summary>
internal sealed record JsonRpcRequest(string? Id, string? Method, JsonElement Params, string? Token, int? ProtocolVersion)
{
    private static readonly JsonElement EmptyParams = JsonElement.Parse("{}");

    /// <summary>Returns <c>null</c> when the frame is not a JSON object with readable strings.</summary>
    public static JsonRpcRequest? TryParse(byte[] frame)
    {
        try
        {
            using var document = JsonDocument.Parse(frame);
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
            {
                return null;
            }

            return new JsonRpcRequest(
                ReadString(root, "id"),
                ReadString(root, "method"),
                root.TryGetProperty("params", out var parameters) ? parameters.Clone() : EmptyParams,
                ReadString(root, "token"),
                root.TryGetProperty("protocolVersion", out var version)
                    && version.ValueKind == JsonValueKind.Number
                    && version.TryGetInt32(out var number)
                    ? number
                    : null);
        }
        catch (JsonException)
        {
            return null;
        }
        catch (InvalidOperationException)
        {
            // JsonElement.GetString throws this for text that is not valid UTF-8 or UTF-16, such as a lone surrogate.
            return null;
        }
    }

    private static string? ReadString(JsonElement root, string name) =>
        root.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;
}

/// <summary>Builds response payloads. A response always fits in a frame.</summary>
internal static class JsonRpcResponse
{
    // Keeps Cyrillic as UTF-8 instead of \uXXXX, which would triple its size against the frame limit.
    // The "unsafe" in the name concerns HTML pages, and these bytes are never embedded in one.
    private static readonly JavaScriptEncoder Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping;

    public static byte[] Result(string id, JsonElement result)
    {
        var payload = Build(id, writer =>
        {
            writer.WritePropertyName("result");
            result.WriteTo(writer);
        });

        return payload.Length <= Limits.MaxFrameBytes
            ? payload
            : Error(id, new JsonRpcError(
                JsonRpcCodes.InternalError,
                $"The result takes {payload.Length} bytes, more than the frame limit of {Limits.MaxFrameBytes} bytes."));
    }

    public static byte[] Error(string? id, JsonRpcError error) => Build(id, writer =>
    {
        writer.WriteStartObject("error");
        writer.WriteNumber("code", error.Code);
        writer.WriteString("message", error.Message);
        writer.WriteEndObject();
    });

    private static byte[] Build(string? id, Action<Utf8JsonWriter> writeBody)
    {
        var buffer = new ArrayBufferWriter<byte>();
        using (var writer = new Utf8JsonWriter(buffer, new JsonWriterOptions { Encoder = Encoder }))
        {
            writer.WriteStartObject();
            writer.WriteString("jsonrpc", "2.0");
            writer.WriteString("id", id);
            writeBody(writer);
            writer.WriteEndObject();
        }

        return buffer.WrittenSpan.ToArray();
    }
}
