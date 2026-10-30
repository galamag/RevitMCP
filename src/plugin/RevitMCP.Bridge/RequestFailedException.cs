namespace RevitMCP.Bridge;

/// <summary>The exception a <see cref="PendingRequest.Completion"/> task faults with after <see cref="PendingRequest.Fail"/>.</summary>
public sealed class RequestFailedException(int code, string message) : Exception(message)
{
    /// <summary>The JSON-RPC style error code the request failed with.</summary>
    public int Code { get; } = code;
}
