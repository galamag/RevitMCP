import { z } from "zod";

import { presentSnapshot } from "./snapshot.ts";
import { undoLastOperation } from "./undo.ts";
import type { UndoClient } from "./undo.ts";

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
  /** Replaces the forwarding, for a tool that takes more than one request. It gets `timeoutMs` for each of them. */
  readonly run?: (client: UndoClient, timeoutMs: number | undefined) => Promise<unknown>;
}

/** The plugin answers these on its socket thread, so they come back at once even while Revit is busy. */
const IMMEDIATE_TIMEOUT_MS = 10_000;

/** The limits of `widthPx`, which the plugin checks too. */
const MIN_SNAPSHOT_WIDTH_PX = 100;
const MAX_SNAPSHOT_WIDTH_PX = 4096;
const MAX_ELEMENT_IDS = 1000;

/** The limits of the sun, which the plugin checks too. */
const MAX_SUN_AZIMUTH_DEG = 360;
const MAX_SUN_ALTITUDE_DEG = 90;

/** The most items one create_ call takes, which the plugin checks too. */
const MAX_BATCH_ITEMS = 500;

/** The fewest points of an outline, which the plugin checks too. */
const MIN_OUTLINE_POINTS = 3;

/** A roof slope stays below this, in degrees, which the plugin checks too. */
const MAX_ROOF_SLOPE_DEG = 90;

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

const planPoint = (what: string) =>
  z.strictObject({ x: z.number(), y: z.number() }).describe(`${what}, as { x, y } in millimetres in model coordinates. The height comes from the level.`);

const elementId = (what: string) => z.string().min(1).describe(`${what}, as a string, passed on unchanged.`);

const batchOf = <T extends z.ZodType>(item: T) => z.array(item).min(1).max(MAX_BATCH_ITEMS).describe(`The items to create, from 1 to ${MAX_BATCH_ITEMS}.`);

/** The part every create_ tool says the same way. */
const BATCH_RULES =
  `One call takes 1 to ${MAX_BATCH_ITEMS} items and is one transaction, so one Undo step: all of it lands, or none of it. ` +
  "The whole list is checked before anything changes, and a problem in any item refuses the call with an error naming the item and, for a bad id, the valid ones. " +
  "Nothing is substituted. Otherwise it returns { committed, items, warnings, errors, dialogs }. Read committed first: when it is false the model did not change and errors holds the reason in Revit's own words. " +
  "items has one entry per requested item, in order: { index, status, elementId, requested, actual, warnings, error }. index counts from 0. requested is the item as received, " +
  "and actual is what Revit really produced, read back from the model, so compare the two. elementId and actual are null unless the element exists. " +
  "created means the element is in the model. failed means Revit refused this item while the batch ran, and error says why: the batch stops there and nothing lands. " +
  "The one exception is a failed item with committed true: Revit removed that element when it committed, so it is not in the model, while the other items landed. " +
  "rolled_back means this item is not in the model because the batch did not land: it was created and undone, or, when its error says not attempted, the batch stopped before it. " +
  "When Revit refuses only at the end, no item is failed: every item is rolled_back and the reason is in errors. " +
  "warnings at the top lists what Revit reported about the model, such as overlapping walls, and these do not stop a batch, so read them. dialogs ([{ dialogId, message }]) lists the Revit dialogs that came up and were refused, usually none. " +
  "The project then has unsaved changes.";

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
      "elements is [{ id, category, typeName, levelId, boundingBoxMm, topMm? }] in the order asked, each id once. notFound " +
      "lists the ids that match no element, so an id that is gone does not fail the others. Text that cannot be an " +
      "element id refuses the whole call, and so do more than 1000 ids. category is a list_types word such as walls where one exists, otherwise " +
      "a stable English BuiltInCategory name such as OST_Levels, and null for an element without a category or in a " +
      "custom one: it does not change with the language of Revit. typeName is the name of the element's type, " +
      "usually Russian, and null when it has none. levelId is a string, and null when the element is not tied to a " +
      "level. boundingBoxMm is { min: { x, y, z }, max: { x, y, z } } in millimetres in model coordinates, aligned " +
      "to the model axes and independent of any view. It can be larger than what is visible, and it is null when " +
      "Revit knows no box, as for a type. A wall also has topMm, in millimetres in model coordinates: its real top, read from its shape. " +
      "A wall's box can keep an old height after the wall is cut by a roof, so read topMm for a wall and not boundingBoxMm. Other categories have no topMm. Related tools: list_types, get_model_info.",
    inputSchema: {
      ids: z.array(z.string().min(1)).min(1).max(MAX_ELEMENT_IDS).describe("Element ids as strings, passed on unchanged from other tools."),
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
  {
    name: "create_levels",
    description:
      "Creates levels in the active project, each with a floor plan view unless createPlan is false. elevationMm is in " +
      "millimetres above the project origin, the same as elevationMm of get_model_info. A name that already exists, " +
      "matched exactly, gives status already_existed with that level's id in elementId, and the level is left as it " +
      "is. actual then shows what it really is, so read it: when its elevation differs from the request, or createPlan " +
      "is true and it has no plan, the item carries a warning and nothing was moved or added. Such a level is usable, " +
      "but it is not what you asked for. When every item already exists, nothing changes and no Undo step is added. " +
      "already_existed still stands when the batch fails. The same name twice in one list is refused. actual is " +
      "{ name, elevationMm, planViewId, planViewName }, and planViewId is null without a plan. " +
      BATCH_RULES +
      " Related tools: get_model_info, create_walls, create_floors, save_project.",
    inputSchema: {
      items: batchOf(
        z.strictObject({
          name: z.string().min(1).describe("The exact name of the level. Russian is fine. Revit forbids some characters in names, such as { } [ ] | ; < > ? ` ~ \\ :"),
          elevationMm: z.number().describe("The height of the level above the project origin, in millimetres."),
          createPlan: z.boolean().default(true).describe("Whether to create a floor plan view of the new level."),
        }),
      ),
    },
  },
  {
    name: "create_walls",
    description:
      "Creates straight walls in the active project. startMm and endMm are the ends of the wall's centre line in " +
      "millimetres in model coordinates, so a wall of width 200 from y = 0 reaches from y = -100 to y = 100. Take typeId " +
      "from list_types with walls, and levelId and topLevelId from get_model_info. A wall stands on levelId, lifted by " +
      "baseOffsetMm, which may be negative. Give exactly one of heightMm, a fixed height in millimetres that stays the " +
      "same when levels move, and topLevelId, which ties the top of the wall to that level. A top level must be above " +
      "the foot of the wall. Revit cannot build a very low wall: 30 mm failed and 50 mm worked, and such an item fails " +
      "with Revit could not build this element and gave no reason: Failed to regenerate. Nor can it build a very short one: a wall 1 mm long " +
      "passed the check and then made the whole batch fail at commit with Can't make Wall. naming no item, while 5 mm worked. Walls join their neighbours by Revit's own rules, and this tool changes no other element. " +
      "actual is { startMm, endMm, lengthMm, heightMm, widthMm, baseOffsetMm, typeId, levelId, topLevelId }: lengthMm is " +
      "along the centre line, heightMm is measured from the foot of the wall, and topLevelId is null for a fixed height. " +
      BATCH_RULES +
      " Related tools: list_types, get_model_info, get_elements, create_floors, save_project.",
    inputSchema: {
      items: batchOf(
        z
          .strictObject({
            startMm: planPoint("One end of the centre line"),
            endMm: planPoint("The other end of the centre line"),
            typeId: elementId("The id of a wall type from list_types"),
            levelId: elementId("The id of the level the wall stands on"),
            heightMm: z.number().positive().optional().describe("A fixed height in millimetres. Give this or topLevelId, not both."),
            topLevelId: elementId("The id of the level that holds the top of the wall. Give this or heightMm, not both").optional(),
            baseOffsetMm: z.number().default(0).describe("How far the foot of the wall sits above its level, in millimetres. Negative is below."),
          })
          .refine((item) => (item.heightMm === undefined) !== (item.topLevelId === undefined), {
            message: "Give exactly one of heightMm and topLevelId.",
          }),
      ),
    },
  },
  {
    name: "create_floors",
    description:
      "Creates floors in the active project from outlines of straight edges. boundaryMm lists the corners in " +
      "millimetres in model coordinates, in either direction. The outline closes by itself from the last point to the " +
      `first, so do not repeat the first point: equal neighbouring points are refused. It needs at least ${MIN_OUTLINE_POINTS} points. ` +
      "An outline that crosses or touches itself, or encloses no area, is refused. Take typeId from list_types with floors " +
      "and levelId from get_model_info. The top of the floor lies on the level, so its thickness goes downwards. " +
      "actual is { areaM2, heightOffsetMm, typeId, levelId, boundingBoxMm }: areaM2 is in square metres, and " +
      "boundingBoxMm is { min, max } in millimetres. " +
      BATCH_RULES +
      " Related tools: list_types, get_model_info, get_elements, create_walls, save_project.",
    inputSchema: {
      items: batchOf(
        z.strictObject({
          boundaryMm: z.array(planPoint("A corner of the outline")).min(MIN_OUTLINE_POINTS).describe(`The corners of the outline, at least ${MIN_OUTLINE_POINTS}. It closes by itself.`),
          typeId: elementId("The id of a floor type from list_types"),
          levelId: elementId("The id of the level the floor lies on"),
        }),
      ),
    },
  },
  {
    name: "create_roof",
    description:
      "Creates footprint roofs in the active project from outlines of straight edges. outlineMm lists the corners in " +
      "millimetres in model coordinates, in either direction. The outline closes by itself from the last point to the " +
      `first, so do not repeat the first point: equal neighbouring points are refused. It needs at least ${MIN_OUTLINE_POINTS} points, ` +
      "and an outline that crosses or touches itself, or encloses no area, is refused. Edge 0 runs from point 0 to point 1, edge 1 from point 1 to point 2, " +
      "and the last edge from the last point back to point 0. edgeSlopesDeg has one entry per edge in that same order, so as many entries as points. " +
      `A number of degrees, above 0 and below ${MAX_ROOF_SLOPE_DEG}, makes the roof rise inwards from that edge at that angle, and null gives that edge no slope. ` +
      "At least one edge needs a slope, as a roof with none would be flat, and that is refused. The direction of the outline and the corner it starts from change nothing: " +
      "a slope stays on the edge it is listed for. How to build the usual roofs, for a rectangle listed south, east, north, west: a hip roof has a slope on every edge, [30, 30, 30, 30]. " +
      "A gable roof has slopes on two opposite edges and null on the other two, so [30, null, 30, null] has a ridge running east to west and gable ends on the east and west sides. " +
      "A shed roof has one slope, so [30, null, null, null] rises from the south edge and is highest over the north edge. Slopes may differ. " +
      "Take typeId from list_types with roofs and levelId from get_model_info. Put the roof on the level at the top of the walls: without an overhang the outline is the eaves, " +
      "where the underside of the roof meets the level, and the thickness of the type goes up from there. overhangMm, 0 by default, moves every edge out by that distance, edges without a slope too. " +
      "Each slope carries on down to the moved edge, so the eave ends below the level by overhangMm times the tangent of its slope, and above the outline the roof stays exactly as it is without an overhang. " +
      "So draw the outline along the walls and let overhangMm make the eaves. An overhang too big for the outline, such as one that closes a notch, is refused. " +
      "This tool changes no wall, so the triangle under a gable stays open until attach_walls raises the walls to the roof. Only what lies under the roof can rise, so an outline along the centre lines of walls leaves their outer half low: " +
      "use an overhang wider than half the wall, or an outline along the outer faces. A roof Revit cannot build, such as one too high for the model, fails at the end with Can't make footprint roof. in errors. " +
      "actual is { edges, typeId, levelId, boundingBoxMm }. edges has one entry per edge, in the order of outlineMm, read back from the roof: { startMm, endMm, definesSlope, slopeDeg, eaveOffsetMm }. " +
      "startMm and endMm are where that eave really is, so the outline moved out by the overhang. slopeDeg is null on an edge without a slope. eaveOffsetMm is the height of that edge above the level, negative below it, and it means nothing on an edge without a slope: it reads 0 there, while that rake really ends below the level when there is an overhang. " +
      "boundingBoxMm is { min, max } in millimetres, and its top includes the thickness of the roof. It is null for a Sloped Glazing type, where Revit gives no box, so check such a roof on a snapshot. " +
      BATCH_RULES +
      " Related tools: list_types, get_model_info, get_elements, attach_walls, create_walls, save_project.",
    inputSchema: {
      items: batchOf(
        z
          .strictObject({
            outlineMm: z.array(planPoint("A corner of the outline")).min(MIN_OUTLINE_POINTS).describe(`The corners of the outline, at least ${MIN_OUTLINE_POINTS}. It closes by itself. Edge N starts at point N.`),
            levelId: elementId("The id of the level at the top of the walls"),
            typeId: elementId("The id of a roof type from list_types"),
            overhangMm: z.number().min(0).default(0).describe("How far every edge moves out from the outline, in millimetres."),
            edgeSlopesDeg: z
              .array(z.number().gt(0).lt(MAX_ROOF_SLOPE_DEG).nullable())
              .describe(`One entry per edge, in the order of the outline: degrees above 0 and below ${MAX_ROOF_SLOPE_DEG}, or null for no slope.`),
          })
          .refine((item) => item.edgeSlopesDeg.length === item.outlineMm.length, {
            message: "edgeSlopesDeg needs one entry per edge, so as many entries as outlineMm has points.",
          })
          .refine((item) => item.edgeSlopesDeg.some((slope) => slope !== null), {
            message: "edgeSlopesDeg needs a slope on at least one edge.",
          }),
      ),
    },
  },
  {
    name: "attach_walls",
    description:
      "Attaches the tops of walls to a roof, so that each wall follows the underside of the roof. A wall below the roof rises to it, which is what fills the gable ends of a gable roof, " +
      "and a wall that reaches above the roof is cut down to it. Take wallId from create_walls and roofId from create_roof. No element is created, so elementId is the id of the wall, and the status is about the attachment: " +
      "here created means a new attachment, so the wall already existed. already_existed means that wall was attached to that roof before: nothing changes, and when every item is like that no Undo step is added. " +
      "already_existed still stands when the batch fails. The same wall and roof twice in one list is refused. A wall may attach to several roofs, each as its own item, as when it runs under two of them. " +
      "A wall that does not meet the roof still attaches and comes back created, but it does not change, and warnings at the top says that it misses the target, so compare topMm. " +
      "A wall that stands above the whole roof cannot follow it, as its top would fall below its foot: the batch then fails at the end with Revit's reason in errors. " +
      "Only the part of a wall under the roof can rise, so an outline along the centre lines of the walls leaves their outer half low, see create_roof. " +
      "actual is { attachedToIds, topMm }: attachedToIds lists every element the top of the wall is attached to, and topMm is the highest point of the real shape of the wall, in millimetres in model coordinates. " +
      "For this tool the batch rules read so: a rolled_back item has elementId null although the wall exists, because it is the attachment that is not in the model, and a call whose items are all already_existed changes nothing, so it leaves no unsaved changes. " +
      BATCH_RULES +
      " Related tools: create_roof, create_walls, get_elements, save_project.",
    inputSchema: {
      items: batchOf(
        z.strictObject({
          wallId: elementId("The id of the wall"),
          roofId: elementId("The id of the roof its top attaches to"),
        }),
      ),
    },
  },
  {
    name: "delete_elements",
    description:
      "Deletes elements of the active project by id, or shows what a delete would take. dryRun is true unless you pass false, so a call that leaves it out deletes nothing. " +
      "Use it that way first: Revit also deletes everything that depends on an element, without asking. A level takes the walls, floors and views on it, and a wall type takes every wall of that type. " +
      "A dry run really runs the delete in Revit and rolls it back: the model, the Undo history and the unsaved state stay as they were. It stops before Revit's final check at commit, so a real delete can still be refused. " +
      `Take 1 to ${MAX_ELEMENT_IDS} ids from other tools. An id asked twice counts once. The whole list is checked first: text that cannot be an id, an id with no element, or an element Revit cannot delete refuses the call, and nothing changes. ` +
      "Returns { dryRun, committed, summary, requested, allAffected, dependents, warnings, errors, dialogs }. allAffected lists every id that goes or would go, the requested ones included, and dependents only those you did not ask for. " +
      "Read them before a real delete. Some of them are not model elements you know, such as views or internal elements: read them with get_elements. " +
      "On a real delete committed true means they are gone, as one Undo step, and the project has unsaved changes. committed false means nothing was deleted, allAffected is empty and errors holds the reason. " +
      "In a dry run committed is always false, which is no failure: an empty errors with allAffected filled means it would go ahead, and summary says so in words. " +
      "dialogs ([{ dialogId, message }]) lists the Revit dialogs that came up and were refused, usually none. The ids of what is gone stay invalid unless the delete is undone. " +
      "Related tools: undo_last_operation, get_elements, get_model_info.",
    inputSchema: {
      ids: z.array(z.string().min(1)).min(1).max(MAX_ELEMENT_IDS).describe("Element ids as strings, passed on unchanged from other tools."),
      dryRun: z.boolean().default(true).describe("true shows what would go and deletes nothing. Pass false to delete."),
    },
  },
  {
    name: "undo_last_operation",
    description:
      "Undoes the last operation of these tools in the active project with Revit's own Undo, one operation per call: a whole batch comes off as one, and a delete comes back with the same ids. " +
      "It needs no arguments and answers only after Revit confirmed it. Returns { state, undoId, transactionName, createdIds, restoredIds, documentTitle }. state is undone. transactionName names what came off, as MCP: and the tool name. " +
      "createdIds lists the elements that operation created: they no longer exist, so every id you still hold from it is invalid, and using one fails. An element it changed goes back to how it was, and its id stays. restoredIds lists what that operation had deleted, back in the model under the same ids. " +
      "It refuses, and nothing changes, when the error text starts with undo_refused: when nothing of these tools is in the history of the active project, which is always so right after create_project or open_project opened it, as Revit keeps no history in the file; " +
      "when the last change in the project came from somewhere else, such as the user in Revit, because Undo would take that instead: only the user can undo their own change; " +
      "when the last operation of these tools lies in another project: make that one active with open_project first; and when an earlier undo is still unconfirmed. " +
      "A failed call that does not start with undo_refused means the undo was posted, or may have been, without a confirmation, and the text says which. Then do not call this again blindly, as it would take the next operation: " +
      "ask get_last_undo_result first. After an undo the project may read as saved or as changed, whichever is true: see isModified in get_model_info. There is no redo tool. " +
      "Related tools: get_last_undo_result, delete_elements, get_model_info.",
    inputSchema: {},
    run: undoLastOperation,
  },
  {
    name: "get_last_undo_result",
    description:
      "Says what became of the last undo posted in this Revit session, without undoing anything. undo_last_operation already asks this itself, so call it only after that tool reported no confirmation, such as after a timeout. " +
      "Returns { state, undoId, transactionName, createdIds, restoredIds, documentTitle }. state undone means Revit reported that undo, and the other keys mean what they mean there. " +
      "not_confirmed means it was posted and Revit reported nothing, so treat the model as unchanged, and it is possible that Revit dropped the command. none means no undo was posted since Revit started, and the other keys are then empty. " +
      "An undo is reported as what it was asked to take. A change that a person undid in Revit is not an undo of these tools, so it does not show here. " +
      "It waits for Revit like any model request, and it also lets a command Revit is holding go first. Related tools: undo_last_operation, get_model_info.",
    inputSchema: {},
  },
];
