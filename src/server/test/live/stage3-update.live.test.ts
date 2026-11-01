import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { checkCanClose } from "../../src/cli/closeRule.ts";
import { BridgeClient } from "../../src/client.ts";
import { defaultConnectionPath } from "../../src/connection.ts";
import { BridgeRpcError } from "../../src/errors.ts";
import { undoWithOneRetry } from "../undoRetry.ts";

// These tests need a running Revit with the RevitMCP plugin loaded. Each run creates one new project in the test folder and
// leaves it open and saved. They move, turn and retype real walls, doors, beds and railings and write their parameters. What the
// tool says is checked against the model, read another way: the box of the element (get_elements), the openings another tool
// finds in a wall, and a second call that must find nothing left to change. Scenes stand far apart, so no wall of one touches another.

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

interface Point3 {
  x: number;
  y: number;
  z: number;
}

interface Box {
  min: Point3;
  max: Point3;
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

interface TypeActual {
  id: string;
  name: string;
  widthMm: number | null;
  heightMm: number | null;
}

interface FamilyActual {
  familyId: string;
  typeIds: TypeActual[];
}

interface UpdateActual {
  typeId: string | null;
  typeName: string | null;
  pointMm: Point3 | null;
  rotationDeg: number | null;
  startMm: Point3 | null;
  endMm: Point3 | null;
  boundingBoxMm: Box | null;
  parameters: Array<{ builtIn: string; value: number | string | boolean | null }>;
}

interface ElementRow {
  id: string;
  category: string | null;
  typeName: string | null;
  levelId: string | null;
  boundingBoxMm: Box | null;
  topMm?: number | null;
}

interface ElementsAnswer {
  elements: ElementRow[];
  notFound: string[];
}

type UpdateItem = {
  id: string;
  moveMm?: { x: number; y: number; z: number };
  rotateDeg?: number;
  typeId?: string;
  parameters?: Array<{ builtIn: string; value: unknown }>;
};

const INVALID_PARAMS = -32602;
const NEAR_MM = 0.01;
/** A box of a turned element is read to the millimetre. */
const BOX_NEAR_MM = 1;
const SCENE_PITCH_MM = 20000;
const WALL_LENGTH_MM = 6000;
const WALL_HEIGHT_MM = 3000;
const STOREY_MM = 4000;

/** The library of this machine, the same folder as LibraryFolder.Root in the plugin. */
const DOOR = "Russia\\Двери\\Дверь-Одинарная-Панель.rfa";
const BED = "Russia\\Мебель\\Кровати\\Кровать-Стандарт.rfa";

const stamp = new Date().toTimeString().slice(0, 8).replaceAll(":", "");
const name = `проверка-этап3-изменения-${stamp}`;

/** What the tests share: the levels, the types to build with, and the beds and railing types to change between. */
interface World {
  ground: Level;
  upper: Level;
  wallType: TypeRow;
  floorType: TypeRow;
  door: TypeActual;
  beds: TypeActual[];
  railings: TypeRow[];
}

let world: World | undefined;
let nextSceneY = 0;

async function withClient<T>(body: (client: BridgeClient) => Promise<T>): Promise<T> {
  const client = new BridgeClient(defaultConnectionPath());
  try {
    return await body(client);
  } finally {
    client.close();
  }
}

const modelInfo = (client: BridgeClient): Promise<ModelInfo> => client.call("get_model_info", {}) as Promise<ModelInfo>;

const listTypes = (client: BridgeClient, category: string): Promise<TypeRow[]> => client.call("list_types", { category }) as Promise<TypeRow[]>;

const elementsOf = (client: BridgeClient, ids: string[]): Promise<ElementsAnswer> => client.call("get_elements", { ids }) as Promise<ElementsAnswer>;

const update = (client: BridgeClient, items: UpdateItem[]): Promise<Batch<UpdateActual>> => client.call("update_elements", { items }) as Promise<Batch<UpdateActual>>;

function ready(): World {
  assert.ok(world, "the first test creates the project");
  return world;
}

/** The start of the next scene, in y, so that no scene touches another. */
function scene(): number {
  const y = nextSceneY;
  nextSceneY += SCENE_PITCH_MM;
  return y;
}

/** Calls a method that must refuse, and returns the refusal. */
async function refusal(client: BridgeClient, method: string, params: object): Promise<BridgeRpcError> {
  const error = await client.call(method, params).then(
    (result) => assert.fail(`${method} ${JSON.stringify(params).slice(0, 300)} should be refused, and returned ${JSON.stringify(result).slice(0, 500)}`),
    (reason: unknown) => reason,
  );

  assert.ok(error instanceof BridgeRpcError, `${method}: expected a plugin error, got ${String(error)}`);
  assert.equal(error.code, INVALID_PARAMS, error.message);
  return error;
}

function assertNear(actual: unknown, expected: number, what: string, within = NEAR_MM): void {
  assert.equal(typeof actual, "number", what);
  assert.ok(Math.abs((actual as number) - expected) < within, `${what}: ${String(actual)}, expected ${expected}`);
}

/** A call that landed with nothing for Revit to warn about, and its items, each with the status asked for. */
function landed(batch: Batch<UpdateActual>, ...statuses: string[]): Array<Item<UpdateActual> & { elementId: string; actual: UpdateActual }> {
  assert.equal(batch.committed, true, JSON.stringify(batch).slice(0, 1500));
  assert.deepEqual(batch.errors, []);
  assert.deepEqual(batch.dialogs, []);
  assert.deepEqual(batch.warnings, [], "nothing here should give Revit something to warn about");
  assert.equal(batch.items.length, statuses.length, JSON.stringify(batch).slice(0, 1500));

  return batch.items.map((item, index) => {
    assert.equal(item.status, statuses[index], JSON.stringify(item));
    assert.ok(item.elementId && item.actual, JSON.stringify(item));
    return item as Item<UpdateActual> & { elementId: string; actual: UpdateActual };
  });
}

async function isModified(client: BridgeClient): Promise<boolean> {
  const active = (await modelInfo(client)).activeDocument;
  assert.ok(active);
  return active.isModified;
}

/** Saves, so that a later read of isModified says whether a call changed anything. */
async function saved(client: BridgeClient): Promise<void> {
  await client.call("save_project", {});
  assert.equal(await isModified(client), false);
}

/** The box of an element in the model. */
async function boxOf(client: BridgeClient, id: string): Promise<Box> {
  const [row] = (await elementsOf(client, [id])).elements;
  assert.ok(row?.boundingBoxMm, `element ${id} has a box`);

  return row.boundingBoxMm;
}

async function rowOf(client: BridgeClient, id: string): Promise<ElementRow> {
  const answer = await elementsOf(client, [id]);
  assert.deepEqual(answer.notFound, [], `element ${id} is in the model`);
  const [row] = answer.elements;
  assert.ok(row);

  return row;
}

/** A box moved by a vector: every corner shifts by it. */
function assertShifted(before: Box, after: Box, by: Point3, what: string, within = NEAR_MM): void {
  for (const corner of ["min", "max"] as const) {
    for (const axis of ["x", "y", "z"] as const) {
      assertNear(after[corner][axis] - before[corner][axis], by[axis], `${what}: ${corner}.${axis}`, within);
    }
  }
}

const sizeOf = (box: Box): Point3 => ({ x: box.max.x - box.min.x, y: box.max.y - box.min.y, z: box.max.z - box.min.z });

/** A straight wall on a level, as the model has it. */
async function makeWall(
  client: BridgeClient,
  from: { x: number; y: number },
  to: { x: number; y: number },
  extra: { level?: Level; heightMm?: number } = {},
): Promise<string> {
  const w = ready();
  const batch = (await client.call("create_walls", {
    items: [{ startMm: from, endMm: to, typeId: w.wallType.id, levelId: (extra.level ?? w.ground).id, heightMm: extra.heightMm ?? WALL_HEIGHT_MM }],
  })) as Batch<unknown>;
  assert.equal(batch.committed, true, JSON.stringify(batch).slice(0, 1500));
  const [wall] = batch.items;
  assert.ok(wall?.elementId && wall.status === "created", JSON.stringify(batch).slice(0, 800));

  return wall.elementId;
}

/** The wall along +X from x 0 to 6000, in a scene of its own. */
async function wallAlongX(client: BridgeClient): Promise<{ id: string; y: number }> {
  const y = scene();

  return { id: await makeWall(client, { x: 0, y }, { x: WALL_LENGTH_MM, y }), y };
}

/** A door of the shared type in a wall. */
async function doorIn(client: BridgeClient, wallId: string, offsetAlongWallMm: number): Promise<string> {
  const w = ready();
  const batch = (await client.call("place_hosted", { items: [{ typeId: w.door.id, wallId, offsetAlongWallMm }] })) as Batch<unknown>;
  assert.equal(batch.committed, true, JSON.stringify(batch).slice(0, 1500));
  const [door] = batch.items;
  assert.ok(door?.elementId && door.status === "created", JSON.stringify(batch).slice(0, 800));

  return door.elementId;
}

/** A floor of 3000 x 3000 on the ground level, with its corner at x 0 and the y given. */
async function floorAt(client: BridgeClient, y: number): Promise<string> {
  const w = ready();
  const batch = (await client.call("create_floors", {
    items: [{ boundaryMm: [{ x: 0, y }, { x: 3000, y }, { x: 3000, y: y + 3000 }, { x: 0, y: y + 3000 }], typeId: w.floorType.id, levelId: w.ground.id }],
  })) as Batch<unknown>;
  const floor = batch.items[0];
  assert.ok(batch.committed && floor?.elementId && floor.status === "created", JSON.stringify(batch).slice(0, 800));

  return floor.elementId;
}

/** A bed of the type given, standing on the ground level at a point. */
async function bedAt(client: BridgeClient, typeId: string, x: number, y: number): Promise<string> {
  const w = ready();
  const batch = (await client.call("place_instances", { items: [{ typeId, pointMm: { x, y }, levelId: w.ground.id }] })) as Batch<unknown>;
  assert.equal(batch.committed, true, JSON.stringify(batch).slice(0, 1500));
  const [bed] = batch.items;
  assert.ok(bed?.elementId && bed.status === "created", JSON.stringify(batch).slice(0, 800));

  return bed.elementId;
}

/** Calls update_elements where it must refuse before anything changes: the refusal names the item, and the model stays as saved. */
async function refusedAndUnchanged(client: BridgeClient, items: unknown[], pattern: RegExp, what: string): Promise<BridgeRpcError> {
  await saved(client);

  const refused = await refusal(client, "update_elements", { items });
  assert.match(refused.message, pattern, `${what}: ${refused.message}`);
  assert.match(refused.message, /update_elements item \d+/, `${what}: the refusal should name the item`);
  assert.equal(await isModified(client), false, `${what}: a refused call changes nothing`);

  return refused;
}

describe("stage 3 live checks: element updates", { timeout: 900_000 }, () => {
  it("creates a project for this run, with the types it needs", async () => {
    await withClient(async (client) => {
      await client.call("create_project", { name });

      const levels = (await client.call("create_levels", { items: [{ name: `Этаж 2 ${stamp}`, elevationMm: STOREY_MM }] })) as Batch<unknown>;
      assert.equal(levels.committed, true, JSON.stringify(levels));

      const info = await modelInfo(client);
      assert.equal(info.activeDocument?.title, name);
      const [ground, upper] = [...info.levels].sort((a, b) => a.elevationMm - b.elevationMm);
      assert.ok(ground && upper);
      assert.equal(ground.elevationMm, 0);
      assert.equal(upper.elevationMm, STOREY_MM);

      const walls = await listTypes(client, "walls");
      const wallType = walls.find((row) => /^Наружный - Стена из бруса толщиной 180 мм/.test(row.name));
      assert.ok(wallType, `no wall type to build with in ${JSON.stringify(walls.map((row) => row.name))}`);
      const [floorType] = await listTypes(client, "floors");
      assert.ok(floorType);
      const railings = await listTypes(client, "railings");
      assert.ok(railings.length >= 2, `two railing types to change between: ${JSON.stringify(railings)}`);

      // The sizes are given: a catalog row that is loaded as it is has the size of its family, not the one its name says.
      const [doorFamily] = ((await client.call("load_family", { items: [{ path: DOOR, typeName: "800 x 2100 мм", widthMm: 800, heightMm: 2100 }] })) as Batch<FamilyActual>).items;
      const door = doorFamily?.actual?.typeIds.find((row) => row.name === "800 x 2100 мм");
      assert.ok(door, JSON.stringify(doorFamily));

      // The whole family: every type it holds, so that a bed can change between them.
      const [bedFamily] = ((await client.call("load_family", { items: [{ path: BED }] })) as Batch<FamilyActual>).items;
      const beds = bedFamily?.actual?.typeIds ?? [];
      assert.ok(beds.length >= 2, `two bed types to change between: ${JSON.stringify(bedFamily)}`);

      world = { ground, upper, wallType, floorType, door, beds, railings };
      console.log(`# world: ${JSON.stringify({ ground, upper, wallType, door, beds: beds.map((bed) => bed.name), railings: railings.map((row) => row.name) })}`);
    });
  });

  it("move changes the location", async () => {
    await withClient(async (client) => {
      const { id: wallId, y } = await wallAlongX(client);
      const before = await boxOf(client, wallId);
      const by = { x: 1234.5, y: -2000.25, z: 0 };

      const [wall] = landed(await update(client, [{ id: wallId, moveMm: by }]), "updated");
      assert.ok(wall);
      assert.equal(wall.elementId, wallId, "the element is the same one");
      assert.deepEqual(wall.requested, { id: wallId, moveMm: by }, "the request comes back as it was sent");

      // The model, read another way: every corner of the box shifted by the vector, in millimetres in model coordinates.
      assertShifted(before, await boxOf(client, wallId), by, "wall box");

      // And what the tool reports: the two ends of the axis of the wall.
      assertNear(wall.actual.startMm?.x, 0 + by.x, "start x");
      assertNear(wall.actual.startMm?.y, y + by.y, "start y");
      assertNear(wall.actual.endMm?.x, WALL_LENGTH_MM + by.x, "end x");
      assertNear(wall.actual.endMm?.y, y + by.y, "end y");
      assert.equal(wall.actual.pointMm, null, "a wall has a line and no point");
      assert.equal(wall.actual.rotationDeg, null);
      assertNear(wall.actual.startMm?.z, 0, "start z");
    });
  });

  it("a wall is not moved up or down, and the refusal says how to", async () => {
    await withClient(async (client) => {
      const { id: wallId } = await wallAlongX(client);

      await refusedAndUnchanged(client, [{ id: wallId, moveMm: { x: 100, y: 0, z: 300 } }], /moveMm\.z is 300.*does not move up or down.*WALL_BASE_OFFSET.*WALL_BASE_CONSTRAINT/s, "a wall moved up");
    });
  });

  it("a call of settled and changing items reports each, and makes one step for the ones that change", async () => {
    await withClient(async (client) => {
      const w = ready();
      const { id: wallId } = await wallAlongX(client);
      const bedId = await bedAt(client, w.beds[0]!.id, 1000, scene());
      const before = await boxOf(client, wallId);

      const [settled, changed] = landed(
        await update(client, [{ id: bedId, typeId: w.beds[0]!.id }, { id: wallId, moveMm: { x: 100, y: 0, z: 0 } }]),
        "unchanged",
        "updated",
      );
      assert.equal(settled?.elementId, bedId);
      assert.equal(settled?.actual.typeId, w.beds[0]!.id);
      assert.equal(changed?.elementId, wallId);
      assertShifted(before, await boxOf(client, wallId), { x: 100, y: 0, z: 0 }, "wall");
    });
  });

  it("a move that makes Revit warn still lands, and the warning reaches the caller", async () => {
    await withClient(async (client) => {
      const y = scene();
      const first = await makeWall(client, { x: 0, y }, { x: WALL_LENGTH_MM, y });
      const second = await makeWall(client, { x: 0, y: y + 1000 }, { x: WALL_LENGTH_MM, y: y + 1000 });

      // The second wall onto the first: Revit accepts two walls on top of each other and warns of it, and does not say which tool did it.
      const batch = await update(client, [{ id: second, moveMm: { x: 0, y: -1000, z: 0 } }]);

      assert.equal(batch.committed, true, JSON.stringify(batch).slice(0, 1200));
      assert.equal(batch.items[0]?.status, "updated");
      assert.ok(batch.warnings.length > 0, `Revit warns of two walls on top of each other: ${JSON.stringify(batch).slice(0, 1200)}`);
      assert.ok(first);
    });
  });

  it("a move by nothing changes nothing and adds no Undo step", async () => {
    await withClient(async (client) => {
      const { id: wallId } = await wallAlongX(client);
      await saved(client);
      const before = await boxOf(client, wallId);

      const [wall] = landed(await update(client, [{ id: wallId, moveMm: { x: 0, y: 0, z: 0 }, rotateDeg: 0 }]), "unchanged");
      assert.ok(wall);
      assert.deepEqual(await boxOf(client, wallId), before);
      assert.equal(await isModified(client), false, "nothing was done, so there is no Undo step and the project is as saved");

      const [turned] = landed(await update(client, [{ id: wallId, rotateDeg: 360 }]), "unchanged");
      assert.ok(turned);
      assert.equal(await isModified(client), false);
    });
  });

  it("rotate turns furniture", async () => {
    await withClient(async (client) => {
      const w = ready();
      const y = scene();
      const bedId = await bedAt(client, w.beds[0]!.id, 1000, y);
      const before = await boxOf(client, bedId);
      const size = sizeOf(before);
      assert.ok(Math.abs(size.x - size.y) > 200, `a bed is longer than it is wide, or the turn shows nothing: ${JSON.stringify(size)}`);

      // A quarter turn counter-clockwise seen from above: the box turns with it, so its two sides swap.
      const [quarter] = landed(await update(client, [{ id: bedId, rotateDeg: 90 }]), "updated");
      assert.ok(quarter);
      assertNear(quarter.actual.rotationDeg, 90, "rotation after 90");
      assertNear(quarter.actual.pointMm?.x, 1000, "the point stays: x");
      assertNear(quarter.actual.pointMm?.y, y, "the point stays: y");
      const turned = sizeOf(await boxOf(client, bedId));
      assertNear(turned.x, size.y, "box x after the turn is the old y", BOX_NEAR_MM);
      assertNear(turned.y, size.x, "box y after the turn is the old x", BOX_NEAR_MM);

      // The turn adds to the one the element has, and the answer is from 0 up to, not including, 360.
      const [more] = landed(await update(client, [{ id: bedId, rotateDeg: 45 }]), "updated");
      assertNear(more?.actual.rotationDeg, 135, "rotation after 45 more");
      const [back] = landed(await update(client, [{ id: bedId, rotateDeg: -135 }]), "updated");
      assertNear(back?.actual.rotationDeg, 0, "rotation after -135, back where it started");
      const [wrapped] = landed(await update(client, [{ id: bedId, rotateDeg: 450 }]), "updated");
      assertNear(wrapped?.actual.rotationDeg, 90, "rotation after 450");

      const again = sizeOf(await boxOf(client, bedId));
      assertNear(again.x, size.y, "box x after 450 is the old y", BOX_NEAR_MM);
    });
  });

  it("a move and a turn in one item land together", async () => {
    await withClient(async (client) => {
      const w = ready();
      const y = scene();
      const bedId = await bedAt(client, w.beds[0]!.id, 1000, y);

      const [bed] = landed(await update(client, [{ id: bedId, moveMm: { x: 500, y: 250, z: 0 }, rotateDeg: 30 }]), "updated");
      assert.ok(bed);
      assertNear(bed.actual.pointMm?.x, 1500, "x after the move");
      assertNear(bed.actual.pointMm?.y, y + 250, "y after the move");
      assertNear(bed.actual.rotationDeg, 30, "rotation after the turn");
    });
  });

  it("wall turns about the middle of its axis", async () => {
    await withClient(async (client) => {
      const { id: wallId, y } = await wallAlongX(client);
      const doorId = await doorIn(client, wallId, 2000);
      const doorBefore = await boxOf(client, doorId);

      // The wall runs from (0, y) to (6000, y), its middle is (3000, y), and a quarter turn counter-clockwise puts the start south and the end north of it.
      const [wall] = landed(await update(client, [{ id: wallId, rotateDeg: 90 }]), "updated");
      assert.ok(wall);
      assertNear(wall.actual.startMm?.x, 3000, "start x", BOX_NEAR_MM / 10);
      assertNear(wall.actual.startMm?.y, y - 3000, "start y", BOX_NEAR_MM / 10);
      assertNear(wall.actual.endMm?.x, 3000, "end x", BOX_NEAR_MM / 10);
      assertNear(wall.actual.endMm?.y, y + 3000, "end y", BOX_NEAR_MM / 10);

      // The door turned with its wall: its box is not where it was, and it stands at the same 2000 mm from the start of the wall, now on the line x 3000, 1000 south of the middle.
      const doorAfter = await boxOf(client, doorId);
      assert.ok(Math.abs(doorAfter.min.x - doorBefore.min.x) > 100 && Math.abs(doorAfter.min.y - doorBefore.min.y) > 100, "the door went with the wall");
      assertNear((doorAfter.min.y + doorAfter.max.y) / 2, y - 1000, "the middle of the door along the turned wall", BOX_NEAR_MM);
      assertNear(sizeOf(doorAfter).y, sizeOf(doorBefore).x, "the door is as wide along the wall as it was", BOX_NEAR_MM);

      // And it is still an insert of the wall at that place: an opening on top of it is refused naming the door, which only a door that cuts the wall there can cause.
      const w = ready();
      const refused = await refusal(client, "place_hosted", { items: [{ typeId: w.door.id, wallId, offsetAlongWallMm: 2000 }] });
      assert.match(refused.message, new RegExp(`door ${doorId} that is in wall ${wallId}`));
    });
  });

  it("type change keeps the element", async () => {
    await withClient(async (client) => {
      const w = ready();
      const [first, second] = w.beds;
      assert.ok(first && second);
      const bedId = await bedAt(client, first.id, 1000, scene());
      assert.equal((await rowOf(client, bedId)).typeName, first.name);

      const [changed] = landed(await update(client, [{ id: bedId, typeId: second.id }]), "updated");
      assert.ok(changed);
      assert.equal(changed.elementId, bedId, "the element keeps its id");
      assert.equal(changed.actual.typeId, second.id);
      assert.equal(changed.actual.typeName, second.name);

      const row = await rowOf(client, bedId);
      assert.equal(row.typeName, second.name, "the model says the new type");
      assert.equal(row.category, "furniture");
      assert.equal(row.levelId, w.ground.id);

      // The type is now the one asked for, so asking again has nothing to change, and an Undo step must not be made for it.
      await saved(client);
      const [same] = landed(await update(client, [{ id: bedId, typeId: second.id }]), "unchanged");
      assert.equal(same?.actual.typeId, second.id);
      assert.equal(await isModified(client), false, "no change, no Undo step");
    });
  });

  it("a wall changes type and keeps its id and its door", async () => {
    await withClient(async (client) => {
      const w = ready();
      const other = (await listTypes(client, "walls")).find((row) => row.family === "Basic Wall" && row.id !== w.wallType.id && row.name.startsWith("Внутренние"));
      assert.ok(other, "a second basic wall type to change to");
      const { id: wallId } = await wallAlongX(client);
      const doorId = await doorIn(client, wallId, 2000);
      const doorBefore = await boxOf(client, doorId);

      const [changed] = landed(await update(client, [{ id: wallId, typeId: other.id }]), "updated");
      assert.equal(changed?.elementId, wallId);
      assert.equal(changed?.actual.typeId, other.id);
      assert.equal((await rowOf(client, wallId)).typeName, other.name);

      // The door is still in the wall, at the same place along it.
      assertNear((await boxOf(client, doorId)).min.x, doorBefore.min.x, "the door has not moved along the wall", BOX_NEAR_MM);
      const refused = await refusal(client, "place_hosted", { items: [{ typeId: w.door.id, wallId, offsetAlongWallMm: 2000 }] });
      assert.match(refused.message, new RegExp(`door ${doorId} that is in wall ${wallId}`));
    });
  });

  it("a basic wall becomes a curtain wall in place, with its id", async () => {
    await withClient(async (client) => {
      const { id: wallId } = await wallAlongX(client);
      const curtain = (await listTypes(client, "walls")).find((row) => row.family === "Curtain Wall");
      assert.ok(curtain, "a curtain wall type in the template");

      // Revit's own words say a new element comes only in rare cases, and a wall given a curtain wall type is not one of them: it keeps its id.
      const [changed] = landed(await update(client, [{ id: wallId, typeId: curtain.id }]), "updated");
      assert.equal(changed?.elementId, wallId);
      assert.equal((await rowOf(client, wallId)).typeName, curtain.name);
    });
  });

  it("the type of a railing changes in place", async () => {
    await withClient(async (client) => {
      const w = ready();
      const [first, second] = w.railings;
      assert.ok(first && second);
      const y = scene();
      const made = (await client.call("create_railings", { items: [{ pathMm: [{ x: 0, y }, { x: 2000, y }], typeId: first.id, levelId: w.upper.id }] })) as Batch<{ railings: Array<{ id: string }> }>;
      assert.equal(made.committed, true, JSON.stringify(made).slice(0, 1200));
      const railingId = made.items[0]?.actual?.railings[0]?.id;
      assert.ok(railingId);
      assert.equal((await rowOf(client, railingId)).typeName, first.name);

      const [changed] = landed(await update(client, [{ id: railingId, typeId: second.id }]), "updated");
      assert.equal(changed?.elementId, railingId, "create_railings points here for a changed type, and the railing keeps its id");
      assert.equal((await rowOf(client, railingId)).typeName, second.name);

      // A railing along a path has no point or line of its own to move, and is told so.
      await refusedAndUnchanged(client, [{ id: railingId, moveMm: { x: 0, y: 700, z: 0 } }], /\(railings\) has no point or line location/, "moving a railing");
    });
  });

  it("parameters are written in the units of the contract", async () => {
    await withClient(async (client) => {
      const w = ready();
      const { id: wallId } = await wallAlongX(client);
      const before = await boxOf(client, wallId);

      // A length goes in millimetres, text keeps its Cyrillic, and a whole number is taken as one.
      const [wall] = landed(
        await update(client, [
          {
            id: wallId,
            parameters: [
              { builtIn: "WALL_USER_HEIGHT_PARAM", value: 3500.25 },
              { builtIn: "WALL_BASE_OFFSET", value: 250.5 },
              { builtIn: "ALL_MODEL_MARK", value: "Несущая стена А1" },
              { builtIn: "WALL_KEY_REF_PARAM", value: 2 },
              { builtIn: "WALL_ATTR_ROOM_BOUNDING", value: false },
            ],
          },
        ]),
        "updated",
      );
      assert.ok(wall);
      const byName = new Map(wall.actual.parameters.map((row) => [row.builtIn, row.value]));
      assertNear(byName.get("WALL_USER_HEIGHT_PARAM"), 3500.25, "height as the model holds it");
      assertNear(byName.get("WALL_BASE_OFFSET"), 250.5, "base offset as the model holds it");
      assert.equal(byName.get("ALL_MODEL_MARK"), "Несущая стена А1");
      assert.equal(byName.get("WALL_KEY_REF_PARAM"), 2);
      assert.strictEqual(byName.get("WALL_ATTR_ROOM_BOUNDING"), false, "a yes/no comes back as true or false");

      // The wall, read another way: it is taller and stands higher by the offset.
      const row = await rowOf(client, wallId);
      assertNear(row.topMm, 250.5 + 3500.25, "the top of the wall");
      const after = await boxOf(client, wallId);
      assertNear(after.min.z, before.min.z + 250.5, "the foot of the wall");

      // Asking for the same values again finds nothing to change.
      await saved(client);
      landed(
        await update(client, [
          {
            id: wallId,
            parameters: [
              { builtIn: "WALL_USER_HEIGHT_PARAM", value: 3500.25 },
              { builtIn: "ALL_MODEL_MARK", value: "Несущая стена А1" },
              { builtIn: "WALL_ATTR_ROOM_BOUNDING", value: false },
            ],
          },
        ]),
        "unchanged",
      );
      assert.equal(await isModified(client), false);

      // An element as a value is an id: the base level of the wall moves it up by the height of the storey.
      const [rebased] = landed(await update(client, [{ id: wallId, parameters: [{ builtIn: "WALL_BASE_CONSTRAINT", value: w.upper.id }] }]), "updated");
      assert.equal(rebased?.actual.parameters[0]?.value, w.upper.id);
      assertNear((await boxOf(client, wallId)).min.z, STOREY_MM + 250.5, "the foot of the wall on the upper level");
    });
  });

  it("moved wall carries its door", async () => {
    await withClient(async (client) => {
      const w = ready();
      const { id: wallId } = await wallAlongX(client);
      const doorId = await doorIn(client, wallId, 2000);
      const wallBefore = await boxOf(client, wallId);
      const doorBefore = await boxOf(client, doorId);
      const by = { x: 1500, y: 2500, z: 0 };

      landed(await update(client, [{ id: wallId, moveMm: by }]), "updated");

      assertShifted(wallBefore, await boxOf(client, wallId), by, "wall");
      assertShifted(doorBefore, await boxOf(client, doorId), by, "door");

      // The door still stands in the wall and cuts it: the wall lists it, so an opening on top of it is refused naming the door.
      const refused = await refusal(client, "place_hosted", { items: [{ typeId: w.door.id, wallId, offsetAlongWallMm: 2000 }] });
      assert.match(refused.message, new RegExp(`door ${doorId} that is in wall ${wallId}`));
    });
  });

  it("a door moves along its wall and up, and stays in it", async () => {
    await withClient(async (client) => {
      const w = ready();
      const { id: wallId } = await wallAlongX(client);
      const doorId = await doorIn(client, wallId, 2000);
      const before = await boxOf(client, doorId);
      const by = { x: 700, y: 0, z: 100 };

      const [door] = landed(await update(client, [{ id: doorId, moveMm: by }]), "updated");
      assert.ok(door);
      assertShifted(before, await boxOf(client, doorId), by, "door");
      assertNear(door.actual.pointMm?.x, 2700, "the door stands 700 further on");

      // Still cutting the wall, now at 2700 and 100 up: an opening on top of it is refused.
      const refused = await refusal(client, "place_hosted", { items: [{ typeId: w.door.id, wallId, offsetAlongWallMm: 2700, sillHeightMm: 100 }] });
      assert.match(refused.message, new RegExp(`door ${doorId} that is in wall ${wallId}`));
    });
  });

  it("a door is not moved across its wall, and one moved past the end of the wall is rolled back", async () => {
    await withClient(async (client) => {
      const { id: wallId } = await wallAlongX(client);
      const doorId = await doorIn(client, wallId, 2000);
      const before = await boxOf(client, doorId);

      await refusedAndUnchanged(client, [{ id: doorId, moveMm: { x: 0, y: 300, z: 0 } }], /stands in wall \d+ on its axis.*across the wall/s, "a door moved across its wall");

      // Revit judges the end of the wall only at the commit, and says so in errors: the item is rolled back, and the door has not moved.
      const batch = (await client.call("update_elements", { items: [{ id: doorId, moveMm: { x: 5000, y: 0, z: 0 } }] })) as Batch<UpdateActual>;
      assert.equal(batch.committed, false, JSON.stringify(batch).slice(0, 800));
      assert.equal(batch.items[0]?.status, "rolled_back");
      assert.ok(batch.errors.length > 0, "Revit says why in errors");
      assert.deepEqual(await boxOf(client, doorId), before);
    });
  });

  it("a pinned element is refused a move and a turn, and moves once unpinned", async () => {
    await withClient(async (client) => {
      const w = ready();
      const { id: wallId } = await wallAlongX(client);
      const bedId = await bedAt(client, w.beds[0]!.id, 1000, scene());
      const wallBefore = await boxOf(client, wallId);

      // Writing true to ELEMENT_LOCKED_PARAM pins an element, as the tool text says.
      landed(await update(client, [{ id: wallId, parameters: [{ builtIn: "ELEMENT_LOCKED_PARAM", value: true }] }, { id: bedId, parameters: [{ builtIn: "ELEMENT_LOCKED_PARAM", value: true }] }]), "updated", "updated");

      await refusedAndUnchanged(client, [{ id: wallId, moveMm: { x: 10, y: 0, z: 0 } }], /is pinned.*ask the user.*ELEMENT_LOCKED_PARAM/s, "moving a pinned wall");
      await refusedAndUnchanged(client, [{ id: bedId, rotateDeg: 10 }], /is pinned/, "turning a pinned bed");
      assert.deepEqual(await boxOf(client, wallId), wallBefore);

      // A pin stops a move and a turn, and nothing else: a parameter is written all the same, and so is the pin itself.
      landed(await update(client, [{ id: wallId, parameters: [{ builtIn: "ALL_MODEL_MARK", value: "На замке" }] }]), "updated");
      landed(await update(client, [{ id: wallId, parameters: [{ builtIn: "ELEMENT_LOCKED_PARAM", value: false }] }]), "updated");
      const by = { x: 10, y: 0, z: 0 };
      landed(await update(client, [{ id: wallId, moveMm: by }]), "updated");
      assertShifted(wallBefore, await boxOf(client, wallId), by, "wall after the pin is off");
    });
  });

  /** Four walls round a room of 6000 x 4000, joined at the corners by Revit, and the corners. */
  async function joinedRoom(client: BridgeClient): Promise<{ ids: string[]; corners: Array<{ x: number; y: number }> }> {
    const w = ready();
    const y = scene();
    const corners = [{ x: 0, y }, { x: 6000, y }, { x: 6000, y: y + 4000 }, { x: 0, y: y + 4000 }];
    const made = (await client.call("create_walls", {
      items: corners.map((from, index) => ({ startMm: from, endMm: corners[(index + 1) % 4], typeId: w.wallType.id, levelId: w.ground.id, heightMm: WALL_HEIGHT_MM })),
    })) as Batch<unknown>;
    assert.equal(made.committed, true, JSON.stringify(made).slice(0, 800));
    const ids = made.items.map((item) => item.elementId!);
    assert.equal(ids.length, 4);

    return { ids, corners };
  }

  it("a joined wall moves across itself and its neighbours follow", async () => {
    await withClient(async (client) => {
      const { ids, corners } = await joinedRoom(client);
      const [south, east, , west] = ids;
      assert.ok(south && east && west);
      const eastBefore = await boxOf(client, east);
      const westBefore = await boxOf(client, west);

      // The south wall runs along x, so a move along y is across it. Revit keeps its ends on the walls it is joined to, and they stretch.
      const [wall] = landed(await update(client, [{ id: south, moveMm: { x: 0, y: 500.5, z: 0 } }]), "updated");
      assertNear(wall?.actual.startMm?.y, corners[0]!.y + 500.5, "start y of the moved wall");
      assertNear(wall?.actual.endMm?.y, corners[0]!.y + 500.5, "end y of the moved wall");
      assertNear(wall?.actual.startMm?.x, corners[0]!.x, "start x of the moved wall");

      assertNear((await boxOf(client, east)).min.y, eastBefore.min.y + 500.5, "the east wall now starts where the south wall is", 1);
      assertNear((await boxOf(client, west)).min.y, westBefore.min.y + 500.5, "the west wall now starts where the south wall is", 1);
    });
  });

  it("a joined wall moved along itself is not moved, and the failure says why", async () => {
    await withClient(async (client) => {
      const { ids } = await joinedRoom(client);
      const [south] = ids;
      assert.ok(south);
      const before = await Promise.all(ids.map((id) => boxOf(client, id)));
      await saved(client);

      // Revit keeps a joined end on its neighbour, so the part of the move that runs along the wall is not applied: the item fails and the call is rolled back.
      const batch = (await client.call("update_elements", { items: [{ id: south, moveMm: { x: 1000, y: 0, z: 0 } }] })) as Batch<UpdateActual>;

      assert.equal(batch.committed, false, JSON.stringify(batch).slice(0, 1000));
      assert.equal(batch.items[0]?.status, "failed");
      assert.match(batch.items[0]?.error ?? "", /joined to other walls at its ends.*along the wall is not applied/s);
      assert.deepEqual(await Promise.all(ids.map((id) => boxOf(client, id))), before, "no wall of the room moved");
    });
  });

  it("a wall and the door in it can be moved in one call, and the door goes both ways", async () => {
    await withClient(async (client) => {
      const { id: wallId } = await wallAlongX(client);
      const doorId = await doorIn(client, wallId, 2000);
      const doorBefore = await boxOf(client, doorId);

      // The wall first: the door goes with it. Then the door, along the wall: the move of the door is judged from where the wall left it.
      landed(await update(client, [{ id: wallId, moveMm: { x: 1000, y: 2000, z: 0 } }, { id: doorId, moveMm: { x: 500, y: 0, z: 0 } }]), "updated", "updated");

      assertShifted(doorBefore, await boxOf(client, doorId), { x: 1500, y: 2000, z: 0 }, "door");
    });
  });

  it("a level parameter takes a level, and the model says the element is on it", async () => {
    await withClient(async (client) => {
      const w = ready();
      const { id: wallId } = await wallAlongX(client);
      const bedId = await bedAt(client, w.beds[0]!.id, 1000, scene());
      const floorId = await floorAt(client, scene());

      // The top constraint of a wall is a level: the wall now ends at the level, 4000 up.
      const [wall] = landed(await update(client, [{ id: wallId, parameters: [{ builtIn: "WALL_HEIGHT_TYPE", value: w.upper.id }] }]), "updated");
      assert.equal(wall?.actual.parameters[0]?.value, w.upper.id);
      assertNear((await rowOf(client, wallId)).topMm, STOREY_MM, "the top of the wall at the upper level");
      landed(await update(client, [{ id: wallId, parameters: [{ builtIn: "WALL_HEIGHT_TYPE", value: w.upper.id }] }]), "unchanged");

      // The level of an instance and of a floor, read another way: get_elements says which level they are on.
      landed(await update(client, [{ id: bedId, parameters: [{ builtIn: "FAMILY_LEVEL_PARAM", value: w.upper.id }] }, { id: floorId, parameters: [{ builtIn: "LEVEL_PARAM", value: w.upper.id }] }]), "updated", "updated");
      assert.equal((await rowOf(client, bedId)).levelId, w.upper.id);
      assert.equal((await rowOf(client, floorId)).levelId, w.upper.id);
    });
  });

  it("an element id of the wrong kind, a type, a phase and any other element parameter are refused before any change", async () => {
    await withClient(async (client) => {
      const w = ready();
      const { id: wallId } = await wallAlongX(client);
      const { id: otherId } = await wallAlongX(client);
      const doorId = await doorIn(client, otherId, 2000);
      const bedId = await bedAt(client, w.beds[0]!.id, 1000, scene());
      const floorId = await floorAt(client, scene());
      const level = /must be the id of a level/;
      const typeParameter = /use typeId/;
      const phase = /phase/;
      const other = /holds an element, and this tool writes only/;

      // Revit takes any element for these parameters without a word: a wall was stored as the top constraint of a wall, and as its phase.
      const cases: Array<[string, string, string, string, RegExp]> = [
        ["a wall as the base level", wallId, "WALL_BASE_CONSTRAINT", otherId, level],
        ["a door as the base level", wallId, "WALL_BASE_CONSTRAINT", doorId, level],
        ["a wall type as the top constraint", wallId, "WALL_HEIGHT_TYPE", w.wallType.id, level],
        ["a wall as the level of a bed", bedId, "FAMILY_LEVEL_PARAM", wallId, level],
        ["a wall type as the level of a floor", floorId, "LEVEL_PARAM", w.wallType.id, level],
        ["none as the top constraint", wallId, "WALL_HEIGHT_TYPE", "-1", /WALL_HEIGHT_TYPE.*no element has the id -1.*cannot be cleared/s],
        ["the type of a wall", wallId, "ELEM_TYPE_PARAM", w.wallType.id, typeParameter],
        ["the family and type of a bed", bedId, "ELEM_FAMILY_AND_TYPE_PARAM", w.beds[0]!.id, typeParameter],
        ["the family of a door", doorId, "ELEM_FAMILY_PARAM", w.door.id, typeParameter],
        ["the type id of a wall", wallId, "SYMBOL_ID_PARAM", w.wallType.id, typeParameter],
        ["the phase created of a wall", wallId, "PHASE_CREATED", otherId, phase],
        ["the phase demolished of a bed", bedId, "PHASE_DEMOLISHED", otherId, phase],
        ["the image of a wall", wallId, "ALL_MODEL_IMAGE", otherId, other],
        ["the clear cover of a wall", wallId, "CLEAR_COVER_EXTERIOR", otherId, other],
        ["the routing preference of a bed", bedId, "ROUTING_PREFERENCE_PARAM", otherId, other],
      ];

      for (const [what, id, builtIn, value, pattern] of cases) {
        await refusedAndUnchanged(client, [{ id, parameters: [{ builtIn, value }] }], pattern, what);
      }
    });
  });

  it("a later parameter that undoes an earlier one of the same item rolls the call back", async () => {
    await withClient(async (client) => {
      const w = ready();
      const { id: wallId } = await wallAlongX(client);
      const before = await rowOf(client, wallId);

      // Setting the top constraint sets the unconnected height too, so the 3500 does not survive the second parameter. That used to be seen only after the commit.
      const batch = await update(client, [
        { id: wallId, parameters: [{ builtIn: "WALL_USER_HEIGHT_PARAM", value: 3500 }, { builtIn: "WALL_HEIGHT_TYPE", value: w.upper.id }] },
      ]);

      assert.equal(batch.committed, false, JSON.stringify(batch).slice(0, 1200));
      assert.equal(batch.items[0]?.status, "failed");
      assert.match(batch.items[0]?.error ?? "", /WALL_USER_HEIGHT_PARAM.*3500.*a later change of this item/s);
      assert.equal(batch.items[0]?.elementId, null);
      assert.equal((await rowOf(client, wallId)).topMm, before.topMm, "the wall is as it was");
    });
  });

  it("a yes/no takes true, false, 0 and 1, and nothing else", async () => {
    await withClient(async (client) => {
      const { id: wallId } = await wallAlongX(client);
      const roomBounding = (value: unknown): UpdateItem => ({ id: wallId, parameters: [{ builtIn: "WALL_ATTR_ROOM_BOUNDING", value }] });

      const [off] = landed(await update(client, [roomBounding(0)]), "updated");
      assert.strictEqual(off?.actual.parameters[0]?.value, false);
      const [on] = landed(await update(client, [roomBounding(1)]), "updated");
      assert.strictEqual(on?.actual.parameters[0]?.value, true);
      landed(await update(client, [roomBounding(true)]), "unchanged");

      await refusedAndUnchanged(client, [roomBounding(2)], /yes.no.*true, false, 0 or 1/s, "2 for a yes/no");
      await refusedAndUnchanged(client, [roomBounding(-1)], /yes.no.*true, false, 0 or 1/s, "-1 for a yes/no");
    });
  });

  it("a move by nothing and a turn by nothing change nothing, whatever the element", async () => {
    await withClient(async (client) => {
      const { id: wallId } = await wallAlongX(client);
      const doorId = await doorIn(client, wallId, 2000);
      const floorId = await floorAt(client, scene());
      await saved(client);

      // A door is never turned and a floor is never moved, but nothing is asked of them here, so nothing is refused.
      landed(await update(client, [{ id: doorId, rotateDeg: 360 }, { id: floorId, moveMm: { x: 0, y: 0, z: 0 } }]), "unchanged", "unchanged");
      landed(await update(client, [{ id: doorId, rotateDeg: 0, moveMm: { x: 0, y: 0, z: 0 } }]), "unchanged");
      assert.equal(await isModified(client), false);
    });
  });

  it("a joined wall is not turned, and the failure says why", async () => {
    await withClient(async (client) => {
      const { ids } = await joinedRoom(client);
      const [south] = ids;
      assert.ok(south);
      const before = await Promise.all(ids.map((id) => boxOf(client, id)));
      await saved(client);

      // Revit keeps the ends of the wall on its neighbours, so a small turn lands the wall off the line asked for: the item fails and the call is rolled back.
      const small = (await client.call("update_elements", { items: [{ id: south, rotateDeg: 10 }] })) as Batch<UpdateActual>;
      assert.equal(small.committed, false, JSON.stringify(small).slice(0, 1000));
      assert.equal(small.items[0]?.status, "failed");
      assert.match(small.items[0]?.error ?? "", /joined to other walls at its ends/);

      // A quarter turn Revit refuses at the commit, and says so in errors.
      const quarter = (await client.call("update_elements", { items: [{ id: south, rotateDeg: 90 }] })) as Batch<UpdateActual>;
      assert.equal(quarter.committed, false, JSON.stringify(quarter).slice(0, 1000));
      assert.equal(quarter.items[0]?.status, "rolled_back");
      assert.ok(quarter.errors.length > 0, "Revit says why in errors");

      assert.deepEqual(await Promise.all(ids.map((id) => boxOf(client, id))), before, "no wall of the room moved");
    });
  });

  it("a wall with a door in it is not given a curtain wall type, which would delete the door", async () => {
    await withClient(async (client) => {
      const { id: wallId } = await wallAlongX(client);
      const doorId = await doorIn(client, wallId, 2000);
      const curtain = (await listTypes(client, "walls")).find((row) => row.family === "Curtain Wall");
      assert.ok(curtain);
      const typeName = (await rowOf(client, wallId)).typeName;

      // Revit gives the type, deletes every insert of the wall, and only warns of it.
      await refusedAndUnchanged(client, [{ id: wallId, typeId: curtain.id }], /curtain wall type.*delete_elements/s, "a curtain wall type for a wall with a door");
      assert.equal((await rowOf(client, wallId)).typeName, typeName, "the wall keeps its type");
      assert.equal((await rowOf(client, doorId)).category, "doors", "the door is still there");
    });
  });

  it("read-only parameter is refused before any change", async () => {
    await withClient(async (client) => {
      const { id: wallId } = await wallAlongX(client);
      const { id: otherId } = await wallAlongX(client);
      const first = await boxOf(client, wallId);
      const second = await boxOf(client, otherId);

      // The first item is fine and the second is not: the whole call is refused and the first changes nothing either.
      const refused = await refusedAndUnchanged(
        client,
        [
          { id: wallId, moveMm: { x: 100, y: 0, z: 0 } },
          { id: otherId, parameters: [{ builtIn: "CURVE_ELEM_LENGTH", value: 3000 }] },
        ],
        /update_elements item 1.*CURVE_ELEM_LENGTH.*read-only/s,
        "length of a wall",
      );
      assert.equal(refused.code, INVALID_PARAMS);
      assert.deepEqual(await boxOf(client, wallId), first, "the first item changed nothing");
      assert.deepEqual(await boxOf(client, otherId), second);
    });
  });

  it("unknown BuiltInParameter is refused", async () => {
    await withClient(async (client) => {
      const { id: wallId } = await wallAlongX(client);
      const refuseValue = (builtIn: string, pattern: RegExp, what: string) =>
        refusedAndUnchanged(client, [{ id: wallId, parameters: [{ builtIn, value: 1 }] }], pattern, what);

      await refuseValue("NOT_A_PARAMETER", /NOT_A_PARAMETER.*not the name of a BuiltInParameter/s, "no such name");
      await refuseValue("wall_user_height_param", /wall_user_height_param.*not the name of a BuiltInParameter/s, "the name is case-sensitive");
      await refuseValue("INVALID", /INVALID.*not the name of a BuiltInParameter/s, "the placeholder of the enum is no parameter");
      // A number is a value of the enum and not a name of it, and Enum.TryParse would take it.
      await refuseValue("1", /'1'.*not the name of a BuiltInParameter/s, "a number is not a name");
      await refuseValue("", /not the name of a BuiltInParameter/, "an empty name");
      // A real parameter that a wall does not have.
      await refuseValue("ROOM_NUMBER", /ROOM_NUMBER.*has no such parameter/s, "a parameter of rooms, on a wall");
    });
  });

  it("refuses what is knowable before the transaction, naming the item", async () => {
    await withClient(async (client) => {
      const w = ready();
      const { id: wallId } = await wallAlongX(client);
      const doorId = await doorIn(client, wallId, 2000);
      const bedId = await bedAt(client, w.beds[0]!.id, 1000, scene());
      const move = { x: 100, y: 0, z: 0 };

      const cases: Array<[string, unknown[], RegExp]> = [
        ["nothing to change", [{ id: wallId }], /at least one of moveMm, rotateDeg, typeId and parameters/],
        ["an empty list of parameters is nothing", [{ id: wallId, parameters: [] }], /at least one of moveMm, rotateDeg, typeId and parameters/],
        ["an unknown key", [{ id: wallId, moveMM: move }], /moveMM/],
        ["the item is not an object", [wallId], /an item is an object/],
        ["no id", [{ moveMm: move }], /id must be an element id, as text/],
        ["an id that is a number", [{ id: Number(wallId), moveMm: move }], /id must be an element id, as text/],
        ["an id that is no element", [{ id: "2000000000", moveMm: move }], /no element has the id 2000000000/],
        ["a type is not an element of the model", [{ id: w.wallType.id, moveMm: move }], /is a type/],
        ["the same element twice", [{ id: wallId, moveMm: move }, { id: wallId, rotateDeg: 10 }], /which item 0 changes too/],
        ["a move with no z", [{ id: wallId, moveMm: { x: 1, y: 2 } }], /moveMm.*x, y and z/],
        ["a move that is not numbers", [{ id: wallId, moveMm: { x: "1", y: 2, z: 3 } }], /moveMm\.x must be a number/],
        ["a move that is not an object", [{ id: wallId, moveMm: 5 }], /moveMm.*x, y and z/],
        ["a turn that is text", [{ id: wallId, rotateDeg: "90" }], /rotateDeg must be a number/],
        ["a hosted door does not turn", [{ id: doorId, rotateDeg: 90 }], /hosted by wall \d+.*takes its direction from that host/s],
        ["a type that is not an id", [{ id: bedId, typeId: 5 }], /typeId must be an element id, as text/],
        ["a type that is no type", [{ id: bedId, typeId: wallId }], /typeId.*is not a type/s],
        ["a type that does not fit the element", [{ id: bedId, typeId: w.wallType.id }], /cannot be given.*types that can be/s],
        ["parameters that are not a list", [{ id: wallId, parameters: { builtIn: "ALL_MODEL_MARK", value: "x" } }], /parameters must be a list/],
        ["a parameter that is not an object", [{ id: wallId, parameters: ["ALL_MODEL_MARK"] }], /parameters\[0\] is an object/],
        ["a parameter with no name", [{ id: wallId, parameters: [{ value: 1 }] }], /builtIn must be text/],
        ["a parameter with no value", [{ id: wallId, parameters: [{ builtIn: "ALL_MODEL_MARK" }] }], /ALL_MODEL_MARK needs a value/],
        ["an unknown key in a parameter", [{ id: wallId, parameters: [{ builtIn: "ALL_MODEL_MARK", value: "x", unit: "mm" }] }], /unit/],
        ["a parameter twice", [{ id: wallId, parameters: [{ builtIn: "ALL_MODEL_MARK", value: "x" }, { builtIn: "ALL_MODEL_MARK", value: "y" }] }], /ALL_MODEL_MARK twice/],
        ["a length that is text", [{ id: wallId, parameters: [{ builtIn: "WALL_USER_HEIGHT_PARAM", value: "3000" }] }], /WALL_USER_HEIGHT_PARAM.*a length.*number of millimetres/s],
        ["a length that is yes", [{ id: wallId, parameters: [{ builtIn: "WALL_USER_HEIGHT_PARAM", value: true }] }], /WALL_USER_HEIGHT_PARAM.*a length.*number of millimetres/s],
        ["a text that is a number", [{ id: wallId, parameters: [{ builtIn: "ALL_MODEL_MARK", value: 5 }] }], /ALL_MODEL_MARK.*holds text/s],
        ["a whole number that has a fraction", [{ id: wallId, parameters: [{ builtIn: "WALL_KEY_REF_PARAM", value: 1.5 }] }], /WALL_KEY_REF_PARAM.*whole number/s],
        ["an id that is a number", [{ id: wallId, parameters: [{ builtIn: "WALL_BASE_CONSTRAINT", value: 311 }] }], /WALL_BASE_CONSTRAINT.*an element id, as text/s],
        ["an id that is no element", [{ id: wallId, parameters: [{ builtIn: "WALL_BASE_CONSTRAINT", value: "2000000000" }] }], /WALL_BASE_CONSTRAINT.*no element has the id 2000000000/s],
        ["a parameter of the type is not the wall's own", [{ id: wallId, parameters: [{ builtIn: "WALL_ATTR_WIDTH_PARAM", value: 200 }] }], /WALL_ATTR_WIDTH_PARAM.*has no such parameter.*of the type of an element is not its own/s],
      ];

      for (const [what, items, pattern] of cases) {
        await refusedAndUnchanged(client, items, pattern, what);
      }

      assert.match((await refusal(client, "update_elements", {})).message, /needs a list of items/);
      assert.match((await refusal(client, "update_elements", { items: [] })).message, /needs a list of items/);
      assert.match((await refusal(client, "update_elements", { items: Array.from({ length: 501 }, () => ({ id: wallId, moveMm: move })) })).message, /at most 500 items/);
    });
  });

  it("an element with no point or line location is not moved, and an angle is not written as millimetres", async () => {
    await withClient(async (client) => {
      const w = ready();
      const y = scene();
      const floor = (await client.call("create_floors", {
        items: [{ boundaryMm: [{ x: 0, y }, { x: 3000, y }, { x: 3000, y: y + 3000 }, { x: 0, y: y + 3000 }], typeId: w.floorType.id, levelId: w.ground.id }],
      })) as Batch<unknown>;
      const floorId = floor.items[0]?.elementId;
      assert.ok(floorId, JSON.stringify(floor).slice(0, 800));

      await refusedAndUnchanged(client, [{ id: floorId, moveMm: { x: 100, y: 0, z: 0 } }], /no point or line location/, "moving a floor");
      await refusedAndUnchanged(client, [{ id: floorId, rotateDeg: 10 }], /no point or line location/, "turning a floor");

      // The span direction of a floor is an angle and the join strength order of a wall a plain number: neither has millimetres for a unit, so neither is written as if it had.
      await refusedAndUnchanged(client, [{ id: floorId, parameters: [{ builtIn: "FLOOR_PARAM_SPAN_DIRECTION", value: 90 }] }], /FLOOR_PARAM_SPAN_DIRECTION.*not a length.*angle/s, "an angle");
      const { id: wallId } = await wallAlongX(client);
      await refusedAndUnchanged(client, [{ id: wallId, parameters: [{ builtIn: "JOIN_STRENGTH_ORDER", value: 1 }] }], /JOIN_STRENGTH_ORDER.*not a length.*number/s, "a plain number");
    });
  });

  it("a failure Revit finds only inside the transaction rolls the whole call back", async () => {
    await withClient(async (client) => {
      const { id: firstId } = await wallAlongX(client);
      const { id: secondId } = await wallAlongX(client);
      const before = await boxOf(client, firstId);
      await saved(client);

      // A negative height passes every check made beforehand: it is a number of millimetres. Revit refuses it only once it is asked to write it.
      const batch = (await client.call("update_elements", {
        items: [
          { id: firstId, moveMm: { x: 100, y: 0, z: 0 } },
          { id: secondId, parameters: [{ builtIn: "WALL_USER_HEIGHT_PARAM", value: -1000 }] },
        ],
      })) as Batch<UpdateActual>;

      assert.equal(batch.committed, false, JSON.stringify(batch).slice(0, 1500));
      assert.deepEqual(
        batch.items.map((item) => item.status),
        ["rolled_back", "failed"],
      );
      assert.ok(batch.items[1]?.error, "the failed item says why");
      assert.equal(batch.items[0]?.actual, null, "an item that did not land reports no actual");
      assert.deepEqual(await boxOf(client, firstId), before, "the first wall did not move");
    });
  });

  it("one call is one Undo step", async (t) => {
    await withClient(async (client) => {
      const { id: firstId } = await wallAlongX(client);
      const { id: secondId } = await wallAlongX(client);
      const firstBefore = await boxOf(client, firstId);
      const secondBefore = await boxOf(client, secondId);

      landed(
        await update(client, [
          { id: firstId, moveMm: { x: 500, y: 500, z: 0 } },
          { id: secondId, moveMm: { x: -300, y: 0, z: 0 }, parameters: [{ builtIn: "ALL_MODEL_MARK", value: "Вернуть" }] },
        ]),
        "updated",
        "updated",
      );
      assert.notDeepEqual(await boxOf(client, firstId), firstBefore);

      const undone = await undoWithOneRetry(t, client);

      assert.equal(undone.transactionName, "MCP: update_elements");
      assert.deepEqual(undone.createdIds, [], "nothing was created, so nothing is named as created");
      assert.deepEqual(await boxOf(client, firstId), firstBefore, "the first wall is back");
      assert.deepEqual(await boxOf(client, secondId), secondBefore, "the second wall is back");
      // The mark went with the step: writing it again is a change and not nothing.
      landed(await update(client, [{ id: secondId, parameters: [{ builtIn: "ALL_MODEL_MARK", value: "Вернуть" }] }]), "updated");
    });
  });

  it("leaves Revit in a state the close rule accepts", async () => {
    await withClient(async (client) => {
      await client.call("save_project", {});

      assert.deepEqual(checkCanClose((await modelInfo(client)).openDocuments), { ok: true, reasons: [] });
    });
  });
});
