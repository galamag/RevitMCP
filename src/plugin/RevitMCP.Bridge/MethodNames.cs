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
    public const string ListTypes = "list_types";
    public const string ListMaterials = "list_materials";
    public const string GetElements = "get_elements";
    public const string GetWarnings = "get_warnings";
    public const string Create3dView = "create_3d_view";
    public const string GetViewSnapshot = "get_view_snapshot";
    public const string CreateMaterials = "create_materials";
    public const string CreateType = "create_type";
    public const string CreateLevels = "create_levels";
    public const string CreateWalls = "create_walls";
    public const string CreateFloors = "create_floors";
    public const string CreateRoof = "create_roof";
    public const string CreateCeilings = "create_ceilings";
    public const string CreateFloorOpenings = "create_floor_openings";
    public const string CreateGround = "create_ground";
    public const string LoadFamily = "load_family";
    public const string PlaceInstances = "place_instances";
    public const string AttachWalls = "attach_walls";
    public const string DeleteElements = "delete_elements";
    public const string UndoLastOperation = "undo_last_operation";
    public const string GetLastUndoResult = "get_last_undo_result";

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
        ListTypes,
        ListMaterials,
        GetElements,
        GetWarnings,
        Create3dView,
        GetViewSnapshot,
        CreateMaterials,
        CreateType,
        CreateLevels,
        CreateWalls,
        CreateFloors,
        CreateRoof,
        CreateCeilings,
        CreateFloorOpenings,
        CreateGround,
        LoadFamily,
        PlaceInstances,
        AttachWalls,
        DeleteElements,
        UndoLastOperation,
        GetLastUndoResult,
    ];

    /// <summary>Methods the socket thread answers itself, so they work while the Revit main thread is busy.</summary>
    public static readonly IReadOnlyList<string> Immediate =
    [
        GetStatus,
        GetRequestStatus,
        CancelRequest,
    ];
}
