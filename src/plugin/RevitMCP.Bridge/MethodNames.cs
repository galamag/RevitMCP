namespace RevitMCP.Bridge;

/// <summary>Method names of the bridge protocol. <c>src/contract/protocol.json</c> must list the same names.</summary>
public static class MethodNames
{
    public const string GetStatus = "get_status";
    public const string GetRequestStatus = "get_request_status";
    public const string CancelRequest = "cancel_request";
    public const string GetModelInfo = "get_model_info";
    public const string CreateProject = "create_project";
    public const string OpenProject = "open_project";
    public const string SaveProject = "save_project";

    /// <summary>Every method the bridge accepts.</summary>
    public static readonly IReadOnlyList<string> All =
    [
        GetStatus,
        GetRequestStatus,
        CancelRequest,
        GetModelInfo,
        CreateProject,
        OpenProject,
        SaveProject,
    ];

    /// <summary>Methods the socket thread answers itself, so they work while the Revit main thread is busy.</summary>
    public static readonly IReadOnlyList<string> Immediate =
    [
        GetStatus,
        GetRequestStatus,
        CancelRequest,
    ];
}
