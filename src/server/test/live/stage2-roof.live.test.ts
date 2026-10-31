import assert from "node:assert/strict";
import { copyFile, mkdir, readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { checkCanClose } from "../../src/cli/closeRule.ts";
import { BridgeClient } from "../../src/client.ts";
import { defaultConnectionPath } from "../../src/connection.ts";
import { BridgeRpcError } from "../../src/errors.ts";

// These tests need a running Revit with the RevitMCP plugin loaded. Each run creates one new project in the test
// folder and leaves it open and saved. Buildings stand far apart, so one does not touch another's roof.

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

interface ModelInfo {
  activeDocument: OpenDocument | null;
  openDocuments: OpenDocument[];
  levels: Level[];
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
  boundingBoxMm: Box | null;
}

interface RoofEdge {
  startMm: Point;
  endMm: Point;
  definesSlope: boolean;
  slopeDeg: number | null;
  eaveOffsetMm: number;
}

interface Item {
  index: number;
  status: string;
  elementId: string | null;
  requested: Record<string, unknown> | null;
  actual: Record<string, unknown> | null;
  warnings: string[];
  error: string | null;
}

interface Batch {
  committed: boolean;
  items: Item[];
  warnings: string[];
  errors: string[];
  dialogs: unknown[];
}

interface Context {
  wallType: TypeRow;
  floorType: TypeRow;
  roofType: TypeRow;
  ground: Level;
  upper: Level;
}

const INVALID_PARAMS = -32602;
const NEAR_MM = 0.01;
/** How close a height read from a bounding box should be, as roofs round to Revit's own tolerance. */
const ROOF_NEAR_MM = 1;
const SLOPE_DEG = 30;
const OVERHANG_MM = 500;
const SLOPE_NEAR_DEG = 0.001;
const WIDTH_MM = 12000;
const DEPTH_MM = 8000;

const stamp = new Date().toTimeString().slice(0, 8).replaceAll(":", "");
const name = `проверка-задача12-${stamp}`;
const snapshotFolder = path.join(homedir(), "Documents", "RevitMCP", "task12-probe");

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

/** Calls a method that must refuse, and returns the refusal. */
async function refusal(client: BridgeClient, method: string, params: object): Promise<BridgeRpcError> {
  const error = await client.call(method, params).then(
    (result) => assert.fail(`${method} ${JSON.stringify(params)} should be refused, and returned ${JSON.stringify(result)}`),
    (reason: unknown) => reason,
  );

  assert.ok(error instanceof BridgeRpcError, `${method}: expected a plugin error, got ${String(error)}`);
  return error;
}

function countOf(info: ModelInfo, category: string): number {
  return info.categoryCounts.find((entry) => entry.category === category)?.count ?? 0;
}

async function context(client: BridgeClient): Promise<Context> {
  const levels = [...(await modelInfo(client)).levels].sort((a, b) => a.elevationMm - b.elevationMm);
  const walls = (await client.call("list_types", { category: "walls" })) as TypeRow[];
  const floors = (await client.call("list_types", { category: "floors" })) as TypeRow[];
  const roofs = (await client.call("list_types", { category: "roofs" })) as TypeRow[];
  const [ground, upper] = levels;
  const [wallType] = walls;
  const [floorType] = floors;
  const [roofType] = roofs;
  assert.ok(ground && upper && wallType && floorType && roofType);

  return { wallType, floorType, roofType, ground, upper };
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
}

/** A rectangle from its south-west corner, listed counter-clockwise: edges south, east, north, west. */
function rectangle(x: number, y: number, width = WIDTH_MM, depth = DEPTH_MM): Point[] {
  return [
    { x, y },
    { x: x + width, y },
    { x: x + width, y: y + depth },
    { x, y: y + depth },
  ];
}

const tan = (degrees: number): number => Math.tan((degrees * Math.PI) / 180);

/** Distance from the line of edge `index` to the corner farthest from it. A roof sloped on that edge alone rises over this run. */
function runOf(points: Point[], index: number): number {
  const start = points[index];
  const end = points[(index + 1) % points.length];
  assert.ok(start && end);
  const length = Math.hypot(end.x - start.x, end.y - start.y);

  return Math.max(...points.map((point) => Math.abs((end.x - start.x) * (point.y - start.y) - (end.y - start.y) * (point.x - start.x)) / length));
}

/** Walls on the edges of an outline, in the same order. */
function wallsAlong(outline: Point[], typeId: string, levelId: string, topLevelId: string): unknown[] {
  return outline.map((startMm, index) => ({ startMm, endMm: outline[(index + 1) % outline.length], typeId, levelId, topLevelId }));
}

/** The time of day is in the name, so a file of an earlier run is never overwritten. */
async function keepSnapshot(client: BridgeClient, viewId: string, title: string): Promise<string> {
  const snapshot = (await client.call("get_view_snapshot", { viewId, widthPx: 1600 })) as { path: string };
  await mkdir(snapshotFolder, { recursive: true });
  const kept = path.join(snapshotFolder, `${title}-${stamp}.png`);
  await copyFile(snapshot.path, kept);
  console.log(`# snapshot ${title}: ${kept}`);

  return kept;
}

async function view(client: BridgeClient, title: string, eyeMm: object, targetMm: object): Promise<string> {
  const created = (await client.call("create_3d_view", { name: title, kind: "perspective", displayStyle: "realistic", eyeMm, targetMm })) as {
    committed: boolean;
    viewId: string;
  };
  assert.equal(created.committed, true, JSON.stringify(created));

  return created.viewId;
}

/** The journal Revit is writing now. Its number only ever grows, so the highest belongs to the running Revit. */
async function journalPath(): Promise<string> {
  const localAppData = process.env["LOCALAPPDATA"] || path.join(homedir(), "AppData", "Local");
  const folder = path.join(localAppData, "Autodesk", "Revit", "Autodesk Revit 2027", "Journals");
  const numbers = (await readdir(folder)).flatMap((file) => /^journal\.(\d+)\.txt$/.exec(file)?.[1] ?? []);
  const newest = numbers.sort((a, b) => Number(a) - Number(b)).at(-1);
  assert.ok(newest, `no journal in ${folder}`);

  return path.join(folder, `journal.${newest}.txt`);
}

/** How many transactions of this method Revit reported as committed, from a journal line that names each one. */
async function committedInJournal(journal: string, method: string): Promise<number> {
  const text = await readFile(journal, "latin1");
  return text.match(new RegExp(`"Transaction Successful"\\s*,\\s*"MCP: ${method}"`, "g"))?.length ?? 0;
}

/** Revit writes its journal a little late, so this waits for the count to settle above what it was. */
async function journalCountAfter(journal: string, method: string, before: number): Promise<number> {
  const deadline = Date.now() + 5000;
  let count = await committedInJournal(journal, method);
  while (count === before && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    count = await committedInJournal(journal, method);
  }

  await new Promise((resolve) => setTimeout(resolve, 500));
  return committedInJournal(journal, method);
}

describe("stage 2 live checks: roofs and attached walls", { timeout: 120_000 }, () => {
  it("creates a project for this run", async () => {
    await withClient(async (client) => {
      await client.call("create_project", { name });
      const info = await modelInfo(client);
      const roofs = (await client.call("list_types", { category: "roofs" })) as TypeRow[];
      console.log(`# levels: ${JSON.stringify(info.levels)}`);
      console.log(`# roof types: ${JSON.stringify(roofs)}`);

      assert.equal(info.activeDocument?.title, name);
    });
  });

  it("hip roof covers rectangle with four slopes", async () => {
    await withClient(async (client) => {
      const { wallType, floorType, roofType, ground, upper } = await context(client);
      const outline = rectangle(0, 0);

      assertLanded(await call(client, "create_walls", wallsAlong(outline, wallType.id, ground.id, upper.id)));
      assertLanded(await call(client, "create_floors", [{ boundaryMm: outline, typeId: floorType.id, levelId: ground.id }]));

      const batch = await call(client, "create_roof", [
        { outlineMm: outline, levelId: upper.id, typeId: roofType.id, overhangMm: OVERHANG_MM, edgeSlopesDeg: [SLOPE_DEG, SLOPE_DEG, SLOPE_DEG, SLOPE_DEG] },
      ]);
      console.log(`# hip: ${JSON.stringify(batch)}`);

      assertLanded(batch);
      const [item] = batch.items;
      assert.equal(item?.status, "created");
      assert.equal(item?.actual?.["typeId"], roofType.id);
      assert.equal(item?.actual?.["levelId"], upper.id);

      const edges = item?.actual?.["edges"] as RoofEdge[];
      assert.equal(edges.length, 4);
      for (const [index, edge] of edges.entries()) {
        assert.equal(edge.definesSlope, true, `edge ${index}`);
        assertNear(edge.slopeDeg, SLOPE_DEG, `slope of edge ${index}`, SLOPE_NEAR_DEG);
        assertNear(edge.eaveOffsetMm, -OVERHANG_MM * tan(SLOPE_DEG), `eave of edge ${index}`);
      }

      // Edge 0 is the south one, moved out from both of its neighbours.
      assertNear(edges[0]?.startMm.x, -OVERHANG_MM, "edge 0 starts at the west eave");
      assertNear(edges[0]?.startMm.y, -OVERHANG_MM, "edge 0 lies on the south eave");
      assertNear(edges[0]?.endMm.x, WIDTH_MM + OVERHANG_MM, "edge 0 ends at the east eave");

      const [roof] = await readElements(client, [item?.elementId ?? null]);
      console.log(`# hip read back: ${JSON.stringify(roof)}`);
      assert.equal(roof?.category, "roofs");

      // Above the outline the roof is the one without an overhang, so a hip rises by half the depth over the level.
      const rise = (DEPTH_MM / 2) * tan(SLOPE_DEG);
      const box = roof?.boundingBoxMm;
      assert.ok(box);
      assert.ok(box.max.z >= upper.elevationMm + rise, `top ${box.max.z}, expected at least ${upper.elevationMm + rise}`);
      assert.ok(box.max.z < upper.elevationMm + rise + 1000, `top ${box.max.z}`);
      assertNear(box.min.x, -OVERHANG_MM, "west eave", ROOF_NEAR_MM);
      assertNear(box.max.x, WIDTH_MM + OVERHANG_MM, "east eave", ROOF_NEAR_MM);
      assertNear(box.min.y, -OVERHANG_MM, "south eave", ROOF_NEAR_MM);
      assertNear(box.max.y, DEPTH_MM + OVERHANG_MM, "north eave", ROOF_NEAR_MM);
      assertNear(box.min.z, upper.elevationMm - OVERHANG_MM * tan(SLOPE_DEG), "the eave falls with the slope", ROOF_NEAR_MM);

      // From high up, so that all four slopes show.
      const viewId = await view(client, "Вальмовая крыша", { x: 26000, y: -18000, z: 28000 }, { x: 6000, y: 4000, z: 3500 });
      await keepSnapshot(client, viewId, "hip");
    });
  });

  it("gable roof with attached walls forms gable ends", async () => {
    await withClient(async (client) => {
      const { wallType, floorType, roofType, ground, upper } = await context(client);
      const outline = rectangle(100000, 0);

      const walls = await call(client, "create_walls", wallsAlong(outline, wallType.id, ground.id, upper.id));
      assertLanded(walls);
      assertLanded(await call(client, "create_floors", [{ boundaryMm: outline, typeId: floorType.id, levelId: ground.id }]));

      // The overhang puts the whole thickness of the walls under the roof. Without it the outer layers stay low.
      const roofed = await call(client, "create_roof", [
        { outlineMm: outline, levelId: upper.id, typeId: roofType.id, overhangMm: OVERHANG_MM, edgeSlopesDeg: [SLOPE_DEG, null, SLOPE_DEG, null] },
      ]);
      console.log(`# gable: ${JSON.stringify(roofed)}`);
      assertLanded(roofed);

      const edges = roofed.items[0]?.actual?.["edges"] as RoofEdge[];
      assert.deepEqual(edges.map((edge) => edge.definesSlope), [true, false, true, false]);
      assert.equal(edges[1]?.slopeDeg, null);
      assertNear(edges[1]?.eaveOffsetMm, 0, "an edge without a slope stays on the level");

      const roofId = roofed.items[0]?.elementId;
      assert.ok(roofId);
      const wallIds = walls.items.map((item) => item.elementId);
      const before = await readElements(client, wallIds);
      console.log(`# walls before: ${JSON.stringify(before)}`);

      const attached = await call(client, "attach_walls", wallIds.map((wallId) => ({ wallId, roofId })));
      console.log(`# attached: ${JSON.stringify(attached)}`);
      assertLanded(attached);
      assert.deepEqual(attached.items.map((item) => item.status), ["created", "created", "created", "created"]);
      assert.deepEqual(attached.items.map((item) => item.elementId), wallIds);
      assert.ok(attached.items.every((item) => (item.actual?.["attachedToIds"] as string[]).includes(roofId)));

      const after = await readElements(client, wallIds);
      console.log(`# walls after: ${JSON.stringify(after)}`);

      // The top of an end wall meets the underside of the ridge, which is what makes it a gable.
      const [south, east, north, west] = after;
      const ridge = upper.elevationMm + (DEPTH_MM / 2) * tan(SLOPE_DEG);
      assertNear(east?.boundingBoxMm?.max.z, ridge, "the east wall reaches the ridge", ROOF_NEAR_MM);
      assertNear(west?.boundingBoxMm?.max.z, ridge, "the west wall reaches the ridge", ROOF_NEAR_MM);
      for (const [side, wall] of [["south", south], ["north", north]] as const) {
        assert.ok((wall?.boundingBoxMm?.max.z ?? Infinity) < upper.elevationMm + 200, `the ${side} wall should stay at the eave: ${JSON.stringify(wall)}`);
      }

      const tops = attached.items.map((item) => item.actual?.["topMm"]);
      console.log(`# real tops: ${JSON.stringify(tops)}`);
      assertNear(tops[1], ridge, "the real top of the east wall", ROOF_NEAR_MM);
      assertNear(tops[3], ridge, "the real top of the west wall", ROOF_NEAR_MM);
      assert.ok((tops[0] as number) < upper.elevationMm + 200, "the real top of the south wall");

      const again = await call(client, "attach_walls", [{ wallId: wallIds[0], roofId }]);
      console.log(`# attached again: ${JSON.stringify(again)}`);
      assertLanded(again);
      assert.equal(again.items[0]?.status, "already_existed");
      assert.equal(again.items[0]?.elementId, wallIds[0]);
      assert.deepEqual(again.items[0]?.actual?.["attachedToIds"], [roofId]);

      const viewId = await view(client, "Двускатная крыша", { x: 126000, y: -14000, z: 11000 }, { x: 106000, y: 4000, z: 3500 });
      await keepSnapshot(client, viewId, "gable");
    });
  });

  it("edgeSlopesDeg length mismatch fails before any change", async () => {
    await withClient(async (client) => {
      const { roofType, upper } = await context(client);
      const before = countOf(await modelInfo(client), "OST_Roofs");
      const outline = rectangle(200000, 0);
      const good = { outlineMm: outline, levelId: upper.id, typeId: roofType.id, edgeSlopesDeg: [SLOPE_DEG, null, SLOPE_DEG, null] };

      for (const edgeSlopesDeg of [[SLOPE_DEG], [SLOPE_DEG, null, SLOPE_DEG], [SLOPE_DEG, null, SLOPE_DEG, null, SLOPE_DEG]]) {
        const refused = await refusal(client, "create_roof", { items: [good, { ...good, edgeSlopesDeg }] });
        console.log(`# length mismatch: ${refused.message}`);

        assert.equal(refused.code, INVALID_PARAMS);
        assert.match(refused.message, /item 1/);
        assert.match(refused.message, /edgeSlopesDeg/);
      }

      assert.equal(countOf(await modelInfo(client), "OST_Roofs"), before);
    });
  });

  it("each slope lands on its own edge in any outline order", async () => {
    await withClient(async (client) => {
      const { roofType, upper } = await context(client);

      // No two edges are alike, so a roof sloped on one edge has a height that belongs to that edge alone.
      const shape = [{ x: 0, y: 0 }, { x: 16000, y: 0 }, { x: 11000, y: 7000 }, { x: 2000, y: 11000 }];
      const orders: Array<[string, Point[]]> = [
        ["counter-clockwise", shape],
        ["clockwise", [...shape].reverse()],
        ["counter-clockwise from another corner", [...shape.slice(2), ...shape.slice(0, 2)]],
        ["clockwise from another corner", [...shape.slice(1), ...shape.slice(0, 1)].reverse()],
      ];

      const items = orders.flatMap(([, points], order) =>
        points.map((_, edge) => ({
          outlineMm: points.map(({ x, y }) => ({ x: x + 300000 + 25000 * edge, y: y + 25000 * order })),
          levelId: upper.id,
          typeId: roofType.id,
          edgeSlopesDeg: points.map((__, index) => (index === edge ? SLOPE_DEG : null)),
        })),
      );

      const batch = await call(client, "create_roof", items);
      assertLanded(batch);
      const roofs = await readElements(client, batch.items.map((item) => item.elementId));

      // The roof's thickness is the same in all of them, so heights are compared with the first roof.
      const offset = (roofs[0]?.boundingBoxMm?.max.z ?? 0) - runOf(shape, 0) * tan(SLOPE_DEG);

      for (const [order, [title, points]] of orders.entries()) {
        for (const [edge] of points.entries()) {
          const position = order * points.length + edge;
          const expected = offset + runOf(points, edge) * tan(SLOPE_DEG);
          const actual = batch.items[position]?.actual?.["edges"] as RoofEdge[];
          console.log(`# ${title}, edge ${edge}: run ${runOf(points, edge).toFixed(1)}, top ${roofs[position]?.boundingBoxMm?.max.z}, expected ${expected.toFixed(1)}`);

          assertNear(roofs[position]?.boundingBoxMm?.max.z, expected, `${title}, edge ${edge}`, ROOF_NEAR_MM);
          assert.deepEqual(actual.map((entry) => entry.definesSlope), points.map((_, index) => index === edge), `${title}, edge ${edge}`);
        }
      }
    });
  });

  it("a slope on the south edge raises the north side, whichever way the outline runs", async () => {
    await withClient(async (client) => {
      const { wallType, roofType, ground, upper } = await context(client);
      const shed = rectangle(450000, 0);
      const reversed = [...rectangle(450000, 30000)].reverse();

      const roofs = await call(client, "create_roof", [
        { outlineMm: shed, levelId: upper.id, typeId: roofType.id, edgeSlopesDeg: [SLOPE_DEG, null, null, null] },
        // Reversed, the outline starts on the north edge and runs along it, so the south edge is edge 2.
        { outlineMm: reversed, levelId: upper.id, typeId: roofType.id, edgeSlopesDeg: [null, null, SLOPE_DEG, null] },
      ]);
      console.log(`# sheds: ${JSON.stringify(roofs)}`);
      assertLanded(roofs);

      for (const [index, y] of [0, 30000].entries()) {
        const walls = await call(client, "create_walls", wallsAlong(rectangle(450000, y), wallType.id, ground.id, upper.id));
        assertLanded(walls);

        const roofId = roofs.items[index]?.elementId;
        const attached = await call(client, "attach_walls", walls.items.map((item) => ({ wallId: item.elementId, roofId })));
        assertLanded(attached);

        const [south, , north] = await readElements(client, walls.items.map((item) => item.elementId));
        console.log(`# shed ${index}: south ${JSON.stringify(south?.boundingBoxMm)} north ${JSON.stringify(north?.boundingBoxMm)}`);

        const rise = DEPTH_MM * tan(SLOPE_DEG);
        assert.ok((north?.boundingBoxMm?.max.z ?? 0) >= upper.elevationMm + rise * 0.9, `north ${JSON.stringify(north)}`);
        assert.ok((south?.boundingBoxMm?.max.z ?? Infinity) < upper.elevationMm + rise * 0.5, `south ${JSON.stringify(south)}`);
      }
    });
  });

  it("an overhang moves the eaves out and leaves the roof above the outline as it was, whichever way the outline runs", async () => {
    await withClient(async (client) => {
      const { roofType, upper } = await context(client);
      const steep = 45;
      const place = (index: number): number => 500000 + 30000 * index;
      const roof = (outlineMm: Point[], overhangMm: number) => ({ outlineMm, levelId: upper.id, typeId: roofType.id, overhangMm, edgeSlopesDeg: [SLOPE_DEG, steep, SLOPE_DEG, steep] });

      // Clockwise from the north-west corner: the north edge, the east, the south, the west.
      const [a, b, c, d] = rectangle(place(2), 0);
      assert.ok(a && b && c && d);
      const clockwise = [d, c, b, a];

      const batch = await call(client, "create_roof", [
        roof(rectangle(place(0), 0), 0),
        roof(rectangle(place(1), 0), OVERHANG_MM),
        roof(clockwise, OVERHANG_MM),
      ]);
      console.log(`# overhangs: ${JSON.stringify(batch)}`);
      assertLanded(batch);

      const [plain, moved, reversed] = await readElements(client, batch.items.map((item) => item.elementId));
      console.log(`# overhangs read back: ${JSON.stringify([plain, moved, reversed])}`);

      for (const [index, entry] of [[1, moved], [2, reversed]] as const) {
        assertNear(entry?.boundingBoxMm?.min.x, place(index) - OVERHANG_MM, `west eave of ${index}`, ROOF_NEAR_MM);
        assertNear(entry?.boundingBoxMm?.max.x, place(index) + WIDTH_MM + OVERHANG_MM, `east eave of ${index}`, ROOF_NEAR_MM);
        assertNear(entry?.boundingBoxMm?.min.y, -OVERHANG_MM, `south eave of ${index}`, ROOF_NEAR_MM);
        assertNear(entry?.boundingBoxMm?.max.y, DEPTH_MM + OVERHANG_MM, `north eave of ${index}`, ROOF_NEAR_MM);
        assertNear(entry?.boundingBoxMm?.max.z, plain?.boundingBoxMm?.max.z ?? 0, `top of ${index}`, ROOF_NEAR_MM);
        // The steeper slope falls further over the same overhang.
        assertNear(entry?.boundingBoxMm?.min.z, upper.elevationMm - OVERHANG_MM * tan(steep), `lowest eave of ${index}`, ROOF_NEAR_MM);
      }

      const offsets = (batch.items[2]?.actual?.["edges"] as RoofEdge[]).map((edge) => edge.eaveOffsetMm);
      assertNear(offsets[0], -OVERHANG_MM * tan(SLOPE_DEG), "the gentle edge falls less");
      assertNear(offsets[1], -OVERHANG_MM * tan(steep), "the steep edge falls further");
    });
  });

  it("an L-shaped outline takes an overhang, and an overhang that closes a notch is refused", async () => {
    await withClient(async (client) => {
      const { roofType, upper } = await context(client);
      const x = 600000;
      const slopes = (count: number) => Array.from({ length: count }, () => SLOPE_DEG);
      const shape = [{ x, y: 0 }, { x: x + 12000, y: 0 }, { x: x + 12000, y: 6000 }, { x: x + 6000, y: 6000 }, { x: x + 6000, y: 10000 }, { x, y: 10000 }];

      const batch = await call(client, "create_roof", [{ outlineMm: shape, levelId: upper.id, typeId: roofType.id, overhangMm: OVERHANG_MM, edgeSlopesDeg: slopes(shape.length) }]);
      console.log(`# L shape: ${JSON.stringify(batch)}`);
      assertLanded(batch);

      const box = batch.items[0]?.actual?.["boundingBoxMm"] as Box;
      assertNear(box.min.x, x - OVERHANG_MM, "west eave", ROOF_NEAR_MM);
      assertNear(box.max.x, x + 12000 + OVERHANG_MM, "east eave", ROOF_NEAR_MM);
      assertNear(box.max.y, 10000 + OVERHANG_MM, "north eave", ROOF_NEAR_MM);

      const before = countOf(await modelInfo(client), "OST_Roofs");
      const notch = [
        { x: x + 30000, y: 0 },
        { x: x + 40000, y: 0 },
        { x: x + 40000, y: 8000 },
        { x: x + 35500, y: 8000 },
        { x: x + 35500, y: 4000 },
        { x: x + 34500, y: 4000 },
        { x: x + 34500, y: 8000 },
        { x: x + 30000, y: 8000 },
      ];
      const refused = await refusal(client, "create_roof", { items: [{ outlineMm: notch, levelId: upper.id, typeId: roofType.id, overhangMm: 600, edgeSlopesDeg: slopes(notch.length) }] });
      console.log(`# notch: ${refused.message}`);

      assert.equal(refused.code, INVALID_PARAMS);
      assert.match(refused.message, /overhangMm/);
      assert.equal(countOf(await modelInfo(client), "OST_Roofs"), before);
    });
  });

  it("create_roof refuses what it cannot honour and creates nothing", async () => {
    await withClient(async (client) => {
      const { wallType, floorType, roofType, ground, upper } = await context(client);
      const before = countOf(await modelInfo(client), "OST_Roofs");
      const outlineMm = rectangle(700000, 0);
      const good = { outlineMm, levelId: upper.id, typeId: roofType.id, edgeSlopesDeg: [SLOPE_DEG, null, SLOPE_DEG, null] };

      for (const [what, item] of [
        ["no slope at all", { ...good, edgeSlopesDeg: [null, null, null, null] }],
        ["a zero slope", { ...good, edgeSlopesDeg: [0, null, SLOPE_DEG, null] }],
        ["a negative slope", { ...good, edgeSlopesDeg: [-10, null, SLOPE_DEG, null] }],
        ["a vertical slope", { ...good, edgeSlopesDeg: [90, null, SLOPE_DEG, null] }],
        ["a slope of more than 90", { ...good, edgeSlopesDeg: [120, null, SLOPE_DEG, null] }],
        ["a slope as text", { ...good, edgeSlopesDeg: ["30", null, SLOPE_DEG, null] }],
        ["no slopes", { outlineMm, levelId: upper.id, typeId: roofType.id }],
        ["slopes that are no list", { ...good, edgeSlopesDeg: 30 }],
        ["a negative overhang", { ...good, overhangMm: -1 }],
        ["an overhang as text", { ...good, overhangMm: "600" }],
        ["a repeated first point", { ...good, outlineMm: [...outlineMm, outlineMm[0]], edgeSlopesDeg: [SLOPE_DEG, null, SLOPE_DEG, null, null] }],
        ["two points", { ...good, outlineMm: outlineMm.slice(0, 2), edgeSlopesDeg: [SLOPE_DEG, null] }],
        ["an outline that crosses itself", { ...good, outlineMm: [outlineMm[0], outlineMm[2], outlineMm[1], outlineMm[3]] }],
        ["a wall type", { ...good, typeId: wallType.id }],
        ["a floor type", { ...good, typeId: floorType.id }],
        ["a type that is not there", { ...good, typeId: "999999999" }],
        ["a level that is not there", { ...good, levelId: "999999999" }],
        ["a type as a level", { ...good, levelId: roofType.id }],
      ] as const) {
        const refused = await refusal(client, "create_roof", { items: [good, item] });
        console.log(`# ${what}: ${refused.message.slice(0, 220)}`);

        assert.equal(refused.code, INVALID_PARAMS, what);
        assert.match(refused.message, /item 1/, what);
      }

      const wrongType = await refusal(client, "create_roof", { items: [{ ...good, typeId: wallType.id }] });
      assert.ok(wrongType.message.includes(roofType.id), wrongType.message);
      const wrongLevel = await refusal(client, "create_roof", { items: [{ ...good, levelId: "999999999" }] });
      assert.ok(wrongLevel.message.includes(ground.id), wrongLevel.message);

      assert.equal((await refusal(client, "create_roof", { items: [] })).code, INVALID_PARAMS);
      assert.equal((await refusal(client, "create_roof", {})).code, INVALID_PARAMS);
      assert.equal((await refusal(client, "create_roof", { items: Array.from({ length: 501 }, () => good) })).code, INVALID_PARAMS);

      assert.equal(countOf(await modelInfo(client), "OST_Roofs"), before);
    });
  });

  it("a roof Revit cannot build comes back with Revit's reason and leaves nothing", async () => {
    await withClient(async (client) => {
      const { roofType, upper } = await context(client);
      const before = countOf(await modelInfo(client), "OST_Roofs");
      const good = { outlineMm: rectangle(750000, 0), levelId: upper.id, typeId: roofType.id, edgeSlopesDeg: [SLOPE_DEG, null, SLOPE_DEG, null] };

      // So steep over such a width that the ridge would stand above the highest point Revit allows.
      const tooHigh = { outlineMm: rectangle(800000, 0, 400000, 400000), levelId: upper.id, typeId: roofType.id, edgeSlopesDeg: [89.9, null, 89.9, null] };

      const batch = await call(client, "create_roof", [good, tooHigh, good]);
      console.log(`# too high: ${JSON.stringify(batch)}`);

      assert.equal(batch.committed, false);
      assert.ok(batch.errors.length > 0, JSON.stringify(batch));
      assert.ok(batch.items.every((item) => item.elementId === null && item.actual === null));
      assert.equal(countOf(await modelInfo(client), "OST_Roofs"), before);
    });
  });

  it("attach_walls refuses ids that are no wall or no roof, and a repeated pair", async () => {
    await withClient(async (client) => {
      const { wallType, floorType, roofType, ground, upper } = await context(client);
      const outline = rectangle(900000, 0);
      const walls = await call(client, "create_walls", wallsAlong(outline, wallType.id, ground.id, upper.id));
      const floors = await call(client, "create_floors", [{ boundaryMm: outline, typeId: floorType.id, levelId: ground.id }]);
      const roofs = await call(client, "create_roof", [{ outlineMm: outline, levelId: upper.id, typeId: roofType.id, edgeSlopesDeg: [SLOPE_DEG, null, SLOPE_DEG, null] }]);
      assertLanded(walls);
      assertLanded(floors);
      assertLanded(roofs);

      const wallId = walls.items[0]?.elementId;
      const roofId = roofs.items[0]?.elementId;
      const floorId = floors.items[0]?.elementId;
      assert.ok(wallId && roofId && floorId);
      const good = { wallId, roofId };

      for (const [what, item] of [
        ["a floor as a wall", { wallId: floorId, roofId }],
        ["a roof as a wall", { wallId: roofId, roofId }],
        ["a level as a wall", { wallId: ground.id, roofId }],
        ["a wall type as a wall", { wallId: wallType.id, roofId }],
        ["a wall that is not there", { wallId: "999999999", roofId }],
        ["text as a wall", { wallId: "стена", roofId }],
        ["a wall as a roof", { wallId, roofId: wallId }],
        ["a floor as a roof", { wallId, roofId: floorId }],
        ["a roof type as a roof", { wallId, roofId: roofType.id }],
        ["a roof that is not there", { wallId, roofId: "999999999" }],
        ["no roof", { wallId }],
        ["no wall", { roofId }],
        ["a number as a wall", { wallId: 123, roofId }],
      ] as const) {
        const refused = await refusal(client, "attach_walls", { items: [good, item] });
        console.log(`# ${what}: ${refused.message.slice(0, 220)}`);

        assert.equal(refused.code, INVALID_PARAMS, what);
        assert.match(refused.message, /item 1/, what);
      }

      const notRoof = await refusal(client, "attach_walls", { items: [{ wallId, roofId: wallId }] });
      assert.ok(notRoof.message.includes(roofId), notRoof.message);
      const notWall = await refusal(client, "attach_walls", { items: [{ wallId: roofId, roofId }] });
      assert.ok(notWall.message.includes(wallId), notWall.message);

      const repeated = await refusal(client, "attach_walls", { items: [good, good] });
      console.log(`# repeated: ${repeated.message}`);
      assert.equal(repeated.code, INVALID_PARAMS);
      assert.match(repeated.message, /items 0 and 1/);

      const [wall] = await readElements(client, [wallId]);
      assert.ok((wall?.boundingBoxMm?.max.z ?? Infinity) <= upper.elevationMm + NEAR_MM, "nothing should have been attached");
    });
  });

  it("a wall under two roofs attaches to both, and each attachment is its own item", async () => {
    await withClient(async (client) => {
      const { wallType, roofType, ground, upper } = await context(client);
      const x = 1000000;

      const walls = await call(client, "create_walls", [{ startMm: { x, y: 4000 }, endMm: { x: x + 20000, y: 4000 }, typeId: wallType.id, levelId: ground.id, topLevelId: upper.id }]);
      const roofs = await call(client, "create_roof", [
        { outlineMm: rectangle(x, 0, 10000, 8000), levelId: upper.id, typeId: roofType.id, edgeSlopesDeg: [SLOPE_DEG, null, SLOPE_DEG, null] },
        { outlineMm: rectangle(x + 10000, 0, 10000, 8000), levelId: upper.id, typeId: roofType.id, edgeSlopesDeg: [SLOPE_DEG, null, SLOPE_DEG, null] },
      ]);
      assertLanded(walls);
      assertLanded(roofs);
      const wallId = walls.items[0]?.elementId;
      const [first, second] = roofs.items.map((item) => item.elementId);
      assert.ok(wallId && first && second);

      const one = await call(client, "attach_walls", [{ wallId, roofId: first }]);
      console.log(`# first roof: ${JSON.stringify(one)}`);
      assertLanded(one);
      assert.deepEqual(one.items[0]?.actual?.["attachedToIds"], [first]);

      const two = await call(client, "attach_walls", [{ wallId, roofId: second }]);
      console.log(`# second roof: ${JSON.stringify(two)}`);
      assertLanded(two);
      assert.equal(two.items[0]?.status, "created");
      assert.deepEqual(two.items[0]?.actual?.["attachedToIds"], [first, second]);
    });
  });

  it("a wall away from the roof lands attached and unchanged, with the warning of Revit", async () => {
    await withClient(async (client) => {
      const { wallType, roofType, ground, upper } = await context(client);
      const x = 1030000;

      const walls = await call(client, "create_walls", [{ startMm: { x, y: 60000 }, endMm: { x: x + 6000, y: 60000 }, typeId: wallType.id, levelId: ground.id, topLevelId: upper.id }]);
      const roofs = await call(client, "create_roof", [{ outlineMm: rectangle(x, 0), levelId: upper.id, typeId: roofType.id, edgeSlopesDeg: [SLOPE_DEG, null, SLOPE_DEG, null] }]);
      assertLanded(walls);
      assertLanded(roofs);

      const batch = await call(client, "attach_walls", [{ wallId: walls.items[0]?.elementId, roofId: roofs.items[0]?.elementId }]);
      console.log(`# wall away from the roof: ${JSON.stringify(batch)}`);

      assertLanded(batch);
      assert.equal(batch.items[0]?.status, "created");
      assert.equal(batch.warnings.length, 1, JSON.stringify(batch.warnings));
      assertNear(batch.items[0]?.actual?.["topMm"], upper.elevationMm, "the wall did not change");
    });
  });

  it("a wall above the roof is cut down to it", async () => {
    await withClient(async (client) => {
      const { wallType, roofType, ground, upper } = await context(client);
      const x = 1060000;
      const y = DEPTH_MM / 2;

      // Across the ridge, and much higher than the roof.
      const walls = await call(client, "create_walls", [{ startMm: { x: x + 6000, y: 1000 }, endMm: { x: x + 6000, y: DEPTH_MM - 1000 }, typeId: wallType.id, levelId: ground.id, heightMm: 12000 }]);
      const roofs = await call(client, "create_roof", [{ outlineMm: rectangle(x, 0), levelId: upper.id, typeId: roofType.id, edgeSlopesDeg: [SLOPE_DEG, null, SLOPE_DEG, null] }]);
      assertLanded(walls);
      assertLanded(roofs);

      const batch = await call(client, "attach_walls", [{ wallId: walls.items[0]?.elementId, roofId: roofs.items[0]?.elementId }]);
      console.log(`# wall above the roof: ${JSON.stringify(batch)}`);

      assertLanded(batch);
      assertNear(batch.items[0]?.actual?.["topMm"], upper.elevationMm + y * tan(SLOPE_DEG), "the wall stops at the ridge", ROOF_NEAR_MM);

      // Not asserted: this is a habit of Revit, which the description of attach_walls warns about.
      console.log(`# the same wall in get_elements: ${JSON.stringify(await readElements(client, [walls.items[0]?.elementId ?? null]))}`);
    });
  });

  it("a wall Revit cannot attach comes back honestly and leaves nothing attached", async () => {
    await withClient(async (client) => {
      const { wallType, roofType, ground, upper } = await context(client);
      const x = 1090000;

      // The wall stands above the roof, so a top that followed the roof would be below the foot of the wall.
      const walls = await call(client, "create_walls", [
        { startMm: { x, y: 4000 }, endMm: { x: x + 6000, y: 4000 }, typeId: wallType.id, levelId: ground.id, topLevelId: upper.id },
        { startMm: { x: x + 1000, y: 3000 }, endMm: { x: x + 5000, y: 3000 }, typeId: wallType.id, levelId: upper.id, baseOffsetMm: 3000, heightMm: 3000 },
      ]);
      const roofs = await call(client, "create_roof", [{ outlineMm: rectangle(x, 0), levelId: upper.id, typeId: roofType.id, edgeSlopesDeg: [SLOPE_DEG, null, SLOPE_DEG, null] }]);
      assertLanded(walls);
      assertLanded(roofs);
      const [low, high] = walls.items.map((item) => item.elementId);
      const roofId = roofs.items[0]?.elementId;

      const batch = await call(client, "attach_walls", [{ wallId: low, roofId }, { wallId: high, roofId }]);
      console.log(`# wall that cannot attach: ${JSON.stringify(batch)}`);

      assert.equal(batch.committed, false);
      assert.deepEqual(batch.items.map((item) => item.status), ["rolled_back", "rolled_back"]);
      assert.ok(batch.items.every((item) => item.elementId === null && item.actual === null));
      assert.equal(batch.errors.length, 1, JSON.stringify(batch.errors));
      assert.ok(batch.errors[0]?.trim(), "Revit's reason should be there");
      assert.deepEqual(batch.dialogs, []);

      // The first wall was fine, and it came undone with the batch: attached now, it counts as new.
      const retry = await call(client, "attach_walls", [{ wallId: low, roofId }]);
      assertLanded(retry);
      assert.equal(retry.items[0]?.status, "created");

      // What was there before the batch stays there when the batch fails.
      const mixed = await call(client, "attach_walls", [{ wallId: low, roofId }, { wallId: high, roofId }]);
      console.log(`# existing beside a failure: ${JSON.stringify(mixed)}`);
      assert.equal(mixed.committed, false);
      assert.deepEqual(mixed.items.map((item) => item.status), ["already_existed", "rolled_back"]);
      assert.equal(mixed.items[0]?.elementId, low);
      assert.deepEqual(mixed.items[0]?.actual?.["attachedToIds"], [roofId]);
    });
  });

  it("one call is one Undo step, and a repeat adds none", async () => {
    await withClient(async (client) => {
      const { wallType, roofType, ground, upper } = await context(client);
      const journal = await journalPath();
      const outline = rectangle(1100000, 0);
      const walls = await call(client, "create_walls", wallsAlong(outline, wallType.id, ground.id, upper.id));
      assertLanded(walls);

      const roofs = await committedInJournal(journal, "create_roof");
      const created = await call(client, "create_roof", [
        { outlineMm: outline, levelId: upper.id, typeId: roofType.id, edgeSlopesDeg: [SLOPE_DEG, null, SLOPE_DEG, null] },
        { outlineMm: rectangle(1150000, 0), levelId: upper.id, typeId: roofType.id, edgeSlopesDeg: [SLOPE_DEG, null, SLOPE_DEG, null] },
      ]);
      assertLanded(created);
      assert.equal(await journalCountAfter(journal, "create_roof", roofs), roofs + 1);

      const roofId = created.items[0]?.elementId;
      const items = walls.items.map((item) => ({ wallId: item.elementId, roofId }));

      const attaches = await committedInJournal(journal, "attach_walls");
      assertLanded(await call(client, "attach_walls", items));
      const attachesAfter = await journalCountAfter(journal, "attach_walls", attaches);
      console.log(`# ${journal}: attach_walls transactions ${attaches} -> ${attachesAfter} for a batch of ${items.length}`);
      assert.equal(attachesAfter, attaches + 1);

      // Nothing to do, so no transaction, or Undo would step over an empty entry.
      const repeat = await call(client, "attach_walls", items);
      assertLanded(repeat);
      assert.deepEqual(repeat.items.map((item) => item.status), items.map(() => "already_existed"));
      await new Promise((resolve) => setTimeout(resolve, 1000));
      assert.equal(await committedInJournal(journal, "attach_walls"), attachesAfter);
    });
  });

  it("leaves Revit in a state the close rule accepts", async () => {
    await withClient(async (client) => {
      await client.call("save_project", {});
      assert.deepEqual(checkCanClose((await modelInfo(client)).openDocuments), { ok: true, reasons: [] });
    });
  });
});
