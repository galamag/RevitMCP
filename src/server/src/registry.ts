import { z } from "zod";

import { presentSnapshot } from "./snapshot.ts";

/** One part of a tool result, as MCP defines it. */
export type ToolContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

/** One MCP tool. Each tool forwards to the bridge method of the same name in `src/contract/protocol.json`. */
export interface ToolDefinition {
  readonly name: string;
  /** Written for the model: what the tool does, units, when to use it, and which tools relate to it. */
  readonly description: string;
  /** The tool's arguments as a zod shape, which the MCP SDK turns into a JSON schema. */
  readonly inputSchema: Record<string, z.ZodType>;
  /** How long to wait for Revit before the request is cancelled. The client default (60 s) applies when unset. */
  readonly timeoutMs?: number;
  /** Turns the plugin's answer into the tool result. When unset, the answer is returned as JSON text. */
  readonly present?: (answer: unknown) => Promise<ToolContent[]>;
}

/** The plugin answers these on its socket thread, so they come back at once even while Revit is busy. */
const IMMEDIATE_TIMEOUT_MS = 10_000;

/** The limits of `widthPx`, which the plugin checks too. */
const MIN_SNAPSHOT_WIDTH_PX = 100;
const MAX_SNAPSHOT_WIDTH_PX = 4096;

/** The limits of the sun, which the plugin checks too. */
const MAX_SUN_AZIMUTH_DEG = 360;
const MAX_SUN_ALTITUDE_DEG = 90;

const requestId = z
  .string()
  .min(1)
  .describe("The requestId reported by an earlier tool call, for example in a timeout error. A text value, passed back unchanged.");

const projectName = z
  .string()
  .min(1)
  .describe(
    "A bare file name in the test folder, not a path: no folders, no drive, and no dots apart from an optional .rvt ending. The full path may be at most 254 characters, and a refusal states the longest name that fits. Russian names are fine and stay exactly as written.",
  );

const modelPoint = (what: string) =>
  z
    .object({ x: z.number(), y: z.number(), z: z.number() })
    .describe(`${what}, as { x, y, z } in millimetres in model coordinates, the same as boundingBoxMm of get_elements. z is the height above the project origin, not above a level.`);

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
  {
    name: "list_types",
    description:
      "Lists the types the active project holds in one category, without changing anything. Use it before creating " +
      "an element, because elements are created from a type id and the names are not known in advance. Returns " +
      "[{ id, family, name }] sorted by family, then name, then id, so the order holds between calls. ids are " +
      "strings: pass them back unchanged. family and name are Revit's own text, usually Russian: read them to choose " +
      "a type, and never guess or translate one. An empty list means that no type of this category is loaded in the " +
      "project, not that the category is unknown. view_templates is not a category of elements: it lists the 3D view " +
      "templates for viewTemplateId of create_3d_view, in the same shape, with family as an empty string. " +
      "Related tools: get_elements, get_model_info, create_3d_view.",
    inputSchema: {
      category: z
        .enum(["walls", "floors", "roofs", "ceilings", "doors", "windows", "furniture", "plumbing", "stairs", "railings", "view_templates"])
        .describe("The category to list. These words stay the same whatever the language of Revit."),
    },
  },
  {
    name: "get_elements",
    description:
      "Reads elements of the active project by id, without changing anything. Returns { elements, notFound }. " +
      "elements is [{ id, category, typeName, levelId, boundingBoxMm }] in the order asked, each id once. notFound " +
      "lists the ids that match no element, so an id that is gone does not fail the others. Text that cannot be an " +
      "element id refuses the whole call. category is a list_types word such as walls where one exists, otherwise " +
      "a stable English BuiltInCategory name such as OST_Levels, and null for an element without a category or in a " +
      "custom one: it does not change with the language of Revit. typeName is the name of the element's type, " +
      "usually Russian, and null when it has none. levelId is a string, and null when the element is not tied to a " +
      "level. boundingBoxMm is { min: { x, y, z }, max: { x, y, z } } in millimetres in model coordinates, aligned " +
      "to the model axes and independent of any view. It can be larger than what is visible, and it is null when " +
      "Revit knows no box, as for a type. Related tools: list_types, get_model_info.",
    inputSchema: {
      ids: z.array(z.string().min(1)).min(1).describe("Element ids as strings, passed on unchanged from other tools."),
    },
  },
  {
    name: "create_3d_view",
    description:
      "Creates a new 3D view in the active project as one Undo step, and leaves the active view as it is. kind is " +
      "isometric, which looks from the south-east and above, or perspective, which needs eyeMm and targetMm. A " +
      "perspective camera sees about 43 degrees across and 33 degrees up, with the horizon level, so to fit a " +
      "building stand about 1.5 times its width away. Passing eyeMm or targetMm with isometric is refused, because " +
      "this tool cannot aim an isometric view. displayStyle is realistic for the best picture: it draws materials, " +
      "but without a template it has no cast shadows, and the background is Revit's canvas colour. To get shadows, " +
      "call list_types with view_templates, pick the presentation template by its name, and pass its id as " +
      "viewTemplateId. Its settings are copied once and the view stays free of it. With a template this tool also " +
      "sets sunlight to 80, shadows to 60 and a sky background. Whether shadows are on cannot be read back: it can " +
      "only be seen on a snapshot, and a shadow needs something to fall on, such as a floor around the building. " +
      "sunAzimuthDeg and sunAltitudeDeg aim the sun relative to the camera, and they come together or not at all: " +
      "135 stands behind the camera on its right and 250 behind it on its left. 135 with an altitude of 45 worked " +
      "well. Without them the view keeps its own sun, or the one of the template, which may stand low. shading draws " +
      "plain colours. rendering does not " +
      "render: its picture is only outlines and hatching, so do not use it to show a building. Level lines stay " +
      "visible. name is the exact name of the view: a name that a 3D view already has is refused, " +
      "never changed, so use get_model_info to see the views. Returns { committed, viewId, name, kind, displayStyle, " +
      "warnings, errors, dialogs }. Read committed: when it is false nothing was created, viewId and displayStyle " +
      "are null and errors says why. Otherwise displayStyle is what the view really has. warnings lists what Revit reported, and dialogs " +
      "([{ dialogId, message }]) the dialogs that came up and were refused, usually none. The project then has " +
      "unsaved changes. Related tools: get_view_snapshot, save_project.",
    inputSchema: {
      name: z.string().min(1).describe("The name of the new view. Russian is fine. Revit forbids some characters in names, such as { } [ ] | ; < > ? ` ~ \\ :"),
      kind: z.enum(["isometric", "perspective"]).describe("isometric has no vanishing points; perspective looks like a photo."),
      displayStyle: z.enum(["shading", "realistic", "rendering"]).describe("How the view draws the model."),
      eyeMm: modelPoint("Where the camera stands").optional(),
      targetMm: modelPoint("The point the camera looks at").optional(),
      viewTemplateId: z.string().min(1).optional().describe("The id of a 3D view template from list_types with view_templates. A refusal lists the valid ones."),
      sunAzimuthDeg: z.number().min(0).max(MAX_SUN_AZIMUTH_DEG).optional().describe("The direction of the sun around the camera, in degrees from 0 to 360."),
      sunAltitudeDeg: z.number().min(0).max(MAX_SUN_ALTITUDE_DEG).optional().describe("The height of the sun above the horizon, in degrees from 0 to 90."),
    },
  },
  {
    name: "get_view_snapshot",
    description:
      "Exports one view of the active project as a PNG and returns it as an image, then a text part with { viewId, " +
      "viewName, path, dialogs, sizeBytes }. It does not change the model. Take viewId from get_model_info or " +
      "create_3d_view; the view need not be open. Plans, sections, elevations, 3D views, sheets, drafting views and " +
      "legends can be exported. Schedules and other tables cannot, and are refused, like an id that is no view. " +
      "A refused id lists the views that can be used. Files stay in %LOCALAPPDATA%\\RevitMCP\\snapshots and each " +
      "call adds one. A file over about 3.7 MB is not sent, as a client may refuse it: ask again with a smaller " +
      "widthPx. That was reached at a width of 4096 but not 3000. Related tools: create_3d_view, get_model_info.",
    inputSchema: {
      viewId: z.string().min(1).describe("The id of the view, as a string."),
      widthPx: z
        .number()
        .int()
        .min(MIN_SNAPSHOT_WIDTH_PX)
        .max(MAX_SNAPSHOT_WIDTH_PX)
        .default(1600)
        .describe("The width of the image in pixels. The height follows from the shape of the view."),
    },
    present: presentSnapshot(),
  },
];
