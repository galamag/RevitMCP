import { z } from "zod";

/** One MCP tool. Each tool forwards to the bridge method of the same name in `src/contract/protocol.json`. */
export interface ToolDefinition {
  readonly name: string;
  /** Written for the model: what the tool does, units, when to use it, and which tools relate to it. */
  readonly description: string;
  /** The tool's arguments as a zod shape, which the MCP SDK turns into a JSON schema. */
  readonly inputSchema: Record<string, z.ZodType>;
  /** How long to wait for Revit before the request is cancelled. The client default (60 s) applies when unset. */
  readonly timeoutMs?: number;
}

/** The plugin answers these on its socket thread, so they come back at once even while Revit is busy. */
const IMMEDIATE_TIMEOUT_MS = 10_000;

const requestId = z
  .string()
  .min(1)
  .describe("The requestId reported by an earlier tool call, for example in a timeout error. A text value, passed back unchanged.");

const projectName = z
  .string()
  .min(1)
  .describe(
    "A bare file name in the test folder, not a path: no folders, no drive, and no dots apart from an optional .rvt ending. Russian names are fine and stay exactly as written.",
  );

export const tools: readonly ToolDefinition[] = [
  {
    name: "get_status",
    description:
      "Reports the health of the Revit plugin and its request queue. Returns pluginVersion, protocolVersion, " +
      "queueLength (requests waiting for Revit's main thread) and oldestQueuedSeconds (how long the longest-waiting " +
      "request has waited, in seconds; 0 when the queue is empty). It answers at once even while Revit is busy or a " +
      "modal dialog blocks commands, so use it first to check that Revit is reachable, and again whenever another " +
      "tool times out or reports that Revit is busy. A growing queueLength with a large oldestQueuedSeconds means " +
      "Revit is not processing commands, usually because a dialog is open and the user must close it. " +
      "Related tools: get_request_status, cancel_request.",
    inputSchema: {},
    timeoutMs: IMMEDIATE_TIMEOUT_MS,
  },
  {
    name: "get_request_status",
    description:
      "Looks up one earlier request by its requestId and returns { requestId, state, result?, error? }. state is " +
      "queued, running, succeeded, failed, cancelled or unknown. A finished request carries its result, or an error " +
      "with a code and a message. unknown means the plugin never saw that id or has already forgotten it (it keeps " +
      "only the last 256 results). Use it when another tool reported a timeout or a lost connection together with a " +
      "requestId: look the request up instead of sending the command again, because it may still run or may have " +
      "finished. Answers at once even while Revit is busy. Related tools: cancel_request, get_status.",
    inputSchema: { requestId },
    timeoutMs: IMMEDIATE_TIMEOUT_MS,
  },
  {
    name: "cancel_request",
    description:
      "Cancels a request that is still waiting in Revit's queue and returns its status in the same shape as " +
      "get_request_status. Only a queued request can be cancelled: one that already runs cannot be stopped and " +
      "finishes or fails on its own. Read state in the answer: cancelled means it will never run and changed nothing " +
      "in the project; running means it was too late; succeeded or failed means it had already finished. Use it " +
      "when a command is stuck behind a busy Revit (see get_status) and you no longer want it. " +
      "Related tools: get_request_status, get_status.",
    inputSchema: { requestId },
    timeoutMs: IMMEDIATE_TIMEOUT_MS,
  },
  {
    name: "get_model_info",
    description:
      "Describes what is open in Revit, without changing anything. Returns activeDocument ({ title, path, " +
      "isModified }, or null when no project is open), levels ([{ id, name, elevationMm }] sorted by elevation, in " +
      "millimetres), views ([{ id, name, viewType }], without templates and browsers), categoryCounts ([{ id, " +
      "category, name, count }]: how many elements each category holds; category is the stable English " +
      "BuiltInCategory name such as OST_Walls, or null for a custom category, while name is localized) and " +
      "openDocuments ([{ title, path, isModified }] for every open document, linked models included). All ids are " +
      "strings: pass them back unchanged. Names may be Russian, so match on id, category or viewType and not on " +
      "names. Call it first in a session to see the project before you create or edit anything, and again after " +
      "changes to confirm them. It works with no project open: everything except openDocuments is then empty. " +
      "Related tool: get_status.",
    inputSchema: {},
  },
  {
    name: "create_project",
    description:
      "Creates a new Revit project from the default Russian template, saves it as <name>.rvt in the test folder " +
      "(%USERPROFILE%\\Documents\\RevitMCP) and makes it the active document. Projects already open stay open. Only " +
      "the test folder is reachable, so pass a name and never a path. It overwrites nothing: a name already in the " +
      "folder is refused, and then open_project is what you want. Returns { name, path, dialogs }: path is where the " +
      "file really went, and dialogs ([{ dialogId, message }]) lists the Revit dialogs that came up and were refused, " +
      "usually none. Takes several seconds. Related tools: open_project, save_project, get_model_info.",
    inputSchema: { name: projectName },
  },
  {
    name: "open_project",
    description:
      "Makes a project from the test folder (%USERPROFILE%\\Documents\\RevitMCP) the active document, opening it if " +
      "needed. Use it to carry on after Revit restarted, or to switch back to another project. Only the test folder " +
      "is reachable, so pass a name and never a path, and a name that is not there is refused. Returns { name, path, " +
      "alreadyOpen, isModified, dialogs }. When alreadyOpen is true the project was open in Revit, so it was only " +
      "activated, and any unsaved changes are still there (isModified says so) and the file on disk was not read. " +
      "dialogs ([{ dialogId, message }]) lists the Revit dialogs that came up and were refused, usually none. " +
      "Related tools: create_project, save_project, get_model_info.",
    inputSchema: { name: projectName },
  },
  {
    name: "save_project",
    description:
      "Saves the active project to its file, which must be in the test folder (%USERPROFILE%\\Documents\\RevitMCP). It " +
      "refuses when no project is active, when the active document was never saved (use create_project) and when its " +
      "file is elsewhere. Pass name to state which project you mean: if another one is active, nothing is saved and " +
      "you should call open_project first. Without name it saves whatever is active. Revit keeps numbered backups " +
      "such as <name>.0001.rvt beside the file. Returns { name, path, dialogs }: dialogs ([{ dialogId, message }]) " +
      "lists the Revit dialogs that came up and were refused, usually none. Related tools: create_project, " +
      "open_project, get_model_info.",
    inputSchema: { name: projectName.optional() },
  },
];
