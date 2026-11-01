import assert from "node:assert/strict";
import { copyFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { checkCanClose } from "../../src/cli/closeRule.ts";
import { BridgeClient } from "../../src/client.ts";
import { defaultConnectionPath } from "../../src/connection.ts";
import { BridgeRpcError } from "../../src/errors.ts";
import { undoWithOneRetry } from "../undoRetry.ts";

// These tests need a running Revit with the RevitMCP plugin loaded. Each run creates one new project in the test folder and
// leaves it open and saved. They put railings on real stairs and along the edge of a real opening in a floor. The stairs stand
// far apart, each in a scene of its own, so that the railings of one never reach another. A picture of the opening with its
// railing is kept in the test folder.

interface Level {
  id: string;
  name: string;
  elevationMm: number;
}

interface CategoryCount {
  category: string | null;
  count: number;
}

interface ModelInfo {
  activeDocument: { title: string; isModified: boolean } | null;
  openDocuments: Array<{ title: string; path: string; isModified: boolean }>;
  levels: Level[];
  categoryCounts: CategoryCount[];
}

interface TypeRow {
  id: string;
  family: string;
  name: string;
}

interface PlanPoint {
  x: number;
  y: number;
}

interface StairsItem {
  baseLevelId: string;
  topLevelId: string;
  typeId: string;
  runsMm: Array<{ startMm: PlanPoint; endMm: PlanPoint }>;
  widthMm: number;
  desiredRisers: number;
}

interface StairsActual {
  footprintMm: PlanPoint[];
  railingIds: string[];
}

interface RailingRow {
  id: string;
  typeId: string;
  typeName: string | null;
}

interface RailingActual {
  hostId: string | null;
  railings: RailingRow[];
  pathMm: PlanPoint[] | null;
  elevationMm: number | null;
}

interface Item<A> {
  index: number;
  status: string;
  elementId: string | null;
  requested: unknown;
  actual: A | null;
  warnings: string[];
  error: string | null;
}

interface Batch<A> {
  committed: boolean;
  items: Array<Item<A>>;
  warnings: string[];
  errors: string[];
  dialogs: unknown[];
}

interface Box {
  min: { x: number; y: number; z: number };
  max: { x: number; y: number; z: number };
}

interface ElementRow {
  id: string;
  category: string | null;
  typeName: string | null;
  boundingBoxMm: Box | null;
}

interface ElementsAnswer {
  elements: ElementRow[];
  notFound: string[];
}

interface Landed {
  stairsId: string;
  footprint: PlanPoint[];
  railingIds: string[];
}

const INVALID_PARAMS = -32602;
const NEAR_MM = 0.01;
/** What Revit rounds a point to when it keeps it: far above the noise of units, far below any real miss. */
const POINT_MM = 0.1;
const SCENE_PITCH_MM = 12000;
const STOREY_MM = 3000;
const RISERS = 16;
const TREAD_MM = 250;
const WIDTH_MM = 1000;
/** Between the axes of two runs side by side: their width and a gap of 100. */
const RUN_PITCH_MM = WIDTH_MM + 100;
/** The height of the railing type "1100 мм", which Revit puts on every new stairs. */
const DEFAULT_RAILING_HEIGHT_MM = 1100;
const SNAPSHOT_WIDTH_PX = 1200;
/** Other stairs, floors and views stand far from these, so nothing of theirs gets into the picture. */
const PICTURE_SCENE_Y_MM = 500000;

const stamp = new Date().toTimeString().slice(0, 8).replaceAll(":", "");
const name = `проверка-этап3-ограждения-${stamp}`;
const snapshotFolder = path.join(homedir(), "Documents", "RevitMCP", "task9-railings");

/** What the tests share: the levels, the types of stairs and railings, and a wall and a floor type. */
interface World {
  ground: Level;
  upper: Level;
  stairsType: TypeRow;
  /** The type Revit puts on every new stairs. */
  defaultRailing: TypeRow;
  otherRailing: TypeRow;
  wallType: TypeRow;
  floorType: TypeRow;
}

let world: World | undefined;
let nextSceneX = 0;

async function withClient<T>(body: (client: BridgeClient) => Promise<T>): Promise<T> {
  const client = new BridgeClient(defaultConnectionPath());
  try {
    return await body(client);
  } finally {
    client.close();
  }
}

const modelInfo = (client: BridgeClient): Promise<ModelInfo> => client.call("get_model_info", {}) as Promise<ModelInfo>;

const elementsOf = (client: BridgeClient, ids: string[]): Promise<ElementsAnswer> => client.call("get_elements", { ids }) as Promise<ElementsAnswer>;

const createRailings = (client: BridgeClient, items: object[]): Promise<Batch<RailingActual>> =>
  client.call("create_railings", { items }) as Promise<Batch<RailingActual>>;

const listTypes = (client: BridgeClient, category: string): Promise<TypeRow[]> => client.call("list_types", { category }) as Promise<TypeRow[]>;

function ready(): World {
  assert.ok(world, "the first test creates the project");
  return world;
}

/** The x of the next scene, so that no stairs touch. */
function scene(): number {
  const x = nextSceneX;
  nextSceneX += SCENE_PITCH_MM;
  return x;
}

function straight(x: number, y = 0): StairsItem {
  const w = ready();

  return {
    baseLevelId: w.ground.id,
    topLevelId: w.upper.id,
    typeId: w.stairsType.id,
    runsMm: [{ startMm: { x, y }, endMm: { x, y: y + (RISERS - 1) * TREAD_MM } }],
    widthMm: WIDTH_MM,
    desiredRisers: RISERS,
  };
}

function uShaped(x: number, y = 0): StairsItem {
  const w = ready();
  const half = RISERS / 2;
  const runLength = (half - 1) * TREAD_MM;

  return {
    baseLevelId: w.ground.id,
    topLevelId: w.upper.id,
    typeId: w.stairsType.id,
    runsMm: [
      { startMm: { x, y }, endMm: { x, y: y + runLength } },
      { startMm: { x: x + RUN_PITCH_MM, y: y + runLength }, endMm: { x: x + RUN_PITCH_MM, y } },
    ],
    widthMm: WIDTH_MM,
    desiredRisers: RISERS,
  };
}

/** Builds stairs and returns what the railings need of them. Revit has put its own railings on them by then. */
async function buildStairs(client: BridgeClient, item: StairsItem): Promise<Landed> {
  const batch = (await client.call("create_stairs", { items: [item] })) as Batch<StairsActual>;
  assert.equal(batch.committed, true, JSON.stringify(batch).slice(0, 1500));

  const [built] = batch.items;
  assert.ok(built?.elementId && built.actual, JSON.stringify(batch));
  assert.equal(built.status, "created");

  return { stairsId: built.elementId, footprint: built.actual.footprintMm, railingIds: built.actual.railingIds };
}

/** Takes the railings Revit put on new stairs off them, as the only way to a stairs with none. */
async function deleteRailings(client: BridgeClient, ids: string[]): Promise<void> {
  const deleted = (await client.call("delete_elements", { ids, dryRun: false })) as { committed: boolean; errors: string[] };

  assert.equal(deleted.committed, true, JSON.stringify(deleted).slice(0, 800));
}

function assertNear(actual: unknown, expected: number, what: string, within = NEAR_MM): void {
  assert.equal(typeof actual, "number", what);
  assert.ok(Math.abs((actual as number) - expected) < within, `${what}: ${String(actual)}, expected ${expected}`);
}

/** A call that landed with nothing to warn about, and its one item. */
function landed(batch: Batch<RailingActual>, status: string): Item<RailingActual> & { elementId: string; actual: RailingActual } {
  assert.equal(batch.committed, true, JSON.stringify(batch).slice(0, 1500));
  assert.deepEqual(batch.errors, []);
  assert.deepEqual(batch.dialogs, []);
  assert.deepEqual(batch.warnings, [], "nothing here should give Revit something to warn about");

  const [item] = batch.items;
  assert.ok(item?.elementId && item.actual, JSON.stringify(batch));
  assert.equal(item.status, status, JSON.stringify(batch).slice(0, 1500));

  return item as Item<RailingActual> & { elementId: string; actual: RailingActual };
}

/** What a call can add to the model, to compare before and after one that must leave nothing. */
async function railingCount(client: BridgeClient): Promise<number> {
  const info = await modelInfo(client);

  return info.categoryCounts.find((entry) => entry.category === "OST_StairsRailing")?.count ?? 0;
}

/** Calls create_railings where it must refuse before anything changes, and returns the refusal. */
async function refusedAndUnchanged(client: BridgeClient, params: object, pattern: RegExp, what: string): Promise<BridgeRpcError> {
  await client.call("save_project", {});
  const before = await railingCount(client);

  const error = await client.call("create_railings", params).then(
    (result) => assert.fail(`${what}: should be refused, and returned ${JSON.stringify(result).slice(0, 500)}`),
    (reason: unknown) => reason,
  );

  assert.ok(error instanceof BridgeRpcError, `${what}: expected a plugin error, got ${String(error)}`);
  assert.equal(error.code, INVALID_PARAMS, error.message);
  assert.match(error.message, pattern, what);
  assert.equal(await railingCount(client), before, `${what}: a refused call makes no railing`);
  assert.equal((await modelInfo(client)).activeDocument?.isModified, false, `${what}: a refused call changes nothing`);

  return error;
}

/** The box that holds all the boxes given. */
function hull(boxes: Box[]): Box {
  assert.ok(boxes.length > 0);

  return {
    min: { x: Math.min(...boxes.map((box) => box.min.x)), y: Math.min(...boxes.map((box) => box.min.y)), z: Math.min(...boxes.map((box) => box.min.z)) },
    max: { x: Math.max(...boxes.map((box) => box.max.x)), y: Math.max(...boxes.map((box) => box.max.y)), z: Math.max(...boxes.map((box) => box.max.z)) },
  };
}

async function boxOf(client: BridgeClient, ids: string[]): Promise<Box> {
  const { elements, notFound } = await elementsOf(client, ids);

  assert.deepEqual(notFound, []);
  assert.deepEqual(
    elements.map((row) => row.category),
    ids.map(() => "railings"),
  );

  return hull(elements.map((row) => row.boundingBoxMm).filter((box): box is Box => box !== null));
}

function boxAround(points: PlanPoint[]): { minX: number; maxX: number; minY: number; maxY: number } {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);

  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

/** The outline of the opening of a stairs, closed by repeating its first corner. */
const closed = (corners: PlanPoint[]): PlanPoint[] => [...corners, corners[0] as PlanPoint];

/** A floor of the upper level that holds a stairs, and the opening cut in it along the footprint of the stairs. */
async function floorWithOpening(client: BridgeClient, footprint: PlanPoint[]): Promise<string> {
  const w = ready();
  const box = boxAround(footprint);
  const corners = [
    { x: box.minX - 3000, y: box.minY - 3000 },
    { x: box.maxX + 3000, y: box.minY - 3000 },
    { x: box.maxX + 3000, y: box.maxY + 3000 },
    { x: box.minX - 3000, y: box.maxY + 3000 },
  ];
  const floors = (await client.call("create_floors", { items: [{ boundaryMm: corners, typeId: w.floorType.id, levelId: w.upper.id }] })) as Batch<unknown>;
  assert.equal(floors.committed, true, JSON.stringify(floors));

  const floorId = floors.items[0]?.elementId;
  assert.ok(floorId);

  const opening = (await client.call("create_floor_openings", { items: [{ floorId, boundaryMm: footprint }] })) as Batch<unknown>;
  assert.equal(opening.committed, true, JSON.stringify(opening));
  assert.equal(opening.items[0]?.status, "created", JSON.stringify(opening));

  return floorId;
}

async function snapshot(client: BridgeClient, title: string, centre: { x: number; y: number }): Promise<void> {
  const view = (await client.call("create_3d_view", {
    name: `${title} ${stamp}`,
    kind: "perspective",
    displayStyle: "realistic",
    eyeMm: { x: centre.x + 7000, y: centre.y - 6000, z: 6500 },
    targetMm: { x: centre.x, y: centre.y, z: 2500 },
  })) as { committed: boolean; viewId: string };
  assert.equal(view.committed, true, JSON.stringify(view));

  const shot = (await client.call("get_view_snapshot", { viewId: view.viewId, widthPx: SNAPSHOT_WIDTH_PX })) as { path: string; dialogs: unknown[] };
  assert.deepEqual(shot.dialogs, []);

  await mkdir(snapshotFolder, { recursive: true });
  const kept = path.join(snapshotFolder, `${title}-${stamp}.png`);
  await copyFile(shot.path, kept);
  console.log(`# snapshot: ${kept}`);
}

describe("stage 3 live checks: railings", { timeout: 180_000 }, () => {
  it("creates a project for this run", async () => {
    await withClient(async (client) => {
      await client.call("create_project", { name });

      const levels = (await client.call("create_levels", { items: [{ name: `Этаж 2 ${stamp}`, elevationMm: STOREY_MM }] })) as Batch<unknown>;
      assert.equal(levels.committed, true, JSON.stringify(levels));

      const [ground, upper] = [...(await modelInfo(client)).levels].sort((a, b) => a.elevationMm - b.elevationMm);
      assert.ok(ground && upper);
      assert.equal(upper.elevationMm, STOREY_MM);

      const stairsType = (await listTypes(client, "stairs")).find((type) => type.name.includes("190") && type.name.includes("250"));
      const railingTypes = await listTypes(client, "railings");
      const defaultRailing = railingTypes.find((type) => type.name === "1100 мм");
      const otherRailing = railingTypes.find((type) => type.name === "900 мм");
      const [wallType] = await listTypes(client, "walls");
      const [floorType] = await listTypes(client, "floors");
      assert.ok(stairsType && defaultRailing && otherRailing && wallType && floorType, JSON.stringify(railingTypes));

      world = { ground, upper, stairsType, defaultRailing, otherRailing, wallType, floorType };
      console.log(`# types: ${JSON.stringify({ stairsType, defaultRailing, otherRailing })}`);
    });
  });

  it("stairs get railings", async () => {
    await withClient(async (client) => {
      const w = ready();

      // Revit puts its own railings on a new stairs, two for a straight one, of the default type.
      const stairs = await buildStairs(client, straight(scene()));
      assert.equal(stairs.railingIds.length, 2);
      const own = await elementsOf(client, stairs.railingIds);
      assert.deepEqual(
        own.elements.map((row) => [row.category, row.typeName]),
        stairs.railingIds.map(() => ["railings", w.defaultRailing.name]),
      );

      // Take them off: the only stairs railings can be made on has none. Then they are made by the tool, on the stringers.
      await deleteRailings(client, stairs.railingIds);
      const before = await railingCount(client);

      const onStringers = landed(await createRailings(client, [{ stairsId: stairs.stairsId, typeId: w.otherRailing.id, position: "stringer" }]), "created");

      console.log(`# on stringers: ${JSON.stringify(onStringers.actual)}`);
      assert.equal(onStringers.actual.hostId, stairs.stairsId);
      assert.equal(onStringers.actual.pathMm, null);
      assert.equal(onStringers.actual.elevationMm, null);
      assert.equal(onStringers.actual.railings.length, 2, "one railing for each side");
      assert.deepEqual(
        onStringers.actual.railings.map((row) => [row.typeId, row.typeName]),
        onStringers.actual.railings.map(() => [w.otherRailing.id, w.otherRailing.name]),
      );
      const ids = onStringers.actual.railings.map((row) => row.id);
      assert.equal(onStringers.elementId, ids[0], "the item reports the railing with the lowest id");
      assert.deepEqual(ids, [...ids].sort((a, b) => Number(a) - Number(b)));
      assert.equal((await railingCount(client)) - before, 2);

      const foot = boxAround(stairs.footprint);
      const stringerBox = await boxOf(client, ids);
      assert.ok(stringerBox.max.x > foot.maxX + 1 && stringerBox.min.x < foot.minX - 1, `railings on the stringers stand outside the run: ${JSON.stringify(stringerBox)} against ${JSON.stringify(foot)}`);

      // The same on the treads stands inside the width of the run.
      const second = await buildStairs(client, straight(scene()));
      await deleteRailings(client, second.railingIds);
      const onTreads = landed(await createRailings(client, [{ stairsId: second.stairsId, typeId: w.defaultRailing.id, position: "treads" }]), "created");

      assert.equal(onTreads.actual.railings.length, 2);
      assert.equal(onTreads.actual.railings[0]?.typeId, w.defaultRailing.id);
      const secondFoot = boxAround(second.footprint);
      const treadBox = await boxOf(
        client,
        onTreads.actual.railings.map((row) => row.id),
      );
      assert.ok(treadBox.max.x <= secondFoot.maxX + NEAR_MM && treadBox.min.x >= secondFoot.minX - NEAR_MM, `railings on the treads stand inside the run: ${JSON.stringify(treadBox)} against ${JSON.stringify(secondFoot)}`);
    });
  });

  it("railing along a floor opening", async () => {
    await withClient(async (client) => {
      const w = ready();
      const x = scene();
      const stairs = await buildStairs(client, uShaped(x));
      await floorWithOpening(client, stairs.footprint);
      const before = await railingCount(client);

      const item = landed(await createRailings(client, [{ pathMm: closed(stairs.footprint), typeId: w.defaultRailing.id, levelId: w.upper.id }]), "created");

      console.log(`# along the opening: ${JSON.stringify(item.actual)}`);
      assert.equal(item.actual.hostId, null);
      assert.equal(item.actual.railings.length, 1);
      assert.equal(item.actual.railings[0]?.id, item.elementId);
      assert.equal(item.actual.railings[0]?.typeId, w.defaultRailing.id);
      assertNear(item.actual.elevationMm, w.upper.elevationMm, "the railing stands on the upper level", POINT_MM);
      assert.equal((await railingCount(client)) - before, 1);

      // The path is the opening: every corner of it, in the order given, as the railing holds it.
      const wanted = closed(stairs.footprint);
      assert.equal(item.actual.pathMm?.length, wanted.length);
      for (const [index, point] of wanted.entries()) {
        assertNear(item.actual.pathMm?.[index]?.x, point.x, `x of point ${index}`, POINT_MM);
        assertNear(item.actual.pathMm?.[index]?.y, point.y, `y of point ${index}`, POINT_MM);
      }

      // And so is the railing in the model: on the level, as tall as its type, and round the opening.
      const box = await boxOf(client, [item.elementId]);
      const foot = boxAround(stairs.footprint);
      assertNear(box.min.z, w.upper.elevationMm, "foot of the railing", 1);
      assertNear(box.max.z - box.min.z, DEFAULT_RAILING_HEIGHT_MM, "height of the railing", 5);
      assert.ok(box.min.x <= foot.minX && box.max.x >= foot.maxX && box.min.y <= foot.minY && box.max.y >= foot.maxY, `the railing holds the opening: ${JSON.stringify(box)} against ${JSON.stringify(foot)}`);
      assert.ok(box.max.x - foot.maxX < 200 && foot.minX - box.min.x < 200, "and hugs it");

      // An open path of three sides, with the fourth left for the way onto the floor, round another opening: a railing that does not close.
      const other = await buildStairs(client, straight(scene()));
      await floorWithOpening(client, other.footprint);
      const [first, second, third, fourth] = other.footprint;
      assert.ok(first && second && third && fourth);
      const open = landed(await createRailings(client, [{ pathMm: [first, second, third, fourth], typeId: w.otherRailing.id, levelId: w.upper.id }]), "created");

      assert.equal(open.actual.pathMm?.length, 4);
      assert.equal(open.actual.railings[0]?.typeId, w.otherRailing.id);
      assert.notEqual(open.elementId, item.elementId);
      const openBox = await boxOf(client, [open.elementId]);
      assertNear(openBox.min.z, w.upper.elevationMm, "foot of the open railing", 1);
    });
  });

  it("second call on the same stairs is already_existed", async () => {
    await withClient(async (client) => {
      const w = ready();
      const stairs = await buildStairs(client, straight(scene()));
      await client.call("save_project", {});

      const again = landed(await createRailings(client, [{ stairsId: stairs.stairsId, typeId: w.defaultRailing.id, position: "treads" }]), "already_existed");

      console.log(`# already there: ${JSON.stringify(again)}`);
      assert.equal(again.elementId, [...stairs.railingIds].sort((a, b) => Number(a) - Number(b))[0], "the lowest id of the railings that are there");
      assert.equal(again.actual.hostId, stairs.stairsId);
      assert.deepEqual(
        again.actual.railings.map((row) => row.id),
        [...stairs.railingIds].sort((a, b) => Number(a) - Number(b)),
        "the ids are those create_stairs gave",
      );
      assert.deepEqual(
        again.actual.railings.map((row) => [row.typeId, row.typeName]),
        stairs.railingIds.map(() => [w.defaultRailing.id, w.defaultRailing.name]),
        "the real type",
      );
      assert.deepEqual(again.warnings, []);
      assert.equal((await modelInfo(client)).activeDocument?.isModified, false, "nothing was made, so there is no transaction and no unsaved change");

      // Another type does not change the railings that are there: it is a warning that says how to change them.
      const other = landed(await createRailings(client, [{ stairsId: stairs.stairsId, typeId: w.otherRailing.id, position: "stringer" }]), "already_existed");

      assert.deepEqual(
        other.actual.railings.map((row) => row.id),
        again.actual.railings.map((row) => row.id),
      );
      assert.equal(other.actual.railings[0]?.typeId, w.defaultRailing.id, "the real type, and not the one asked for");
      console.log(`# warning: ${JSON.stringify(other.warnings)}`);
      assert.equal(other.warnings.length, 1, JSON.stringify(other.warnings));
      assert.match(other.warnings[0] ?? "", /update_elements/);
      assert.match(other.warnings[0] ?? "", new RegExp(stairs.railingIds[0] as string));
      assert.match(other.warnings[0] ?? "", /Nothing was changed/);
      assert.equal((await modelInfo(client)).activeDocument?.isModified, false);
      const { elements } = await elementsOf(client, stairs.railingIds);
      assert.deepEqual(
        elements.map((row) => row.typeName),
        stairs.railingIds.map(() => w.defaultRailing.name),
      );

      // Next to a railing that is made, the same stairs stays as it was and the batch is one transaction.
      const x = scene();
      const mixed = await createRailings(client, [
        { stairsId: stairs.stairsId, typeId: w.defaultRailing.id, position: "treads" },
        { pathMm: [{ x, y: 0 }, { x: x + 2000, y: 0 }], typeId: w.defaultRailing.id, levelId: w.upper.id },
      ]);

      assert.equal(mixed.committed, true, JSON.stringify(mixed).slice(0, 1200));
      assert.deepEqual(
        mixed.items.map((item) => item.status),
        ["already_existed", "created"],
      );
      assert.deepEqual(mixed.items[0]?.warnings, []);
      assert.equal(mixed.items[1]?.actual?.railings.length, 1);
    });
  });

  it("invalid path fails before any change", async () => {
    await withClient(async (client) => {
      const w = ready();
      const x = scene();
      const path = [{ x, y: 0 }, { x: x + 3000, y: 0 }, { x: x + 3000, y: 2000 }];
      const good = { pathMm: path, typeId: w.defaultRailing.id, levelId: w.upper.id };
      const stairs = await buildStairs(client, straight(scene()));
      const wallId = ((await client.call("create_walls", {
        items: [{ startMm: { x: -9000, y: -9000 }, endMm: { x: -6000, y: -9000 }, typeId: w.wallType.id, levelId: w.ground.id, heightMm: STOREY_MM }],
      })) as Batch<unknown>).items[0]?.elementId;
      assert.ok(wallId);

      const onStairs = { stairsId: stairs.stairsId, typeId: w.defaultRailing.id, position: "treads" };

      for (const [items, pattern, what] of [
        [[{ ...good, pathMm: [path[0]] }], /pathMm must be a list of at least 2 points/, "one point"],
        [[{ ...good, pathMm: [] }], /pathMm must be a list of at least 2 points/, "no point"],
        [[{ ...good, pathMm: [{ x }, path[1]] }], /pathMm must be a point with x and y/, "a point with no y"],
        [[{ ...good, pathMm: [path[0], path[0]] }], /pathMm points 0 and 1 are closer than/, "a point twice in a row"],
        [[{ ...good, pathMm: [path[0], { x: x + 0.001, y: 0 }, path[1]] }], /pathMm points 0 and 1 are closer than/, "an edge too short to draw"],
        [[{ ...good, pathMm: [path[0], path[1], path[2], path[1], { x: x + 5000, y: 0 }] }], /does not take pathMm as a railing path/, "three edges that meet in one point"],
        [[{ ...good, typeId: w.wallType.id }], /typeId .* is not a type of railings/, "a wall type"],
        [[{ ...good, typeId: "1" }], /is not a type of railings/, "no type"],
        [[{ ...good, levelId: "1" }], /is not a level/, "no level"],
        [[{ ...good, levelId: undefined }], /levelId must be an element id/, "no level given"],
        [[{ ...good, position: "treads" }], /position belongs to an item with stairsId/, "a path with a position"],
        [[{ ...onStairs, stairsId: wallId }], /is not one of the stairs of this model/, "a wall for a stairs"],
        [[{ ...onStairs, stairsId: "1" }], /is not one of the stairs of this model/, "no stairs"],
        [[{ ...onStairs, typeId: w.stairsType.id }], /is not a type of railings/, "a stairs type for a railing type"],
        [[{ ...onStairs, position: undefined }], /position is required/, "no position"],
        [[{ ...onStairs, position: "left" }], /position must be 'treads' or 'stringer'/, "a position that is none"],
        [[{ ...onStairs, levelId: w.upper.id }], /levelId belongs to an item with pathMm/, "stairs with a level"],
        [[{ ...onStairs, pathMm: path }], /both stairsId and pathMm/, "both kinds in one item"],
        [[{ typeId: w.defaultRailing.id }], /neither stairsId nor pathMm/, "neither kind"],
        [[onStairs, onStairs], /items 0 and 1 both put railings on stairs/, "the same stairs twice"],
        [[good, { ...good, pathMm: [path[0]] }], /create_railings item 1/, "a valid item before an invalid one"],
      ] as const) {
        await refusedAndUnchanged(client, { items }, pattern, what);
      }

      // Revit's own word on the path is named in the refusal, with the item.
      const star = await refusedAndUnchanged(client, { items: [{ ...good, pathMm: [path[0], path[1], path[2], path[1], { x: x + 5000, y: 0 }] }] }, /create_railings item 0/, "the star");
      console.log(`# refusal: ${star.message}`);
    });
  });

  it("one call is one undo step", async (t) => {
    await withClient(async (client) => {
      const w = ready();
      const stairs = await buildStairs(client, straight(scene()));
      await deleteRailings(client, stairs.railingIds);
      const before = await railingCount(client);
      const x = scene();

      const batch = await createRailings(client, [
        { stairsId: stairs.stairsId, typeId: w.otherRailing.id, position: "stringer" },
        { pathMm: [{ x, y: 0 }, { x: x + 2000, y: 0 }], typeId: w.defaultRailing.id, levelId: w.upper.id },
      ]);
      assert.equal(batch.committed, true, JSON.stringify(batch).slice(0, 1200));
      assert.deepEqual(
        batch.items.map((item) => item.status),
        ["created", "created"],
      );
      const made = [...(batch.items[0]?.actual?.railings ?? []), ...(batch.items[1]?.actual?.railings ?? [])].map((row) => row.id);
      assert.equal(made.length, 3);
      assert.equal((await railingCount(client)) - before, 3);

      const undone = await undoWithOneRetry(t, client);

      console.log(`# undo: ${JSON.stringify({ ...undone, createdIds: undone.createdIds.length })}`);
      assert.equal(undone.transactionName, "MCP: create_railings");
      for (const id of made) {
        assert.ok(undone.createdIds.includes(id), `railing ${id} is named as created`);
      }
      assert.deepEqual((await elementsOf(client, made)).notFound, made);
      assert.equal(await railingCount(client), before, "all the railings of the call went with it");
      assert.deepEqual((await elementsOf(client, [stairs.stairsId])).notFound, [], "the stairs below it are still there");
    });
  });

  it("railings can be looked at, round an opening and on stairs", async () => {
    await withClient(async (client) => {
      const w = ready();
      const stairs = await buildStairs(client, uShaped(0, PICTURE_SCENE_Y_MM));
      await floorWithOpening(client, stairs.footprint);

      // The side where people come onto the floor stays open: the path starts at the head of the stairs and runs round the other three.
      const [foot0, foot1, foot2, foot3] = stairs.footprint;
      assert.ok(foot0 && foot1 && foot2 && foot3);
      landed(await createRailings(client, [{ pathMm: [foot3, foot0, foot1, foot2], typeId: w.defaultRailing.id, levelId: w.upper.id }]), "created");

      await snapshot(client, "ограждение-проём", { x: 1000, y: PICTURE_SCENE_Y_MM + 1400 });
    });
  });

  it("leaves Revit in a state the close rule accepts", async () => {
    await withClient(async (client) => {
      await client.call("save_project", {});

      assert.deepEqual(checkCanClose((await modelInfo(client)).openDocuments), { ok: true, reasons: [] });
    });
  });
});
