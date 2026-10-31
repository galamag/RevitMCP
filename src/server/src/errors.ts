/** The state of a request as the plugin reports it, plus `unknown` for a request nobody holds or whose fate is lost. */
export type RequestState = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "unknown";

/** Error codes of the bridge protocol (`JsonRpcCodes` in the plugin). */
export const RpcCodes = {
  unauthorized: -32001,
  protocolMismatch: -32002,
  notExecuted: -32003,
  busy: -32004,
  internalError: -32603,
} as const;

/** Revit is not running, or its plugin does not accept connections. The fix is for the user to start Revit. */
export class RevitNotRunningError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RevitNotRunningError";
  }
}

/**
 * A request may still be queued or running in Revit, or its fate is unknown. The model can ask
 * `get_request_status` with `requestId` to find out. Never resend the command blindly.
 */
export class BridgeRequestPendingError extends Error {
  readonly requestId: string;
  readonly state: RequestState;

  /** `reason` says how the wait ended, and comes before the standard advice. */
  constructor(requestId: string, state: RequestState, reason?: string) {
    super(reason === undefined ? describePending(requestId, state) : `${reason} ${describePending(requestId, state)}`);
    this.name = "BridgeRequestPendingError";
    this.requestId = requestId;
    this.state = state;
  }
}

/** The plugin answered with an error. `message` is written for the model, `data` keeps the plugin's own text. */
export class BridgeRpcError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "BridgeRpcError";
    this.code = code;
    this.data = data;
  }
}

function describePending(requestId: string, state: RequestState): string {
  const how = state === "running"
    ? "It is running in Revit now and cannot be cancelled."
    : state === "queued"
      ? "It is still queued in Revit."
      : "Its outcome is not known: it may be queued, running or finished.";
  return `Request ${requestId} was sent to Revit. ${how} Call get_request_status with requestId "${requestId}" to see how it ended. Do not send the command again before you know.`;
}

/** Turns a plugin error into text for the model. The plugin's own wording is kept at the end. */
export function describePluginError(code: number, message: string): string {
  switch (code) {
    case RpcCodes.notExecuted:
      return `The command was not executed: it expired or was cancelled in Revit's queue before it started, so nothing in the Revit project changed and it is safe to send it again. Plugin message: ${message}`;
    case RpcCodes.busy:
      return `Revit is busy: its queue is full of unfinished requests, so this command was not accepted and was not executed. Wait a few seconds, check get_status, then try again. Plugin message: ${message}`;
    case RpcCodes.unauthorized:
      return `The plugin rejected the connection token. Revit was probably restarted. Try the call again. Plugin message: ${message}`;
    case RpcCodes.protocolMismatch:
      return `The MCP server and the Revit plugin speak different protocol versions. Install matching versions. Plugin message: ${message}`;
    case RpcCodes.internalError:
      return message.startsWith("no_active_document")
        ? `No project is open in Revit. Ask the user to open a project (or create one) in Revit and then try again. Plugin message: ${message}`
        : message;
    default:
      return message;
  }
}
