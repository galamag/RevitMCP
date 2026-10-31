import assert from "node:assert/strict";
import { copyFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { checkCanClose } from "../../src/cli/closeRule.ts";
import { BridgeClient } from "../../src/client.ts";
import { defaultConnectionPath } from "../../src/connection.ts";
import { undoLastOperation } from "../../src/undo.ts";

// The acceptance of stage 2: a house with a roof on a test model, a snapshot of it, one operation undone in one step,
// and an error in a batch that leaves nothing. It needs a running Revit with the RevitMCP plugin loaded. Each run creates
// one new project in the test folder and leaves it open and saved, so the house can be looked at afterwards.

interface OpenDocument {
  title: string;
  path: string;
  isModified: boolean;
}

interface Level {
  id: string;
  name: string;
  elevationMm: number;
}

interface ModelView {
  id: string;
  name: string;
  viewType: string;
}

interface ModelInfo {
  activeDocument: OpenDocument | null;
  openDocuments: OpenDocument[];
  levels: Level[];
  views: ModelView[];
  categoryCounts: Array<{ category: string | null; count: number }>;
}

interface TypeRow {
  id: string;
  family: string;
  name: string;
}

interface Point {
  x: number;
  y: number;
}

interface Box {
  min: { x: number; y: number; z: number };
  max: { x: number; y: number; z: number };
}

interface ElementRow {
  id: string;
  category: string | null;
  typeName: string | null;
  levelId: string | null;
  boundingBoxMm: Box | null;
  topMm?: number | null;
}

interface RoofEdge {
  startMm: Point;
  endMm: Point;
  definesSlope: boolean;
  slopeDeg: number | null;
  eaveOffsetMm: number;
}

interface Item {
  status: string;
  elementId: string | null;
  actual: Record<string, unknown> | null;
  error: string | null;
}

interface Batch {
  committed: boolean;
  items: Item[];
  warnings: string[];
  errors: string[];
  dialogs: unknown[];
}

interface CreatedView {
  committed: boolean;
  viewId: string;
  name: string;
  displayStyle: string;
  warnings: string[];
  errors: string[];
  dialogs: unknown[];
}

interface Snapshot {
  viewId: string;
  viewName: string;
  path: string;
  dialogs: unknown[];
}

/** What the later tests need from the first one. */
interface House {
  wallType: TypeRow;
  ground: Level;
  wallIds: string[];
  roofId: string;
  viewTemplateId: string;
  wallTopMm: number;
}

const NEAR_MM = 0.01;
/** How close a height read from a bounding box should be, as roofs round to Revit's own tolerance. */
const ROOF_NEAR_MM = 1;
const SLOPE_NEAR_DEG = 0.001;

/** The outline runs along the centre lines of the walls. */
const WIDTH_MM = 12000;
const DEPTH_MM = 9000;
const SLOPE_DEG = 30;
/** Wider than half a wall, so the whole thickness of the walls lies under the roof and they can follow it. */
const OVERHANG_MM = 600;
const SECOND_FLOOR_MM = 3300;
const WALL_TOP_MM = 6600;
/** The land lies this far below the first floor, and the walls reach down to it. Past the thickness of the floor, or Revit warns that two floors overlap. */
const PLINTH_MM = 400;
/** How far the land reaches past the house, so the shadow has somewhere to fall and its edge stays out of the picture. */
const LAND_MARGIN_MM = 40000;

const SNAPSHOT_WIDTH_PX = 1600;
const VIEW_NAME = "Дом с юго-востока";
const EYE_MM = { x: 28000, y: -19000, z: 9000 };
const TARGET_MM = { x: 6000, y: 4500, z: 3600 };

const OUTLINE: Point[] = [
  { x: 0, y: 0 },
  { x: WIDTH_MM, y: 0 },
  { x: WIDTH_MM, y: DEPTH_MM },
  { x: 0, y: DEPTH_MM },
];

const stamp = new Date().toTimeString().slice(0, 8).replaceAll(":", "");
const name = `дом-приёмка-${stamp}`;
const snapshotFolder = path.join(homedir(), "Documents", "RevitMCP", "task14-acceptance");

let house: House | undefined;

async function withClient<T>(body: (client: BridgeClient) => Promise<T>): Promise<T> {
  const client = new BridgeClient(defaultConnectionPath());
  try {
    return await body(client);
  } finally {
    client.close();
  }
}

const modelInfo = (client: BridgeClient): Promise<ModelInfo> => client.call("get_model_info", {}) as Promise<ModelInfo>;

const call = (client: BridgeClient, method: string, items: unknown[]): Promise<Batch> => client.call(method, { items }) as Promise<Batch>;

const tan = (degrees: number): number => Math.tan((degrees * Math.PI) / 180);

function built(): House {
  assert.ok(house, "the first test builds the house");
  return house;
}

/** Types are chosen by their name in the template, so the picture shows real materials: a timber wall draws its colour, a brick one came out plain white. */
async function typeNamed(client: BridgeClient, category: string, pattern: RegExp): Promise<TypeRow> {
  const types = (await client.call("list_types", { category })) as TypeRow[];
  const found = types.find((type) => pattern.test(type.name));
  assert.ok(found, `no ${category} type matches ${pattern}`);

  return found;
}

async function readElements(client: BridgeClient, ids: Array<string | null>): Promise<ElementRow[]> {
  const { elements, notFound } = (await client.call("get_elements", { ids })) as { elements: ElementRow[]; notFound: string[] };
  assert.deepEqual(notFound, []);
  return elements;
}

function assertNear(actual: unknown, expected: number, what: string, within = NEAR_MM): void {
  assert.equal(typeof actual, "number", what);
  assert.ok(Math.abs((actual as number) - expected) < within, `${what}: ${String(actual)}, expected ${expected}`);
}

function assertLanded(batch: Batch): void {
  assert.equal(batch.committed, true, JSON.stringify(batch));
  assert.deepEqual(batch.errors, []);
  assert.deepEqual(batch.dialogs, []);
  assert.deepEqual(batch.warnings, [], "this house should give Revit nothing to warn about");
}

function idsOf(batch: Batch): string[] {
  return batch.items.map((item) => {
    assert.equal(item.status, "created", JSON.stringify(item));
    assert.ok(item.elementId);
    return item.elementId;
  });
}

function countOf(info: ModelInfo, category: string): number {
  return info.categoryCounts.find((entry) => entry.category === category)?.count ?? 0;
}

async function createView(client: BridgeClient, viewTemplateId: string): Promise<string> {
  const created = (await client.call("create_3d_view", {
    name: VIEW_NAME,
    kind: "perspective",
    displayStyle: "realistic",
    eyeMm: EYE_MM,
    targetMm: TARGET_MM,
    viewTemplateId,
    sunAzimuthDeg: 135,
    sunAltitudeDeg: 45,
  })) as CreatedView;
  console.log(`# view: ${JSON.stringify(created)}`);

  assert.equal(created.committed, true, JSON.stringify(created));
  assert.equal(created.name, VIEW_NAME);
  assert.equal(created.displayStyle, "realistic");
  assert.deepEqual(created.errors, []);
  assert.deepEqual(created.dialogs, []);

  return created.viewId;
}

/** The time of day is in the name, so a file of an earlier run is never overwritten. */
async function keepSnapshot(client: BridgeClient, viewId: string, title: string): Promise<void> {
  const snapshot = (await client.call("get_view_snapshot", { viewId, widthPx: SNAPSHOT_WIDTH_PX })) as Snapshot;
  await mkdir(snapshotFolder, { recursive: true });
  const kept = path.join(snapshotFolder, `${title}-${stamp}.png`);
  await copyFile(snapshot.path, kept);
  console.log(`# snapshot ${title}: ${kept}`);

  assert.equal(snapshot.viewId, viewId);
  assert.equal(snapshot.viewName, VIEW_NAME);
  assert.deepEqual(snapshot.dialogs, []);
}

describe("stage 2 acceptance: a house with a roof", { timeout: 300_000 }, () => {
  it("builds a house box", async () => {
    await withClient(async (client) => {
      const created = (await client.call("create_project", { name })) as { path: string; dialogs: unknown[] };
      assert.equal(path.win32.basename(created.path), `${name}.rvt`);
      assert.deepEqual(created.dialogs, []);

      const start = await modelInfo(client);
      console.log(`# project: ${JSON.stringify(start.activeDocument)}, template levels: ${JSON.stringify(start.levels)}`);
      assert.equal(start.activeDocument?.title, name);
      assert.equal(start.activeDocument?.path, created.path);

      const ground = start.levels.find((level) => level.elevationMm === 0);
      assert.ok(ground, `no level at the origin in ${JSON.stringify(start.levels)}`);

      const wallType = await typeNamed(client, "walls", /^Наружный - Стена из бруса толщиной 180 мм/);
      const floorType = await typeNamed(client, "floors", /^Типовой 300мм$/);
      const landType = await typeNamed(client, "floors", /^Монолитный бетон/);
      const roofType = await typeNamed(client, "roofs", /^Теплая крыша - Деревянный брус$/);
      console.log(`# types: ${JSON.stringify([wallType, floorType, landType, roofType])}`);

      // Levels: the floor of the second storey and the top of the walls, and the land below the house.
      const wanted = [
        { name: "Второй этаж", elevationMm: SECOND_FLOOR_MM },
        { name: "Верх стен", elevationMm: WALL_TOP_MM },
        { name: "Земля", elevationMm: -PLINTH_MM, createPlan: false },
      ];
      const levels = await call(client, "create_levels", wanted);
      console.log(`# levels: ${JSON.stringify(levels)}`);
      assertLanded(levels);
      const [secondId, topId, landId] = idsOf(levels);
      assert.ok(secondId && topId && landId);

      for (const [index, level] of wanted.entries()) {
        assert.equal(levels.items[index]?.actual?.["name"], level.name);
        assertNear(levels.items[index]?.actual?.["elevationMm"], level.elevationMm, `elevation of ${level.name}`);
      }

      const levelRows = (await modelInfo(client)).levels;
      assert.deepEqual(
        wanted.map((level) => levelRows.find((row) => row.name === level.name)?.id),
        [secondId, topId, landId],
      );
      assert.deepEqual(
        (await readElements(client, [secondId, topId, landId])).map((row) => row.category),
        ["OST_Levels", "OST_Levels", "OST_Levels"],
      );

      // Walls: the top is tied to a level, and the foot reaches down to the land.
      const walls = await call(
        client,
        "create_walls",
        OUTLINE.map((startMm, index) => ({
          startMm,
          endMm: OUTLINE[(index + 1) % OUTLINE.length],
          typeId: wallType.id,
          levelId: ground.id,
          topLevelId: topId,
          baseOffsetMm: -PLINTH_MM,
        })),
      );
      console.log(`# walls: ${JSON.stringify(walls)}`);
      assertLanded(walls);
      const wallIds = idsOf(walls);
      assert.equal(wallIds.length, 4);

      const wallWidths = new Set(walls.items.map((item) => item.actual?.["widthMm"]));
      assert.equal(wallWidths.size, 1);
      const [wallWidth] = wallWidths;
      assert.equal(typeof wallWidth, "number");
      const halfWall = (wallWidth as number) / 2;
      assert.ok(OVERHANG_MM > halfWall, `the overhang should be wider than half a wall of ${String(wallWidth)}`);

      for (const [index, item] of walls.items.entries()) {
        const start = OUTLINE[index];
        const end = OUTLINE[(index + 1) % OUTLINE.length];
        assert.ok(start && end);
        const actual = item.actual as Record<string, Point | number | string>;

        assert.deepEqual([actual["typeId"], actual["levelId"], actual["topLevelId"]], [wallType.id, ground.id, topId]);
        assertNear((actual["startMm"] as Point).x, start.x, `start x of wall ${index}`);
        assertNear((actual["startMm"] as Point).y, start.y, `start y of wall ${index}`);
        assertNear((actual["endMm"] as Point).x, end.x, `end x of wall ${index}`);
        assertNear((actual["endMm"] as Point).y, end.y, `end y of wall ${index}`);
        assertNear(actual["lengthMm"], Math.hypot(end.x - start.x, end.y - start.y), `length of wall ${index}`);
        assertNear(actual["heightMm"], WALL_TOP_MM + PLINTH_MM, `height of wall ${index}`);
        assertNear(actual["baseOffsetMm"], -PLINTH_MM, `foot of wall ${index}`);
      }

      const wallRows = await readElements(client, wallIds);
      console.log(`# walls read back: ${JSON.stringify(wallRows)}`);
      for (const [index, wall] of wallRows.entries()) {
        assert.equal(wall.category, "walls");
        assert.equal(wall.typeName, wallType.name, "a Cyrillic type name comes back unchanged");
        assert.equal(wall.levelId, ground.id);
        assertNear(wall.topMm, WALL_TOP_MM, `top of wall ${index}`);
        assertNear(wall.boundingBoxMm?.min.z, -PLINTH_MM, `foot of wall ${index}`);
      }

      // Together the walls fill the outer rectangle exactly, half a wall outside the outline.
      const boxes = wallRows.map((wall) => wall.boundingBoxMm as Box);
      assertNear(Math.min(...boxes.map((box) => box.min.x)), -halfWall, "the west face");
      assertNear(Math.max(...boxes.map((box) => box.max.x)), WIDTH_MM + halfWall, "the east face");
      assertNear(Math.min(...boxes.map((box) => box.min.y)), -halfWall, "the south face");
      assertNear(Math.max(...boxes.map((box) => box.max.y)), DEPTH_MM + halfWall, "the north face");

      // Floors: one on each storey, and the land the shadow falls on.
      const landOutline = [
        { x: -LAND_MARGIN_MM, y: -LAND_MARGIN_MM },
        { x: WIDTH_MM + LAND_MARGIN_MM, y: -LAND_MARGIN_MM },
        { x: WIDTH_MM + LAND_MARGIN_MM, y: DEPTH_MM + LAND_MARGIN_MM },
        { x: -LAND_MARGIN_MM, y: DEPTH_MM + LAND_MARGIN_MM },
      ];
      const floors = await call(client, "create_floors", [
        { boundaryMm: OUTLINE, typeId: floorType.id, levelId: ground.id },
        { boundaryMm: OUTLINE, typeId: floorType.id, levelId: secondId },
        { boundaryMm: landOutline, typeId: landType.id, levelId: landId },
      ]);
      console.log(`# floors: ${JSON.stringify(floors)}`);
      assertLanded(floors);
      const floorIds = idsOf(floors);

      const area = (WIDTH_MM * DEPTH_MM) / 1_000_000;
      const landArea = ((WIDTH_MM + 2 * LAND_MARGIN_MM) * (DEPTH_MM + 2 * LAND_MARGIN_MM)) / 1_000_000;
      assertNear(floors.items[0]?.actual?.["areaM2"], area, "area of the first floor");
      assertNear(floors.items[1]?.actual?.["areaM2"], area, "area of the second floor");
      assertNear(floors.items[2]?.actual?.["areaM2"], landArea, "area of the land");

      const floorRows = await readElements(client, floorIds);
      console.log(`# floors read back: ${JSON.stringify(floorRows)}`);
      assert.deepEqual(floorRows.map((floor) => [floor.category, floor.levelId]), [["floors", ground.id], ["floors", secondId], ["floors", landId]]);
      assert.deepEqual(floorRows.map((floor) => floor.typeName), [floorType.name, floorType.name, landType.name]);
      assertNear(floorRows[0]?.boundingBoxMm?.max.z, 0, "top of the first floor");
      assertNear(floorRows[1]?.boundingBoxMm?.max.z, SECOND_FLOOR_MM, "top of the second floor");
      assertNear(floorRows[2]?.boundingBoxMm?.max.z, -PLINTH_MM, "top of the land");
      assertNear(floorRows[0]?.boundingBoxMm?.max.x, WIDTH_MM, "east edge of the first floor");

      // A hip roof on the level at the top of the walls.
      const roofs = await call(client, "create_roof", [
        { outlineMm: OUTLINE, levelId: topId, typeId: roofType.id, overhangMm: OVERHANG_MM, edgeSlopesDeg: [SLOPE_DEG, SLOPE_DEG, SLOPE_DEG, SLOPE_DEG] },
      ]);
      console.log(`# roof: ${JSON.stringify(roofs)}`);
      assertLanded(roofs);
      const [roofId] = idsOf(roofs);
      assert.ok(roofId);

      const edges = roofs.items[0]?.actual?.["edges"] as RoofEdge[];
      assert.equal(edges.length, 4);
      for (const [index, edge] of edges.entries()) {
        assert.equal(edge.definesSlope, true, `edge ${index}`);
        assertNear(edge.slopeDeg, SLOPE_DEG, `slope of edge ${index}`, SLOPE_NEAR_DEG);
        assertNear(edge.eaveOffsetMm, -OVERHANG_MM * tan(SLOPE_DEG), `eave of edge ${index}`);
      }

      const [roof] = await readElements(client, [roofId]);
      console.log(`# roof read back: ${JSON.stringify(roof)}`);
      assert.equal(roof?.category, "roofs");
      assert.equal(roof?.typeName, roofType.name);
      assert.equal(roof?.levelId, topId);

      const box = roof?.boundingBoxMm;
      assert.ok(box);
      assertNear(box.min.x, -OVERHANG_MM, "west eave", ROOF_NEAR_MM);
      assertNear(box.max.x, WIDTH_MM + OVERHANG_MM, "east eave", ROOF_NEAR_MM);
      assertNear(box.min.y, -OVERHANG_MM, "south eave", ROOF_NEAR_MM);
      assertNear(box.max.y, DEPTH_MM + OVERHANG_MM, "north eave", ROOF_NEAR_MM);
      assertNear(box.min.z, WALL_TOP_MM - OVERHANG_MM * tan(SLOPE_DEG), "the eave falls with the slope", ROOF_NEAR_MM);

      // Above the outline the roof is the one without an overhang, so a hip rises by half the depth, and its thickness goes on top.
      const rise = (DEPTH_MM / 2) * tan(SLOPE_DEG);
      assert.ok(box.max.z >= WALL_TOP_MM + rise, `top ${box.max.z}, expected at least ${WALL_TOP_MM + rise}`);
      assert.ok(box.max.z < WALL_TOP_MM + rise + 1000, `top ${box.max.z}`);

      // Attached, each wall follows the underside of the roof: its inner face, half a wall inside the outline, is its highest point.
      const attached = await call(client, "attach_walls", wallIds.map((wallId) => ({ wallId, roofId })));
      console.log(`# attached: ${JSON.stringify(attached)}`);
      assertLanded(attached);
      assert.deepEqual(attached.items.map((item) => item.status), ["created", "created", "created", "created"]);
      assert.deepEqual(attached.items.map((item) => item.actual?.["attachedToIds"]), [[roofId], [roofId], [roofId], [roofId]]);

      const wallTopMm = WALL_TOP_MM + halfWall * tan(SLOPE_DEG);
      for (const [index, wall] of (await readElements(client, wallIds)).entries()) {
        assertNear(wall.topMm, wallTopMm, `top of wall ${index} under the roof`, ROOF_NEAR_MM);
        assertNear(attached.items[index]?.actual?.["topMm"], wall.topMm as number, `topMm of attach_walls and get_elements, wall ${index}`);
      }

      // A view with cast shadows: only the presentation template brings them.
      const templates = (await client.call("list_types", { category: "view_templates" })) as TypeRow[];
      const presentation = templates.find((template) => /презентац/i.test(template.name));
      assert.ok(presentation, `no presentation template in ${JSON.stringify(templates)}`);

      const viewId = await createView(client, presentation.id);
      assert.ok((await modelInfo(client)).views.some((view) => view.id === viewId && view.name === VIEW_NAME));
      await keepSnapshot(client, viewId, "дом");

      house = { wallType, ground, wallIds, roofId, viewTemplateId: presentation.id, wallTopMm };
    });
  });

  it("one undo takes one operation off the house, and the house can be finished again", async () => {
    await withClient(async (client) => {
      const { wallIds, roofId, viewTemplateId, wallTopMm } = built();

      const noView = await undoLastOperation(client);
      console.log(`# undo: ${JSON.stringify(noView)}`);
      assert.equal(noView.state, "undone");
      assert.equal(noView.transactionName, "MCP: create_3d_view");
      assert.equal(noView.documentTitle, name);
      assert.ok(!(await modelInfo(client)).views.some((view) => view.name === VIEW_NAME), "the view should be gone");
      for (const wall of await readElements(client, wallIds)) {
        assertNear(wall.topMm, wallTopMm, "the walls stay attached", ROOF_NEAR_MM);
      }

      // Four walls were attached by one call, and one undo takes all of them back.
      const detached = await undoLastOperation(client);
      console.log(`# undo: ${JSON.stringify(detached)}`);
      assert.equal(detached.state, "undone");
      assert.equal(detached.transactionName, "MCP: attach_walls");
      for (const [index, wall] of (await readElements(client, wallIds)).entries()) {
        assertNear(wall.topMm, WALL_TOP_MM, `wall ${index} is back at its level`);
      }
      assert.equal((await readElements(client, [roofId]))[0]?.category, "roofs", "the roof stays");

      const again = await call(client, "attach_walls", wallIds.map((wallId) => ({ wallId, roofId })));
      assertLanded(again);
      assert.deepEqual(again.items.map((item) => item.status), ["created", "created", "created", "created"]);
      for (const wall of await readElements(client, wallIds)) {
        assertNear(wall.topMm, wallTopMm, "attached again", ROOF_NEAR_MM);
      }

      await keepSnapshot(client, await createView(client, viewTemplateId), "дом-после-отмены");
    });
  });

  it("an error in a batch leaves nothing in the model", async () => {
    await withClient(async (client) => {
      const { wallType, ground } = built();
      const before = await modelInfo(client);

      const wall = (x: number, heightMm: number) => ({ startMm: { x, y: 20000 }, endMm: { x: x + 3000, y: 20000 }, typeId: wallType.id, levelId: ground.id, heightMm });
      const batch = await call(client, "create_walls", [wall(0, 3000), wall(5000, 30), wall(10000, 3000)]);
      console.log(`# a wall too low to build: ${JSON.stringify(batch)}`);

      assert.equal(batch.committed, false);
      assert.deepEqual(batch.items.map((item) => item.status), ["rolled_back", "failed", "rolled_back"]);
      assert.ok(batch.items.every((item) => item.elementId === null && item.actual === null));
      assert.equal(batch.items[1]?.error, "Revit could not build this element and gave no reason: Failed to regenerate.");
      assert.match(batch.items[2]?.error ?? "", /not attempted/i);
      assert.deepEqual(batch.dialogs, []);

      const after = await modelInfo(client);
      assert.equal(countOf(after, "OST_Walls"), countOf(before, "OST_Walls"));
      assert.deepEqual(after.categoryCounts, before.categoryCounts);
      assert.deepEqual(after.activeDocument, before.activeDocument);
    });
  });

  it("leaves the house saved, in a state the close rule accepts", async () => {
    await withClient(async (client) => {
      await client.call("save_project", { name });
      const info = await modelInfo(client);

      assert.equal(info.activeDocument?.isModified, false);
      assert.deepEqual(checkCanClose(info.openDocuments), { ok: true, reasons: [] });
    });
  });
});
