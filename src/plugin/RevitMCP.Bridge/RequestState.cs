namespace RevitMCP.Bridge;

/// <summary>Lifecycle state of a request. <see cref="Unknown"/> is reported for IDs nobody holds.</summary>
public enum RequestState
{
    Queued,
    Running,
    Succeeded,
    Failed,
    Cancelled,
    Unknown,
}
