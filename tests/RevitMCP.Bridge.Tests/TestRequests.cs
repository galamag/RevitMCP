using System.Text.Json;

namespace RevitMCP.Bridge.Tests;

internal static class TestRequests
{
    public static PendingRequest Make(string id, DateTimeOffset enqueuedAt, string method = "test.method")
    {
        return new PendingRequest(id, method, Json("{}"), enqueuedAt);
    }

    public static JsonElement Json(string json)
    {
        using var doc = JsonDocument.Parse(json);
        return doc.RootElement.Clone();
    }
}
