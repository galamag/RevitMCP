import { z } from "zod";

import type { BridgeCaller } from "./client.ts";
import { presentSnapshot } from "./snapshot.ts";
import { undoLastOperation } from "./undo.ts";

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
  readonly run?: (client: BridgeCaller, timeoutMs: number | undefined) => Promise<unknown>;
}

/** The plugin answers these on its socket thread, so they come back at once even while Revit is busy. */
const IMMEDIATE_TIMEOUT_MS = 10_000;

/** The limits of `widthPx`, which the plugin checks too. */
const MIN_SNAPSHOT_WIDTH_PX = 100;
const MAX_SNAPSHOT_WIDTH_PX = 4096;
const MAX_ELEMENT_IDS = 1000;

/** The category words of list_types and get_elements, the same as `CategoryMap` in the plugin. */
const ELEMENT_CATEGORIES = ["walls", "floors", "roofs", "ceilings", "doors", "windows", "furniture", "plumbing", "stairs", "railings", "toposolid", "rooms"] as const;

/** The limits of the sun, which the plugin checks too. */
const MAX_SUN_AZIMUTH_DEG = 360;
const MAX_SUN_ALTITUDE_DEG = 90;

/** The most items one create_ call takes, which the plugin checks too. */
const MAX_BATCH_ITEMS = 500;

/** The fewest points of an outline, which the plugin checks too. */
const MIN_OUTLINE_POINTS = 3;

/** A roof slope stays below this, in degrees, which the plugin checks too. */
const MAX_ROOF_SLOPE_DEG = 90;

/** The limits of one stairs, which the plugin checks too. */
const MIN_STAIRS_RISERS = 2;
const MAX_STAIRS_RISERS = 500;
const MAX_STAIRS_RUNS = 2;
const MAX_STAIRS_WIDTH_MM = 9_144_000;

/** The places railings take on a stairs, and the fewest points of a railing path, which the plugin checks too. */
const RAILING_POSITIONS = ["treads", "stringer"] as const;
const MIN_RAILING_PATH_POINTS = 2;

/** The limits of a colour channel and of transparency, which the plugin checks too. */
const MAX_COLOR_CHANNEL = 255;
const MAX_TRANSPARENCY = 100;

/** The functions of a layer of a type, the same as `Functions` in the plugin. */
const LAYER_FUNCTIONS = ["structure", "substrate", "insulation", "finish1", "finish2", "membrane"] as const;

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

const templateName = z
  .string()
  .min(1)
  .describe(
    "A bare file name of a project template in the test folder, not a path: no folders, no drive, and no dots apart from an optional .rte ending. The full path may be at most 254 characters. Russian names are fine and stay exactly as written.",
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
      "Creates a new Revit project from the default Russian template, or from a template of your own when templateName is given, " +
      "saves it as <name>.rvt in the test folder (%USERPROFILE%\\Documents\\RevitMCP) and makes it the active document. Projects already open stay open. Only " +
      "the test folder is reachable, so pass a name and never a path. It overwrites nothing: a name already in the " +
      "folder is refused, and then open_project is what you want. " +
      "templateName is the name of a template that save_project_template made, such as one that holds your own wall types and materials. " +
      "A template that does not exist is refused before anything is opened, and so is one that Revit holds open as a document. " +
      "A template carries the whole model it was saved from, so a project made from a template saved from a built house starts with that house in it. " +
      "Leave templateName out for the stock template. " +
      "Returns { name, path, dialogs }: path is where the " +
      "file really went, and dialogs ([{ dialogId, message }]) lists the Revit dialogs that came up and were refused, " +
      "usually none. Takes several seconds. Related tools: save_project_template, open_project, save_project, get_model_info.",
    inputSchema: { name: projectName, templateName: templateName.optional() },
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
      "save_project_template, open_project, get_model_info.",
    inputSchema: { name: projectName.optional() },
  },
  {
    name: "save_project_template",
    description:
      "Saves the active project as a project template, <name>.rte in the test folder (%USERPROFILE%\\Documents\\RevitMCP), so that create_project can start new projects from it with templateName. " +
      "Use it to keep the wall types, materials and loaded families you set up, so that the next project starts with them. " +
      "A template takes the whole model, everything the project holds at this moment, walls, floors and furniture too: a template saved from a built house brings that house into every project made from it. " +
      "So save one from a project that holds only what new projects should start with. " +
      "The project stays the active document, on its own .rvt, and you carry on working in it. " +
      "The tool saves it too: it writes the project as it is now, unsaved changes included, to the template and then back over the .rvt, so afterwards the project is saved, isModified is false, and no save_project is needed. " +
      "It changes no model and adds no Undo step, and Revit keeps a numbered backup such as <name>.0001.rvt beside the project when it writes it. " +
      "It refuses when no project is active, when the active document was never saved or its file is not a .rvt in the test folder (use create_project or open_project first), " +
      "when that .rvt is read-only, and when a template of that name already exists: it overwrites nothing, so pick another name. " +
      "Pass a name and never a path, with no dots apart from an optional .rte ending. " +
      "Returns { name, path, templatePath, isModified, dialogs }: path is the project's file, templatePath is the new template, and dialogs ([{ dialogId, message }]) lists the Revit dialogs that came up and were refused, usually none. " +
      "If saving back to the project fails, the error says in capital letters that the active document stayed on the template. Then do not call save_project, because it would write into the template, and tell the user. " +
      "Takes several seconds. Related tools: create_project, save_project, open_project, get_model_info.",
    inputSchema: { name: templateName },
  },
  {
    name: "list_types",
    description:
      "Lists the types the active project holds in one category, without changing anything. Use it before creating " +
      "an element, because elements are created from a type id and the names are not known in advance. Returns " +
      "[{ id, family, name }] sorted by family, then name, then id, so the order holds between calls. ids are " +
      "strings: pass them back unchanged. family and name are Revit's own text, usually Russian: read them to choose " +
      "a type, and never guess or translate one. An empty list means that no type of this category is loaded in the " +
      "project, not that the category is unknown. toposolid lists the types of ground for create_ground. rooms has no types, so its list is always empty: read rooms with get_elements. view_templates is not a category of elements: it lists the 3D view " +
      "templates for viewTemplateId of create_3d_view, in the same shape, with family as an empty string. " +
      "Related tools: get_elements, get_model_info, create_3d_view.",
    inputSchema: {
      category: z
        .enum([...ELEMENT_CATEGORIES, "view_templates"])
        .describe("The category to list. These words stay the same whatever the language of Revit."),
    },
  },
  {
    name: "list_materials",
    description:
      "Lists the materials the active project holds, without changing anything. Use it to see which materials exist and what colour they have, because the names are not known in advance. " +
      "Returns [{ id, name, materialClass, color, transparency }] sorted by name, then id, so the order holds between calls. id is a string: pass it back unchanged. " +
      "name and materialClass are Revit's own text, usually Russian: read them to choose a material, and never guess or translate one. " +
      "color is { r, g, b }, each from 0 to 255, the colour Revit reports for the Shading display style, or null when the material has no valid colour. " +
      "The Realistic display style draws the appearance of the material instead, and this list does not describe that. " +
      "transparency is a whole number from 0, opaque, to 100, fully transparent. An empty list means the project holds no material. " +
      "Related tools: list_types, get_elements, get_model_info.",
    inputSchema: {},
  },
  {
    name: "get_elements",
    description:
      "Reads elements of the active project, either by id or by category, without changing anything. Give exactly one of ids and category, and a call with both or with neither is refused. " +
      "Returns { elements, notFound, truncated }. " +
      "elements is [{ id, category, typeName, levelId, boundingBoxMm, topMm? }]. With ids it comes in the order asked, each id once, and notFound " +
      "lists the ids that match no element, so an id that is gone does not fail the others. Text that cannot be an " +
      "element id refuses the whole call, and so do more than 1000 ids. truncated is false with ids. " +
      "With category, a list_types word such as walls, it lists the elements of that category that the model holds, not their types, ordered by id. " +
      "It returns at most 1000, and truncated is true when more matched, so narrow the call with levelId. levelId is the id of a level from get_model_info, " +
      "and only with category: it keeps the elements whose own levelId is that level, so one that is tied to no level is left out. " +
      "A levelId that is no level is refused, and the refusal lists the levels. notFound is always empty with category. " +
      "category in each element is a list_types word such as walls where one exists, otherwise " +
      "a stable English BuiltInCategory name such as OST_Levels, and null for an element without a category or in a " +
      "custom one: it does not change with the language of Revit. typeName is the name of the element's type, " +
      "usually Russian, and null when it has none. levelId is a string, and null when the element is not tied to a " +
      "level. boundingBoxMm is { min: { x, y, z }, max: { x, y, z } } in millimetres in model coordinates, aligned " +
      "to the model axes and independent of any view. It can be larger than what is visible, and it is null when " +
      "Revit knows no box, as for a type. A wall also has topMm, in millimetres in model coordinates: its real top, read from its shape. " +
      "A wall's box can keep an old height after the wall is cut by a roof, so read topMm for a wall and not boundingBoxMm. Other categories have no topMm. " +
      "A room, category rooms, also has name, number and areaM2: name is its name without the number, number is its number as text, and areaM2 is its area in square metres, net of the walls. " +
      "A room that encloses nothing is still a room and reads areaM2 0, so check the areas to see which rooms are real. Related tools: list_types, get_model_info, create_rooms.",
    inputSchema: {
      ids: z.array(z.string().min(1)).min(1).max(MAX_ELEMENT_IDS).optional().describe("Element ids as strings, passed on unchanged from other tools. Give this or category, not both."),
      category: z.enum(ELEMENT_CATEGORIES).optional().describe("The category whose elements to list. Give this or ids, not both. These words stay the same whatever the language of Revit."),
      levelId: elementId("The id of the level whose elements to keep. Only with category").optional(),
    },
  },
  {
    name: "get_warnings",
    description:
      "Lists the warnings Revit holds for the active project, the same list as Review Warnings in Revit, without changing anything. " +
      "Use it after building to find what Revit complains about, such as walls that overlap, and again after a fix to see that the warning is gone. " +
      "Returns [{ definitionId, text, elementIds, additionalElementIds }], in the order Revit gives them. " +
      "definitionId is the id of the kind of warning, a GUID that does not change with the language of Revit, so match on it and not on text. " +
      "text is Revit's own words in the language of Revit. elementIds lists the elements that cause the warning and additionalElementIds the ones only related to it, " +
      "both as strings passed back unchanged and sorted, for get_elements. An empty list means that Revit holds no warning. " +
      "The create_ tools also report warnings, but only for their own call and only as text. This tool lists what is still in the model, " +
      "so a warning that Revit resolved when a transaction ended is not in it. Related tools: get_elements, delete_elements, get_model_info.",
    inputSchema: {},
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
      "A refused id lists the views that can be used. Files go to %LOCALAPPDATA%\\RevitMCP\\snapshots and each " +
      "call adds one. When Revit starts, only the 200 newest snapshots are kept and the older ones are deleted. " +
      "A file over about 3.7 MB is not sent, as a client may refuse it: ask again with a smaller " +
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
    name: "create_materials",
    description:
      "Creates materials in the active project, each with a colour that shows in the Realistic display style as well as in Shading. " +
      "colorRgb is { r, g, b }, each a whole number from 0 to 255. Without baseMaterialId the material is new and colorRgb is required: " +
      "it gets its own copy of a plain appearance, so the colour is a flat colour in Realistic, without a texture. " +
      "With baseMaterialId, an id from list_materials, the tool duplicates that material together with its own copy of its appearance, so the base material does not change, and colorRgb, if given, recolours the copy only. " +
      "Without colorRgb the copy keeps the colour of its base. A colour can only be set on an appearance that has a plain colour: " +
      "a base such as brick or wood has none, and a call that asks for a colour or a transparency on such a base is refused before anything changes, never done half way. " +
      "A base with no appearance at all is refused in the same way when a colour or a transparency is asked of it. " +
      "transparency is a whole number from 0, opaque, to 100, fully see-through. Left out, it is 0 for a new material, and a copy keeps the transparency of its base, in Shading and in Realistic, as the base has it. " +
      "Given, 0 included, it is set both on the material and in its appearance, and a base whose appearance has no transparency to set, such as the glass of the template, refuses any value, 0 too, before anything changes: then leave transparency out. " +
      "In Realistic a see-through material shows what lies behind it and loses its tint, so judge the colour of a see-through material with transparency 0. " +
      "A new material, made without baseMaterialId, has the material class Unassigned, and a copy keeps the class of its base. " +
      "A name that already exists, matched exactly, gives status already_existed with that material's id in elementId, and the material is left as it is. " +
      "actual then shows what it really is, so read it: when the colour you gave, in Shading or in Realistic, or the transparency you gave, differs from it, the item carries a warning and nothing was changed. A colour or a transparency you left out is not compared. " +
      "When every item already exists, nothing changes and no Undo step is added. already_existed still stands when the batch fails. " +
      "The same name twice in one list is refused. A name that differs from an existing one only in case is another name, as Revit takes it. " +
      "actual is { name, materialClass, colorRgb, appearanceColorRgb, transparency, appearanceTransparency, appearanceAssetId, useRenderAppearanceForShading }: " +
      "colorRgb is the colour of Shading and appearanceColorRgb the colour of Realistic, each { r, g, b } or null, and appearanceColorRgb is null for an appearance that has no single colour, such as one with a texture. " +
      "transparency is that of Shading and appearanceTransparency that of Realistic, both from 0 to 100, and appearanceTransparency is null for an appearance that has no transparency, such as the glass of the template. " +
      "Use the material in create_type, as the materialId of a layer. " +
      BATCH_RULES +
      " Related tools: list_materials, create_type, get_view_snapshot, save_project.",
    inputSchema: {
      items: batchOf(
        z
          .strictObject({
            name: z.string().min(1).describe("The exact name of the material. Russian is fine. Revit forbids some characters in names, such as { } [ ] | ; < > ? ` ~ \\ :"),
            baseMaterialId: elementId("The id of a material from list_materials to duplicate. Leave it out for a new material, which then needs colorRgb").optional(),
            colorRgb: z
              .strictObject({
                r: z.number().int().min(0).max(MAX_COLOR_CHANNEL),
                g: z.number().int().min(0).max(MAX_COLOR_CHANNEL),
                b: z.number().int().min(0).max(MAX_COLOR_CHANNEL),
              })
              .optional()
              .describe(`The colour as { r, g, b }, each a whole number from 0 to ${MAX_COLOR_CHANNEL}. Required without baseMaterialId.`),
            transparency: z
              .number()
              .int()
              .min(0)
              .max(MAX_TRANSPARENCY)
              .optional()
              .describe(`How see-through the material is, a whole number from 0, opaque, to ${MAX_TRANSPARENCY}. Left out: 0 for a new material, and that of the base for a copy.`),
          })
          .refine((item) => item.baseMaterialId !== undefined || item.colorRgb !== undefined, {
            message: "Give colorRgb, or baseMaterialId to take the colour of a material that exists.",
          }),
      ),
    },
  },
  {
    name: "create_type",
    description:
      "Creates wall, floor, ceiling and roof types in the active project as copies of a base type, with their own layers when layers is given. " +
      "category is walls, floors, ceilings or roofs, and baseTypeId is the id of a type of that category from list_types. Without layers the new type is an exact copy of the base type. " +
      "layers lists the layers of the structure, from the outside in for a wall and from the top down for a floor, ceiling or roof, and it replaces all the layers of the base type. " +
      "Each layer is { thicknessMm, materialId, function }: thicknessMm in millimetres, materialId from list_materials or create_materials, and function one of structure, substrate, insulation, finish1, finish2 and membrane. " +
      "A membrane layer has no thickness, so give it thicknessMm 0, and every other layer needs a thickness. Revit checks the whole stack before anything changes, and a stack it does not take, such as a layer that is too thin, is refused with the reason for each layer. " +
      "A base type that has no layers, such as a curtain wall or a glazed roof, cannot be given layers and is refused when layers is given. " +
      "A name that a type of the same family as the base type already has, matched exactly, gives status already_existed with that type's id in elementId, and the type is left as it is. " +
      "Another family may use the same name: a basic wall type can be named like a curtain wall type, and it is then a new type. " +
      "actual then shows what it really is, so read it: when its layers differ from the request, or from the base type if layers was left out, the item carries a warning and nothing was changed. " +
      "When every item already exists, nothing changes and no Undo step is added. already_existed still stands when the batch fails. " +
      "The same name twice in one list for one family of type is refused. " +
      "actual is { category, family, name, widthMm, layers }: widthMm is the total thickness of all layers in millimetres, and layers lists { thicknessMm, materialId, function } in the same order, " +
      "with a materialId of null for a layer that takes its material from the category. Both are null for a type with no layers. function can come back as a name outside the six above, for a layer copied from the base type. " +
      "A new type changes nothing in the model until an element uses it: take its elementId as typeId in create_walls or create_floors. " +
      BATCH_RULES +
      " Related tools: list_types, list_materials, create_materials, create_walls, create_floors, save_project.",
    inputSchema: {
      items: batchOf(
        z.strictObject({
          category: z.enum(["walls", "floors", "ceilings", "roofs"]).describe("The category of the type. These words stay the same whatever the language of Revit."),
          baseTypeId: elementId("The id of the type to copy, from list_types with the same category"),
          name: z.string().min(1).describe("The exact name of the new type. Russian is fine. Revit forbids some characters in names, such as { } [ ] | ; < > ? ` ~ \\ :"),
          layers: z
            .array(
              z.strictObject({
                thicknessMm: z.number().min(0).describe("The thickness of the layer in millimetres. 0 for a membrane, above 0 for any other layer."),
                materialId: elementId("The id of the material of the layer, from list_materials"),
                function: z.enum(LAYER_FUNCTIONS).describe("What the layer does. membrane is a thin sheet with no thickness."),
              }),
            )
            .min(1)
            .optional()
            .describe("The layers, from the outside in for a wall and from the top down for the others. Leave it out to copy the base type as it is."),
        }),
      ),
    },
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
    name: "create_ceilings",
    description:
      "Creates ceilings in the active project from outlines of straight edges. boundaryMm lists the corners in " +
      "millimetres in model coordinates, in either direction. The outline closes by itself from the last point to the " +
      `first, so do not repeat the first point: equal neighbouring points are refused. It needs at least ${MIN_OUTLINE_POINTS} points, ` +
      "and an outline that crosses or touches itself, or encloses no area, is refused. Take typeId from list_types with ceilings and levelId from get_model_info. " +
      "heightOffsetMm is required, and there is no default: it is the height of the underside of the ceiling above its level, in millimetres, and negative is below the level. " +
      "Revit puts a new ceiling 2600 mm above its level whatever the height of the storey, so this tool always writes the height you give, and fails the item if the ceiling does not have it once Revit has built it. " +
      "The thickness of the type goes up from the underside, and a basic ceiling type has none. " +
      "actual is { areaM2, heightOffsetMm, typeId, levelId, boundingBoxMm }: areaM2 is in square metres, heightOffsetMm is read back from the ceiling, " +
      "and boundingBoxMm is { min, max } in millimetres in model coordinates, so min.z is the underside: the elevation of the level plus heightOffsetMm. " +
      BATCH_RULES +
      " Related tools: list_types, get_model_info, get_elements, create_floors, save_project.",
    inputSchema: {
      items: batchOf(
        z.strictObject({
          boundaryMm: z.array(planPoint("A corner of the outline")).min(MIN_OUTLINE_POINTS).describe(`The corners of the outline, at least ${MIN_OUTLINE_POINTS}. It closes by itself.`),
          typeId: elementId("The id of a ceiling type from list_types"),
          levelId: elementId("The id of the level the ceiling hangs from"),
          heightOffsetMm: z
            .number()
            .describe("The height of the underside of the ceiling above the level, in millimetres. Required: Revit's own height is 2600. Negative is below the level."),
        }),
      ),
    },
  },
  {
    name: "create_floor_openings",
    description:
      "Cuts openings through floors of the active project, as for a stair or a shaft, one outline of straight edges for each. floorId is the id of a floor, from create_floors or from get_elements with floors. " +
      "boundaryMm lists the corners of the opening in millimetres in model coordinates, in either direction. The outline closes by itself from the last point to the " +
      `first, so do not repeat the first point: equal neighbouring points are refused. It needs at least ${MIN_OUTLINE_POINTS} points, ` +
      "and an outline that crosses or touches itself, or encloses no area, is refused. The cut goes straight down through the whole floor. " +
      "An opening may reach across the edge of the floor: it cuts what overlaps. An opening that cuts nothing, because it lies wholly outside the floor or inside an opening cut before it, " +
      "is accepted by Revit with no error, only a warning, so this tool reads the area of the floor before and after each opening, and an opening that takes no area off the floor fails its item: " +
      "the batch stops there and nothing lands, and error gives the two areas. The openings of a list are cut in order, so the same floor may appear in several items, and each one sees the area the earlier ones left. " +
      "An opening that covers the whole floor lands as created and leaves the floor with an area of 0, so read areaAfterM2: nothing is left of that floor, but it stays in the model as an element, and get_elements still gives it the box it had. " +
      "Revit adds the warning Opening not cutting anything for it, which is wrong there, and a later opening on such a floor fails, as it cuts nothing. " +
      "An opening that a later one in the same list encloses stays in the model with the status created, and the later one cuts only what was left of the floor, so areaAfterM2 of the earlier item is not the area of the floor at the end: floorAreaAfterCallM2 is. " +
      "actual is { floorId, areaBeforeM2, areaAfterM2, cutM2, floorAreaAfterCallM2, boundaryMm }: the first two areas are the area of the floor in square metres, read from the model, just before and just after this opening, and cutM2 is the difference. " +
      "floorAreaAfterCallM2 is the area of the floor after the whole call, so it differs from areaAfterM2 when a later item cut the same floor. " +
      "boundaryMm lists the start of each edge of the opening as Revit keeps it, as { x, y } in millimetres, and it is null if Revit keeps the opening as a plain rectangle, which it did not for a rectangular outline. elementId is the id of the opening, which is an element of its own. " +
      BATCH_RULES +
      " Related tools: create_floors, get_elements, get_warnings, save_project.",
    inputSchema: {
      items: batchOf(
        z.strictObject({
          floorId: elementId("The id of the floor to cut, from create_floors or get_elements with floors"),
          boundaryMm: z.array(planPoint("A corner of the opening")).min(MIN_OUTLINE_POINTS).describe(`The corners of the opening, at least ${MIN_OUTLINE_POINTS}. It closes by itself.`),
        }),
      ),
    },
  },
  {
    name: "create_ground",
    description:
      "Creates ground in the active project from outlines of straight edges, as a flat toposolid. boundaryMm lists the corners in millimetres in model coordinates, in either direction. " +
      "The outline closes by itself from the last point to the " +
      `first, so do not repeat the first point: equal neighbouring points are refused. It needs at least ${MIN_OUTLINE_POINTS} points, ` +
      "and an outline that crosses or touches itself, or encloses no area, is refused. Take typeId from list_types with toposolid, whose names are Russian and in the template end with the thickness, and levelId from get_model_info. " +
      "topOffsetMm is required: it is the height of the top surface of the ground above the level, in millimetres, and negative is below the level. The thickness of the type goes down from the top. " +
      "Put the top of the ground below the underside of every floor it reaches: a floor lies with its top on its level and its thickness below, so under a floor 300 mm thick on the level a top of -400 is clear. " +
      "A ground whose top is higher overlaps the floor, and Revit keeps the warning Highlighted toposolid and floor overlap. The tool does not refuse that and does not hide it: the call lands and the warning comes back in warnings, " +
      "so read warnings after every call, and get_warnings keeps listing it, with the ids of the ground and the floor. " +
      "actual is { topOffsetMm, typeId, levelId, boundingBoxMm }: topOffsetMm is read back from the ground, and boundingBoxMm is { min, max } in millimetres in model coordinates, so max.z is the top. " +
      BATCH_RULES +
      " Related tools: list_types, get_model_info, get_elements, get_warnings, create_floors, save_project.",
    inputSchema: {
      items: batchOf(
        z.strictObject({
          boundaryMm: z.array(planPoint("A corner of the outline")).min(MIN_OUTLINE_POINTS).describe(`The corners of the outline, at least ${MIN_OUTLINE_POINTS}. It closes by itself.`),
          levelId: elementId("The id of the level the ground is measured from"),
          topOffsetMm: z.number().describe("The height of the top surface of the ground above the level, in millimetres. Negative is below the level."),
          typeId: elementId("The id of a ground type from list_types with toposolid"),
        }),
      ),
    },
  },
  {
    name: "load_family",
    description:
      "Loads families from the library of this machine into the active project, the whole family or one named type of it. path is relative to the library folder, C:\\ProgramData\\Autodesk\\RVT 2027\\Libraries\\Russian. " +
      "It must name a .rfa file that exists there, with \\ or / between the names, and nothing outside the folder is reachable: a drive, a share, a rooted path or .. is refused. " +
      "The folder and file names are Russian, with spaces, and stay exactly as written, so copy them from the description of path, which names the folders that hold doors, windows, furniture, plumbing fixtures and plants. " +
      "Without typeName the whole family loads, with every type it has. With typeName only that type loads, and it is matched exactly: a type stored in the family, or a row of its type catalog, " +
      "which is the first column of the .txt file that has the name of the .rfa and lies beside it. A name that is neither fails the item, and the batch rolls back. " +
      "A family or a type that the project holds already, matched by the name of the family and the exact name of the type, is not loaded again: it gives status already_existed, and it is left as it is, because a reload would reset the sizes written on it. " +
      "A match is by the name of the family and not by its file. The name is taken from the file as it is on disk, so the same file spelled in lower case, or with the short names Windows makes of long ones, is the same family and not a second one, which Revit would make of a name in another case. " +
      "Another library file with the name of a family that is in the project is not loaded: a whole-family item for it gives already_existed with the types of the family that is there, " +
      "and an item with a typeName that the project does not hold fails, because Revit adds a type to a family only from the file that family came from (rows of AISC 15.0 into the family of AISC 14.1), and nothing changes. " +
      "This tool cannot tell which file the family in the project came from. " +
      "When every item already exists, nothing changes and no Undo step is added. already_existed still stands when the batch fails. " +
      "A family with a catalog that is already loaded, whole or in part, is reported as it is: name a row in typeName to load a row that is not there yet. " +
      "Loading a row of a family that is in the project already adds that row only, and leaves the other rows as they are, sizes included. " +
      "The same file twice in one list is refused, and so are two files of one name, the whole family together with a type of it, and one type twice; two different types of one family are fine. " +
      "SIZES: a type catalog has size columns, but Revit ignores them here, because their names are Russian and the names of the parameters follow the language of the interface. " +
      "So a door row called 800 x 2100 really is 850 x 2000, and a window row called 600 x 1200 is 600 x 900. This tool does not read the catalog, so read its sizes yourself and give them: " +
      "widthMm and heightMm, in millimetres, are written on the type named by typeName, as the Width and Height that Revit names as such, and read back from the type. They need typeName. " +
      "A type whose size Revit cannot write, such as the doors of the GOST folders, whose size the family computes, or a family with no width or height, fails the item after it was loaded, and the batch rolls back, so nothing stays loaded: leave that size out. " +
      "A size that Revit takes and reads back, but that moves nothing else in the type, fails the item too, and nothing stays loaded: the door and window openings of the library (bare openings with no leaf or sash) take a width and a height and cut at their Rough Width and Rough Height all the same. " +
      "Such a type needs no size here: place_hosted reads its rough size, and says so in a warning. " +
      "A type from a catalog that is loaded without widthMm and heightMm gets a warning with the size it really has. Revit also reports the ignored columns in warnings at the top, which is expected for a catalog. " +
      "A load brings the nested families of a family too, so a type that you did not ask for can appear in list_types. " +
      "actual is { familyId, typeIds }: familyId is the id of the family as Revit gave it back, and typeIds lists [{ id, name, widthMm, heightMm }] sorted by name, read from the project. " +
      "For a whole-family item it lists every type of the family, and for an item with typeName only that type. widthMm and heightMm are the Width and Height of the type in millimetres, or null for a type that has none, as furniture often has. " +
      "elementId is the id of the family for a whole-family item and the id of the type for an item with typeName. Take typeId for place_instances or place_hosted from typeIds. " +
      BATCH_RULES +
      " Related tools: place_instances, place_hosted, list_types, get_elements, create_walls, save_project.",
    inputSchema: {
      items: batchOf(
        z
          .strictObject({
            path: z
              .string()
              .min(1)
              .describe(
                "The family file, relative to the library folder, ending in .rfa, for example Russia\\Мебель\\Кровати\\Кровать-Стандарт.rfa. Russian names and spaces are kept as written. " +
                  "Under Russia the folders are Двери (doors), Окна (windows), Мебель (furniture), Сантехника (plumbing fixtures) and Озеленение (plants). Many families in Двери and Окна have a .txt type catalog beside them.",
              ),
            typeName: z
              .string()
              .min(1)
              .optional()
              .describe("The exact name of one type to load: a type stored in the family or a row of its type catalog, for example 800 x 2100 мм. Leave it out to load the whole family. The name is matched as written, with its Russian letters, its spaces and its case."),
            widthMm: z.number().positive().optional().describe("The width to write on the type, in millimetres. Needs typeName. Revit ignores the sizes of a type catalog, so give it when the width matters."),
            heightMm: z.number().positive().optional().describe("The height to write on the type, in millimetres. Needs typeName. Revit ignores the sizes of a type catalog, so give it when the height matters."),
          })
          .refine((item) => item.typeName !== undefined || (item.widthMm === undefined && item.heightMm === undefined), {
            message: "widthMm and heightMm are written on one type, so name it in typeName.",
          }),
      ),
    },
  },
  {
    name: "place_instances",
    description:
      "Places instances of loaded family types in the active project: furniture, fixtures, plants and the like, standing on a level or hanging on a wall. Take typeId from actual.typeIds of load_family, " +
      "or from list_types with furniture or plumbing; a type that is no family type is refused, and the refusal lists some that are. A door or window type is refused as well, before anything changes: use place_hosted for those, which checks the opening against the wall and confirms that it cuts it. " +
      "pointMm is { x, y } in millimetres in model coordinates, and levelId comes from get_model_info. The height of the instance is the elevation of the level plus elevationMm, 0 by default, " +
      "so on a level at 4000 an elevationMm of 0 stands at 4000. A family that keeps a height of its own does not take another one: a bed stands on its level, and a light fitting stands at the mounting height of its family. " +
      "Such an item fails after Revit placed it, and the error says at what height Revit put it, which is the elevationMm to ask for; a toilet that stands on the floor takes any. " +
      "rotationDeg turns the instance about the vertical through the point, in degrees counter-clockwise seen from above, and any number is taken. " +
      "The family decides how it is placed, and Revit names that its placement type. A family that stands on a level, such as a bed, a table, a toilet that is not on the wall or a tree, takes no hostWallId and no flipFacing. " +
      "A family that hangs on a wall, such as a sink, a bath or a wall-hung toilet, needs hostWallId, the id of a wall from create_walls or get_elements with walls, and a call without it is refused before anything changes, " +
      "because Revit would otherwise put it at a wrong place with no geometry and say nothing. Such an instance takes its direction from the wall, so rotationDeg is refused for it. " +
      "A family that hangs on something else, such as a recessed ceiling light, which the family says in its Host parameter, is refused before anything changes, and an instance that Revit made with some other host than that wall fails its item. " +
      "It stands on the axis of the wall, at the point of the axis nearest to pointMm, so a pointMm beside the wall is moved onto it and the item carries a warning that says by how much. " +
      "Its body lies on one side of the wall, the left of the direction from the start of the wall to its end, and flipFacing true puts it on the other side. " +
      "The height must be one the wall reaches, or the item is refused: a wall on another level is the usual cause, so check levelId. " +
      "Any other placement type, such as a family on a face or a work plane, is refused with its name. A type that is not active is activated and the model regenerated before its first instance. " +
      "After each instance is made, where it stands, how it is turned and its level are read from the model and compared with the request, and an instance that Revit put elsewhere fails its item, and the batch rolls back. " +
      "actual is { typeId, pointMm, elevationMm, rotationDeg, levelId, hostWallId, facingFlipped }: pointMm is { x, y } in millimetres as the model holds it, elevationMm is the height above levelId, " +
      "rotationDeg is from 0 up to, not including, 360, hostWallId is null for an instance with no host, and facingFlipped says whether flipFacing was done. Compare it with what you asked for. " +
      BATCH_RULES +
      " Related tools: load_family, list_types, get_model_info, create_walls, get_elements, delete_elements, save_project.",
    inputSchema: {
      items: batchOf(
        z.strictObject({
          typeId: elementId("The id of a family type, from actual.typeIds of load_family or from list_types"),
          pointMm: planPoint("Where the instance stands"),
          levelId: elementId("The id of the level the instance belongs to, from get_model_info"),
          elevationMm: z.number().default(0).describe("The height of the instance above its level, in millimetres. Negative is below the level."),
          rotationDeg: z.number().default(0).describe("The turn about the vertical through the point, in degrees counter-clockwise seen from above. Not for a family that hangs on a wall."),
          hostWallId: elementId("The id of the wall a wall-hung family hangs on. Required for such a family, and refused for one that stands on a level").optional(),
          flipFacing: z.boolean().default(false).describe("Puts a wall-hung instance on the other side of its wall. Only for a family with hostWallId."),
        }),
      ),
    },
  },
  {
    name: "place_hosted",
    description:
      "Places doors and windows in straight walls of the active project, each cutting an opening in its wall. Take typeId from list_types with doors or windows, or from actual.typeIds of load_family, and wallId from create_walls or get_elements with walls. " +
      "A type that is no door or window is refused, and so is one that hangs on a floor, a ceiling or a roof, which its family says in its Host parameter; what hangs on a wall without cutting it goes through place_instances. " +
      "offsetAlongWallMm is the distance in millimetres along the wall from its START to the CENTRE of the opening. The start is the first end of the centre line, startMm of create_walls and actual.startMm, so on a wall drawn from right to left the offset counts from the right. " +
      "The whole opening must lie in the wall: the offset minus half the width of the type is at least 0, and the offset plus half the width is at most the length of the wall. An opening that ends exactly at the end of the wall is allowed. " +
      "sillHeightMm is the height of the bottom of the opening, in millimetres, above the BASE LEVEL of the wall: the level the wall stands on, and not its foot, so on a wall with a base offset of -400 a sill of 0 is 400 above the foot. " +
      "A door takes 0 when sillHeightMm is left out. A window must be given one, and a window without it is refused. The sill that the family keeps is not used, for a door either. " +
      "The top of the opening, the sill plus the height of the type, must not pass the top of the wall where the opening stands, and its bottom must not lie below the foot of the wall. " +
      "The top of the wall is read from its real shape, on the axis of the wall, at the edge of the opening nearer the start, in the middle and at the edge nearer the end, and the lowest of the three counts: " +
      "a wall that follows a roof, such as the gable end that attach_walls raises, is high at its ridge and low at its eaves, and a window through the slope is refused, with the three tops in the message. " +
      "The highest point of the wall, topMm in get_elements, is no limit for a window. A top that bends more than that inside one opening is not followed. " +
      "The width and the height are those of the type, as the Width and Height that Revit names as such. A type that is a bare opening, such as the door and window openings of the library that have no leaf or sash, reads a Width and a Height of 0 " +
      "and keeps its size in its Rough Width and Rough Height: the wall is cut at that size, and the item carries a warning that says it was taken there. A size written into the Width of such a type changes nothing, " +
      "so load_family refuses widthMm and heightMm for it, and place_hosted does not read them. A type that says no size at all is refused naming it. " +
      "A row of a type catalog that was loaded without widthMm and heightMm has the size of its family, so give the size in load_family for a type whose Width and Height are above 0. " +
      "Openings may touch but not overlap. An opening that overlaps a door or window already in the same wall, or an earlier item of the same call, is refused. It counts only when the two share both a stretch along the wall and a stretch of height, so a window above a door does not overlap it. " +
      "Everything that can be known is checked before anything changes, and the call is refused naming the item and saying what was found: the length of the wall, its top, the element it overlaps. " +
      "That includes a curved wall and a curtain wall, which are refused by name. Revit would accept a doorway past the end of the wall, above its top or on top of another with no warning, which is why these are checked here. " +
      "The opening faces the LEFT of the direction of the wall, from its start to its end, whatever side of the wall the point lies on. For a wall drawn counter-clockwise round a house that is the inside, and the door swing lies on that side. " +
      "flipFacing true puts it on the other side. flipHand true turns its hand to the other direction along the wall, which for a door puts the hinges at the other end. Whether a type can flip is known only once an instance exists, so a flipFacing or flipHand that the type cannot do fails its item after the instance is made, and the batch rolls back: a fixed window cannot flip its hand. " +
      "A type that is not active is activated and the model regenerated before its first instance, because the first instance of a type does not otherwise cut its wall. " +
      "After each instance is made, its host, its place along the wall, its sill, its level and its flips are read from the model and compared with the request, and the wall must list it among its inserts. " +
      "An instance that Revit put elsewhere or that does not cut the wall fails its item, and the batch rolls back. " +
      "actual is { hostId, offsetAlongWallMm, sillHeightMm, facingFlipped, handFlipped, fromRoomId, toRoomId, cutsWall }, read from the model after the commit: offsetAlongWallMm is the distance from the start of the wall to the centre of the opening, " +
      "sillHeightMm is the sill above the base level of the wall, facingFlipped and handFlipped say whether the flips were done, and cutsWall says that the wall lists the instance among its inserts. " +
      "fromRoomId and toRoomId are the rooms the opening leads from and to, and they are null while there is no room on that side. " +
      BATCH_RULES +
      " Related tools: load_family, list_types, create_walls, get_elements, place_instances, delete_elements, undo_last_operation, get_view_snapshot, save_project.",
    inputSchema: {
      items: batchOf(
        z.strictObject({
          typeId: elementId("The id of a door or window type, from list_types with doors or windows or from actual.typeIds of load_family"),
          wallId: elementId("The id of a straight wall, from create_walls or get_elements with walls"),
          offsetAlongWallMm: z.number().describe("The distance in millimetres from the start of the wall to the centre of the opening, along the wall."),
          sillHeightMm: z
            .number()
            .optional()
            .describe("The height of the bottom of the opening above the base level of the wall, in millimetres. Optional for a door, which takes 0, and required for a window."),
          flipFacing: z.boolean().default(false).describe("Puts the opening on the other side of the wall: by default it faces the left of the direction from the start of the wall to its end."),
          flipHand: z.boolean().default(false).describe("Turns the hand of the door or window to the other direction along the wall; for a door the hinges go to the other end. Fails the item for a type that cannot flip its hand."),
        }),
      ),
    },
  },
  {
    name: "create_stairs",
    description:
      "Builds one staircase between two levels of the active project: straight with one run, or with two runs and a landing that Revit makes between them, such as a U-shaped staircase or one with a corner. " +
      "items holds exactly ONE staircase, unlike the other create_ tools, because Revit builds stairs in an edit mode of their own: send a second staircase in a second call. Take baseLevelId and topLevelId from get_model_info, and typeId from list_types with stairs. " +
      "runsMm lists the runs from the bottom up. startMm and endMm are the ends of the CENTRE LINE of a run, as { x, y } in millimetres in model coordinates, and a run climbs from startMm to endMm. The heights come from the levels and are worked out here, so no height is given. " +
      `desiredRisers is the number of risers of the whole staircase, from ${MIN_STAIRS_RISERS} to ${MAX_STAIRS_RISERS}. The height between the levels divided by it is the riser height, so it decides how steep the stairs are. widthMm is the width of each run, in millimetres, at most ${MAX_STAIRS_WIDTH_MM}, the widest Revit takes. ` +
      "The tread depth comes from the type, and the length of a run decides its risers: a run makes its length divided by the tread depth, rounded, plus 1, so a run of N risers is (N - 1) x tread depth long. 16 risers at a tread depth of 250 take a straight run of 3750. " +
      "The risers of the runs must add up to desiredRisers, and any split will do: 16 risers at 250 take two runs of 1750 and 1750, or 2250 and 1250. Anything else would leave stairs that stop short of the top level or run past it, which Revit accepts with only a warning, so it is refused before anything changes, and the refusal states the tread depth of the type and the length needed. " +
      "A length that rounds to the right number is taken, and Revit fits the run to the exact length from its start: 3740 becomes 3750. " +
      "The second run must go on from the end of the first: back beside it for U-shaped stairs, at a corner, or straight on. For U-shaped stairs of width 1000, start the second run level with the end of the first, with its axis 1100 away from the first, so 100 between them, and run it back. " +
      "The landing lies behind the end of the first run and is as deep as the runs are wide. Runs that overlap, cross or climb side by side in one direction cannot be joined. Revit decides that only once they exist, so such runs fail the item and nothing stays. " +
      "Runs far apart are joined all the same, by a landing across the whole gap, so keep them close and read footprintMm. " +
      "A run narrower than the minimum of the type and a riser above its maximum both land, and warnings says so, so read warnings. " +
      "Revit adds the railings of the stairs by itself, of its default railing type, so do not make any: their ids are in actual.railingIds. Stairs do not cut floors: make the hole with create_floor_openings on the floor of the upper level, and pass actual.footprintMm as its boundaryMm. Build the stairs first, as the footprint comes from them. " +
      "The whole call is one Undo step, railings and landing included. Input is checked before anything changes, and a problem refuses the call with an error naming the item and, for a bad id, the valid ones. Nothing is substituted. " +
      "Otherwise it returns { committed, items, warnings, errors, dialogs }, with one entry in items: { index, status, elementId, requested, actual, warnings, error }. Read committed first: when it is false the model did not change, unless errors says otherwise. " +
      "errors says otherwise when stairs are still in the model after a failure: then do not take them as gone, read the model, and ask the user to look at Revit, which may be left in edit mode. " +
      "created means the stairs are in the model. failed means Revit took the stairs and they did not come out as asked, and error says why: everything was cancelled and nothing stays, unless errors says otherwise. rolled_back means nothing stays, unless errors says otherwise, and the reason is in errors. " +
      "actual is { risers, riserHeightMm, treadDepthMm, topElevationMm, footprintMm, railingIds }, read from the model after the commit. risers counts what was built. topElevationMm is the height where the last run really ends, in millimetres in model coordinates, which must be that of the top level. " +
      "footprintMm lists the four corners, as { x, y }, of the rectangle that holds all the runs and the landing. elementId is the id of the stairs. The project then has unsaved changes. " +
      "Related tools: list_types, get_model_info, create_floor_openings, get_elements, undo_last_operation, get_view_snapshot, save_project.",
    inputSchema: {
      items: z
        .array(
          z.strictObject({
            baseLevelId: elementId("The id of the level the stairs start on, from get_model_info"),
            topLevelId: elementId("The id of the level the stairs reach, from get_model_info. It must lie above the base level"),
            typeId: elementId("The id of a stairs type, from list_types with stairs"),
            runsMm: z
              .array(z.strictObject({ startMm: planPoint("The bottom end of the centre line of the run"), endMm: planPoint("The top end of the centre line of the run") }))
              .min(1)
              .max(MAX_STAIRS_RUNS)
              .describe("The runs from the bottom up: one for straight stairs, two for stairs with a landing between them."),
            widthMm: z.number().positive().max(MAX_STAIRS_WIDTH_MM).describe("The width of each run, in millimetres."),
            desiredRisers: z.number().int().min(MIN_STAIRS_RISERS).max(MAX_STAIRS_RISERS).describe("The number of risers of the whole staircase. The risers of the runs must add up to it."),
          }),
        )
        .length(1)
        .describe("Exactly one staircase."),
    },
  },
  {
    name: "create_railings",
    description:
      "Makes railings in the active project, in two kinds of item. A stairs item is { stairsId, typeId, position }: railings on a stairs. A path item is { pathMm, typeId, levelId }: one railing along a path, such as round the opening of a stair in an upper floor. " +
      "Take typeId from list_types with railings, stairsId from create_stairs (its elementId) or from get_elements with stairs, and levelId from get_model_info. An item that has both stairsId and pathMm, or neither, is refused. " +
      "STAIRS: Revit adds railings to every new stairs by itself, so a stairs from create_stairs has them already, and the usual answer for a stairs item is already_existed. Nothing is changed, no Undo step is added when every item is like that, " +
      "and actual.railings lists the railings that are there with their real type, whatever typeId asked for. elementId is the lowest of their ids. If a railing is of another type than typeId, the item carries a warning that says which, and that the way to change the type of railings that exist is update_elements with their ids and the typeId: " +
      "Revit changes the type of a railing in place. position is not compared for railings that exist. " +
      "Railings are made on a stairs only where it has none, as after delete_elements removed them: on the sides of the stairs, all of the type asked for. position says where they stand: 'treads' puts them on the treads, inside the width of the run, " +
      "and 'stringer' puts them on the stringers, outside it. Each railing made is read back and must be hosted by that stairs and of that type, or the item fails and nothing stays. A stairs that Revit says cannot take new railings, " +
      "which for stairs with none means stairs in edit mode, is refused before anything changes. The same stairs twice in one list is refused. " +
      "PATH: pathMm lists the points of the path in millimetres in model coordinates, at least 2, and the edges join them in order, as straight lines. The path does not close by itself: repeat the first point as the last to close it, and leave out the side you want open, " +
      "such as where people arrive at the top of a stair. The height of the points does not matter: the railing stands on the level of levelId, and its height above the level is that of the type. " +
      "Revit judges the path before anything changes, and a path it does not take is refused naming the item: the edges must be continuous, and no three of them may meet at one point, which a point listed twice in the middle of the list makes. Neighbouring points closer than Revit can draw are refused as well. " +
      "To fence an opening made with create_floor_openings, pass the corners of its boundaryMm as pathMm, and levelId of the level the floor belongs to. " +
      "A railing along a path is read back after it is made: its type, and every edge of its path with the height of the level, are compared with the request, and one that does not match fails the item and nothing stays. " +
      "actual is { hostId, railings, pathMm, elevationMm }, read from the model after the commit. hostId is the stairs for a stairs item and null for a path. railings lists [{ id, typeId, typeName }], sorted by id: all the railings of the stairs, or the one railing of the path. " +
      "pathMm and elevationMm are for a path item and null for a stairs item: pathMm is the points of the path as the railing holds them, in millimetres, and elevationMm is the height of the path in model coordinates. " +
      "For this tool the batch rules read so: the item is one stairs or one path, but it can make several railings, and elementId is only the first of them: the others are in actual.railings. " +
      "already_existed means the stairs had railings, and nothing was made. " +
      BATCH_RULES +
      " Related tools: create_stairs, create_floor_openings, list_types, get_model_info, get_elements, delete_elements, undo_last_operation, get_view_snapshot, save_project.",
    inputSchema: {
      items: batchOf(
        z.union([
          z.strictObject({
            stairsId: elementId("The id of the stairs, from create_stairs or from get_elements with stairs"),
            typeId: elementId("The id of a railing type, from list_types with railings"),
            position: z.enum(RAILING_POSITIONS).describe("Where the railings stand: 'treads' inside the width of the run, 'stringer' outside it. Used only for stairs that have no railings."),
          }),
          z.strictObject({
            pathMm: z.array(planPoint("A point of the path")).min(MIN_RAILING_PATH_POINTS).describe(`The points of the path in order, at least ${MIN_RAILING_PATH_POINTS}. It does not close by itself: repeat the first point as the last to close it.`),
            typeId: elementId("The id of a railing type, from list_types with railings"),
            levelId: elementId("The id of the level the railing stands on, from get_model_info"),
          }),
        ]),
      ),
    },
  },
  {
    name: "create_rooms",
    description:
      "Creates rooms in the active project, one for each point, with a name and a number. A room is the closed region that walls and room separators (create_room_separators) draw round a point, " +
      "and its area is what that region really holds. Each item is { levelId, pointMm, name, number? }. Take levelId from get_model_info. pointMm is a point inside the space in millimetres in model coordinates, and its height comes from the level, " +
      "so give a point well inside the space, never on a wall. name is the name shown on the plan, and Russian is fine and stays exactly as written. number is optional text such as \"101\": leave it out and Revit numbers the room itself, " +
      "and actual.number says which number it chose. Revit accepts a number that two rooms share, and only warns Elements have duplicate \"Number\" values, so keep the numbers apart. " +
      "Revit does not refuse a room that encloses nothing: it makes a room with an area of 0 and a warning. So this tool reads the area of each room after Revit has built it, and a room with an area of 0 fails its item and nothing lands, the whole call rolls back, with error saying what to check. " +
      "That happens for a point outside a closed contour, for walls with a gap between them, for a point on the axis of a wall, for a level without walls, and for a second room in a region that has a room already: Revit allows one room to a region, " +
      "so a kitchen and a living room that share one space need create_room_separators between them first, and then a room in each half. A level that has no floor plan view still takes rooms, as long as walls stand on it. " +
      "actual is { name, number, areaM2, perimeterMm }, read from the model after the commit. areaM2 is in square metres and net of the walls: a box of walls 264 mm thick between axes 10000 x 6000 gives 9736 x 5736, so 55.85. " +
      "perimeterMm is in millimetres, along the faces of the walls. The height of the room is left to Revit and not reported: walls from 1000 to 3000 mm high gave the same area. " +
      "The area is read once more after the commit, and a created item is never a room of area 0: if Revit leaves a room with none, the item is failed with committed true, the rest of the batch landed, and error names the room, which stays in the model: take it away with delete_elements. Nothing has been seen to do this. " +
      BATCH_RULES +
      " Related tools: create_room_separators, create_walls, get_elements with rooms, get_model_info, delete_elements, undo_last_operation, save_project.",
    inputSchema: {
      items: batchOf(
        z.strictObject({
          levelId: elementId("The id of the level the room stands on, from get_model_info"),
          pointMm: planPoint("A point inside the space the room fills"),
          name: z.string().min(1).describe("The name of the room, shown on the plan. Russian is fine."),
          number: z.string().min(1).optional().describe("The number of the room as text, such as \"101\". Leave it out and Revit numbers the room itself."),
        }),
      ),
    },
  },
  {
    name: "create_room_separators",
    description:
      "Draws room separation lines: straight lines that close a room off where there is no wall, as between a kitchen and a living room in one open space. Each item is { levelId, startMm, endMm }: " +
      "the two ends of the line in millimetres in model coordinates, and its height comes from the level. Take levelId from get_model_info. " +
      "The line is drawn in the floor plan of its level, because Revit takes the level of a separator from the plan view it is drawn in. A level without a floor plan, as create_levels makes with createPlan false, " +
      "is refused before anything changes, naming the levels that have one. The view that happens to be open in Revit is never used. " +
      "A separator divides a room only if it runs from wall to wall: from the axis of one wall to the axis of another. A line that stops short of a wall divides nothing, " +
      "and Revit says nothing about that: the item still comes back created, with no warning. So after drawing, make the rooms with create_rooms, one on each side, and compare their areaM2 with what you expect. " +
      "A room that exists already is divided at once, and its area shrinks to its part; the other part is then a room to make with create_rooms. " +
      "Do not draw one line over another, or along an earlier one: Revit accepts it and warns Highlighted room separation lines overlap. One of them may be ignored when Revit finds room boundaries, and the warning stays in the model. " +
      "actual is { levelId, startMm, endMm }, read from the model after the commit. elementId is the separator: get_elements reads it by id, but no category word lists separators, so keep the ids. To take one away use delete_elements with its id, or undo_last_operation. " +
      BATCH_RULES +
      " Related tools: create_rooms, create_levels, create_walls, get_elements with rooms, get_warnings, delete_elements, undo_last_operation, save_project.",
    inputSchema: {
      items: batchOf(
        z.strictObject({
          levelId: elementId("The id of the level the line is drawn on, from get_model_info. It must have a floor plan"),
          startMm: planPoint("One end of the line"),
          endMm: planPoint("The other end of the line"),
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
    name: "update_elements",
    description:
      "Changes elements that exist in the active project, without deleting and rebuilding them: moves them, turns them, gives them another type and writes their parameters. " +
      "Each item is { id, moveMm?, rotateDeg?, typeId?, parameters? } and needs at least one of the four. Take id from the elementId of a create_ tool or from get_elements; the id does not change. " +
      "An id that is a type is refused: to change a type use create_type, load_family or the typeId of the elements. One element appears in one item only, so put everything wanted for it in that item. " +
      "Within an item the order is the move, the turn, the type and then the parameters, so a parameter written last wins over what a move did to it. " +
      "MOVE: moveMm is a vector { x, y, z } in millimetres in model coordinates, ADDED to where the element is, so { x: 500, y: 0, z: 0 } moves it 500 along the model's x. z is up. " +
      "A wall takes no z: Revit accepts a vertical move of a wall without a word and leaves it where it was, so a z other than 0 for a wall is refused, and a wall is raised or lowered with the parameters WALL_BASE_OFFSET and WALL_BASE_CONSTRAINT. " +
      "It works on what Revit places at a point or along a line: walls, doors, windows and furniture. A wall takes the doors and windows in it along. " +
      "A wall that is joined to others at its ends keeps those ends on its neighbours: a move across the wall works and its neighbours stretch to follow, but the part of a move that runs along the wall is not applied. " +
      "Revit accepts that without a word, so the item fails, saying the wall is joined, and the call is rolled back. Walls of a closed contour therefore cannot be shifted one by one along themselves. " +
      "A door or window stands on the axis of its wall: it moves along the wall and up, and a move across the wall is accepted by Revit with no word and leaves it where it was, so it is refused, saying which way the wall runs. " +
      "A move along the wall that takes the opening past the end of the wall is judged by Revit only at the commit: the call then comes back with committed false, the item rolled_back and the reason in errors. " +
      "A floor, a roof, a ceiling or a railing takes its place from a sketch or a path and has no point or line, so it is refused, naming it. A pinned element is refused: a pin is put on purpose, so ask the user before taking it off, which is a call of its own that writes false to the parameter ELEMENT_LOCKED_PARAM (true pins an element), and the move comes after it. " +
      "ROTATE: rotateDeg is in degrees, counter-clockwise seen from above, and is ADDED to the turn the element has, so turning 90 twice gives 180. Any number is taken, 360 is nothing, and a negative one turns clockwise. " +
      "The axis is vertical. For an element with a point, such as furniture, it passes through that point, the same turn as rotationDeg of place_instances, so the element stays where it is. " +
      "For an element along a line, such as a wall, it passes through the middle between the two ends of its axis, and the doors and windows in the wall turn with it, each at the same distance along the wall. " +
      "A wall that is joined to others at its ends cannot be turned either: Revit keeps the joined ends on its neighbours, so it refuses the turn at the commit (the call comes back committed false with the item rolled_back and the reason in errors), or lands the wall off the line asked for and the item fails. " +
      "A door, a window or a fixture that hangs on a wall takes its direction from that wall and is refused: turn the wall. " +
      "TYPE: typeId is the id of a type from list_types or from actual.typeIds of load_family. Revit's ChangeTypeId changes the type in place, so the element keeps its id, and this is how the type of railings that exist is changed (create_railings only reports a railing of another type). " +
      "Revit is asked first whether the type is valid for the element, and a type that is not is refused with the types that are. A wall given a curtain wall type, or the other way, keeps its id. " +
      "A wall that holds doors or windows is refused a curtain wall type, naming them, because Revit would delete every one of them and only warn: take them away with delete_elements first, where dryRun shows what goes. " +
      "If Revit does answer with a new element in place of the old one, which its documentation says happens in rare cases, the item fails and the call is rolled back. A member of a group is refused. " +
      "PARAMETERS: a list of { builtIn, value }. builtIn is the name of Revit's BuiltInParameter, written as its enum writes it and case-sensitive: WALL_USER_HEIGHT_PARAM is the unconnected height of a wall, WALL_BASE_OFFSET its base offset, " +
      "WALL_BASE_CONSTRAINT its base level, WALL_HEIGHT_TYPE its top constraint, WALL_KEY_REF_PARAM its location line, ALL_MODEL_MARK the mark and ALL_MODEL_INSTANCE_COMMENTS the comments of any element. Localized names are not used. " +
      "value depends on what the parameter holds. A length is a number of millimetres. Text is a string, Russian included. A whole number is a number without a fraction, and a yes/no parameter takes true or false. " +
      "A parameter that holds an element takes the id of that element as a string, and Revit takes the id of ANY element for it without a word: a wall was stored as the top constraint of a wall, as the level of a bed and as a phase. " +
      "So only the parameters that take a level are written, each given the id of a level from get_model_info, and anything else is refused before anything changes: WALL_BASE_CONSTRAINT (the base level of a wall), WALL_HEIGHT_TYPE (its top constraint), " +
      "FAMILY_LEVEL_PARAM (the level of an instance) and LEVEL_PARAM (the level of a floor and the like). The parameters that change a type, ELEM_TYPE_PARAM, ELEM_FAMILY_AND_TYPE_PARAM, ELEM_FAMILY_PARAM and SYMBOL_ID_PARAM, are refused with a pointer to typeId, " +
      "and the phases, PHASE_CREATED and PHASE_DEMOLISHED, are not written at all. A parameter cannot be cleared, since -1 names no element: a wall whose top constraint is a level cannot go back to Unconnected with this tool, so set WALL_HEIGHT_TYPE only when the wall should follow a level. " +
      "Setting the top constraint also sets the unconnected height, WALL_USER_HEIGHT_PARAM, so do not write both for one wall in one item: written in that order the top constraint overwrites the height, and the item fails. " +
      "A yes/no parameter takes true, false, 0 or 1, and any other number is refused. " +
      "A number that is not a length, such as an angle, an area, a volume or a slope, has a unit this tool does not convert, so it is refused naming its spec, and nothing is written as if it were millimetres. " +
      "The same name twice in one item is refused. A name that is no BuiltInParameter, a parameter the element does not have, a read-only one and a value of the wrong kind are all refused. " +
      "A parameter of the type of the element, such as the width of a wall type, is not the element's own: it is refused as one the element does not have, because a type is not written here and the write would change every element of that type. Parameters are checked against the element as it is before the call, and written after the type changes. " +
      "Everything that can be known is checked before anything changes, and the call is refused naming the item and saying what was found. " +
      "What only Revit can say is found out while it works: after each stage the element is read back from the model and compared with the request, a move by where the element stands, a turn by how it is turned, " +
      "a type by its type and a parameter by its value, and at the end of the item its type and parameters are read once more, because Revit changes some parameters when it is given another and a later one can undo an earlier one. " +
      "An item that does not hold fails, the error says what Revit did instead, and the whole call is rolled back. " +
      "For this tool a failed item with committed true, the exception in the rules below, is not always a removed element: what still differs only after the commit, which the model alone shows, comes back with committed true and that item failed with its element named in the error: the change of that item is in the model, as one Undo step with the rest of the batch, so read the element with get_elements. " +
      "actual is { typeId, typeName, pointMm, rotationDeg, startMm, endMm, parameters }, read from the model after the commit. pointMm is { x, y, z } and rotationDeg is from 0 up to, not including, 360, for an element with a point, and null otherwise. " +
      "startMm and endMm are the ends of the axis of an element along a line, such as a wall, as { x, y, z }, and null otherwise. All are in millimetres in model coordinates. " +
      "parameters lists every parameter asked for as [{ builtIn, value }], the value as the model holds it and in the units of the request: a length in millimetres, text as text, a yes/no as true or false, an element as its id. " +
      "Compare it with what you asked for. " +
      "For this tool the batch rules read so: updated stands where created does, the element is in the model and holds what was asked, and it is the element that was there, so elementId is the id you gave. " +
      "unchanged means the element held everything the item asked for already: the type was the type, every parameter was at its value, and the move and the turn were nothing. " +
      "Nothing is done for it, and when every item is unchanged no Undo step is added, so do not call undo_last_operation after such a call: it would take back the operation before it, which cannot be redone. Its actual was read before the call began. " +
      "A rolled_back item has elementId null although the element exists, because the change is what is not in the model. already_existed is not used. " +
      BATCH_RULES +
      " Related tools: get_elements, list_types, create_walls, place_hosted, place_instances, create_railings, delete_elements, undo_last_operation, get_view_snapshot, save_project.",
    inputSchema: {
      items: z
        .array(
          z
            .strictObject({
              id: elementId("The id of the element to change, from a create_ tool or from get_elements. A type is refused"),
              moveMm: z
                .strictObject({ x: z.number(), y: z.number(), z: z.number() })
                .optional()
                .describe("The vector to move the element by, as { x, y, z } in millimetres in model coordinates. It is added to where the element is. z is up."),
              rotateDeg: z
                .number()
                .optional()
                .describe("The turn to add to the one the element has, in degrees counter-clockwise seen from above, about the vertical through its point, or through the middle of its axis for a wall."),
              typeId: elementId("The id of the type to give the element, from list_types or actual.typeIds of load_family. The element keeps its id").optional(),
              parameters: z
                .array(
                  z.strictObject({
                    builtIn: z.string().min(1).describe("The name of a BuiltInParameter, case-sensitive, such as WALL_USER_HEIGHT_PARAM."),
                    value: z
                      .union([z.number(), z.string(), z.boolean()])
                      .describe("The value: a number of millimetres for a length, text for text, a whole number for a whole number (true or false for a yes/no), the id of an element as a string for a parameter that holds an element."),
                  }),
                )
                .min(1)
                .optional()
                .describe("The parameters to write, each once."),
            })
            .refine((item) => item.moveMm !== undefined || item.rotateDeg !== undefined || item.typeId !== undefined || item.parameters !== undefined, {
              message: "An item needs at least one of moveMm, rotateDeg, typeId and parameters.",
            }),
        )
        .min(1)
        .max(MAX_BATCH_ITEMS)
        .describe(`The items to change, from 1 to ${MAX_BATCH_ITEMS}.`),
    },
  },
  {
    name: "delete_elements",
    description:
      "Deletes elements of the active project by id, or shows what a delete would take. dryRun is true unless you pass false, so a call that leaves it out deletes nothing. " +
      "Use it that way first: Revit also deletes everything that depends on an element, without asking. A level takes the walls, floors and views on it, and a wall type takes every wall of that type. " +
      "A dry run really runs the delete in Revit and rolls it back: the model, the Undo history and the unsaved state stay as they were. It stops before Revit's final check at commit, so a real delete can still be refused. " +
      `Take 1 to ${MAX_ELEMENT_IDS} ids from other tools. An id asked twice counts once. The whole list is checked first: text that cannot be an id, an id with no element, or an element Revit cannot delete refuses the call, naming the ids, and nothing changes. ` +
      "Revit will not delete the view open in its window, the level that view belongs to, or its own internal elements. And each id can pass and the list still be refused as a whole, as every wall type at once was: that comes back as committed false with the reason in errors. " +
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
      "when the last change in the project came from somewhere else, such as the user in Revit, because Undo would take that instead. Then read the refusal: only the user can undo their own change, and it costs them that change, " +
      "so ask them only when the refusal says an operation of these tools lies below it; " +
      "when the undo history of the project was lost, or recording its changes failed: the refusal says for how long, and asking the user to undo does not help; " +
      "when the last operation of these tools lies in another project: make that one active with open_project first; and when an earlier undo is not settled. " +
      "A failed call can also say that Revit undid something else instead of what was asked: that step is gone, so read the model again before you go on. " +
      "A failed call that starts with Not undone means Revit refused the undo it was given, which it does now and then: the model did not change, and you can call this again at once. " +
      "When the text of a failed call says it is not known what became of the undo, do not call this again blindly, as it would take the next operation: " +
      "ask get_last_undo_result first. After an undo the project may read as saved or as changed, whichever is true: see isModified in get_model_info. There is no redo tool. " +
      "Related tools: get_last_undo_result, delete_elements, get_model_info.",
    inputSchema: {},
    run: undoLastOperation,
  },
  {
    name: "get_last_undo_result",
    description:
      "Says what became of the last undo posted in this Revit session, without undoing anything. undo_last_operation already asks this itself, so call it only after that tool reported no confirmation, such as after a timeout. " +
      "Returns { state, undoId, transactionName, createdIds, restoredIds, documentTitle, otherName, otherDocumentTitle }. state undone means Revit reported that undo, and the other keys mean what they mean there. " +
      "An empty createdIds does not prove that nothing was created: a step Revit redid after this plugin lost track of it is known by name only, so read the model when it matters. " +
      "refused means Revit had its turn with the undo and reported none, which is how it refuses one: the model did not change, nothing is pending, and undo_last_operation can be called again at once. " +
      "other means that while it waited Revit undid something else: otherName and otherDocumentTitle say what, createdIds and restoredIds are about that if known, and transactionName, what was asked for, is probably still in the model, but this answer is final and a parked undo could still run later, so read the model first. " +
      "unknown means that a change could not be recorded while it waited, so it may have happened: read the model. " +
      "none means no undo was posted since Revit or the plugin last started, and the other keys are then empty. " +
      "An undo is reported as what it was asked to take. A change that a person undid in Revit is not an undo of these tools, so it does not show here. " +
      "It waits for Revit like any model request, and it also lets a command Revit is holding go first. Related tools: undo_last_operation, get_model_info.",
    inputSchema: {},
  },
];
