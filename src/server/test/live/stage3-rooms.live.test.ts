import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { checkCanClose } from "../../src/cli/closeRule.ts";
import { BridgeClient } from "../../src/client.ts";
import { defaultConnectionPath } from "../../src/connection.ts";
import { BridgeRpcError } from "../../src/errors.ts";
import { undoWithOneRetry } from "../undoRetry.ts";

// These tests need a running Revit with the RevitMCP plugin loaded. Each run creates one new project in the test folder and
// leaves it open and saved. They build boxes of walls, put rooms in them, and divide them with room separators. The boxes stand
// far apart, each in a scene of its own, so that no room of one reaches another. Areas are compared with the thickness of the
// walls Revit reports, so the numbers are those of the model and not of a guess.

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
  views: Array<{ id: string; name: string; viewType: string }>;
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

interface WallActual {
  widthMm: number;
}

interface RoomActual {
  name: string | null;
  number: string | null;
  areaM2: number;
  perimeterMm: number;
}

interface SeparatorActual {
  levelId: string;
  startMm: PlanPoint;
  endMm: PlanPoint;
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
  levelId: string | null;
  boundingBoxMm: Box | null;
  name?: string | null;
  number?: string | null;
  areaM2?: number;
}

interface ElementsAnswer {
  elements: ElementRow[];
  notFound: string[];
  truncated: boolean;
}

const INVALID_PARAMS = -32602;
/** What Revit rounds a point to when it keeps it: far above the noise of units, far below any real miss. */
const POINT_MM = 0.1;
/** Areas come back in square metres with the noise of feet: far above it, far below any real difference. */
const AREA_M2 = 0.001;
const PERIMETER_MM = 1;
const SCENE_PITCH_MM = 20000;
const STOREY_MM = 3000;
const BOX_WIDTH_MM = 10000;
const BOX_DEPTH_MM = 6000;

const stamp = new Date().toTimeString().slice(0, 8).replaceAll(":", "");
const name = `проверка-этап3-помещения-${stamp}`;

/** What the tests share: the levels and a wall type. */
interface World {
  ground: Level;
  upper: Level;
  /** A level with walls of its own but no floor plan. */
  bare: Level;
  wallType: TypeRow;
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

const elementsOf = (client: BridgeClient, params: object): Promise<ElementsAnswer> => client.call("get_elements", params) as Promise<ElementsAnswer>;

const createRooms = (client: BridgeClient, items: object[]): Promise<Batch<RoomActual>> =>
  client.call("create_rooms", { items }) as Promise<Batch<RoomActual>>;

const createSeparators = (client: BridgeClient, items: object[]): Promise<Batch<SeparatorActual>> =>
  client.call("create_room_separators", { items }) as Promise<Batch<SeparatorActual>>;

const listTypes = (client: BridgeClient, category: string): Promise<TypeRow[]> => client.call("list_types", { category }) as Promise<TypeRow[]>;

function ready(): World {
  assert.ok(world, "the first test creates the project");
  return world;
}

/** The x of the next scene, so that no box touches another. */
function scene(): number {
  const x = nextSceneX;
  nextSceneX += SCENE_PITCH_MM;
  return x;
}

function assertNear(actual: unknown, expected: number, what: string, within = POINT_MM): void {
  assert.equal(typeof actual, "number", what);
  assert.ok(Math.abs((actual as number) - expected) < within, `${what}: ${String(actual)}, expected ${expected}`);
}

/** The area inside a box of walls whose axes are width x depth, in square metres: the walls take half their thickness from every side. */
const netAreaM2 = (widthMm: number, depthMm: number, thicknessMm: number): number => ((widthMm - thicknessMm) * (depthMm - thicknessMm)) / 1_000_000;

interface Walls {
  thicknessMm: number;
  ids: string[];
  /** The middle of the box, in the plan. */
  centre: PlanPoint;
}

/** Four walls round a rectangle, as one call. The axes of the walls run along the sides of the rectangle. */
async function box(client: BridgeClient, x: number, level: Level, width = BOX_WIDTH_MM, depth = BOX_DEPTH_MM, y = 0): Promise<Walls> {
  const w = ready();
  const corners = [{ x, y }, { x: x + width, y }, { x: x + width, y: y + depth }, { x, y: y + depth }];
  const items = corners.map((from, index) => ({
    startMm: from,
    endMm: corners[(index + 1) % corners.length],
    typeId: w.wallType.id,
    levelId: level.id,
    heightMm: STOREY_MM,
  }));

  const walls = (await client.call("create_walls", { items })) as Batch<WallActual>;
  assert.equal(walls.committed, true, JSON.stringify(walls).slice(0, 1500));

  const thickness = walls.items[0]?.actual?.widthMm;
  assert.equal(typeof thickness, "number");

  return {
    thicknessMm: thickness as number,
    ids: walls.items.map((item) => item.elementId as string),
    centre: { x: x + width / 2, y: y + depth / 2 },
  };
}

/** A call that landed with nothing to warn about, and its items. */
function landed<A>(batch: Batch<A>, status: string, count = 1): Array<Item<A> & { elementId: string; actual: A }> {
  assert.equal(batch.committed, true, JSON.stringify(batch).slice(0, 1800));
  assert.deepEqual(batch.errors, []);
  assert.deepEqual(batch.dialogs, []);
  assert.deepEqual(batch.warnings, [], "nothing here should give Revit something to warn about");
  assert.equal(batch.items.length, count);

  for (const item of batch.items) {
    assert.ok(item.elementId && item.actual, JSON.stringify(batch).slice(0, 1800));
    assert.equal(item.status, status, JSON.stringify(batch).slice(0, 1800));
  }

  return batch.items as Array<Item<A> & { elementId: string; actual: A }>;
}

const roomsOf = async (client: BridgeClient, extra: object = {}): Promise<ElementRow[]> => {
  const answer = await elementsOf(client, { category: "rooms", ...extra });
  assert.equal(answer.truncated, false);
  assert.deepEqual(answer.notFound, []);

  return answer.elements;
};

async function countOf(client: BridgeClient, category: string): Promise<number> {
  return (await modelInfo(client)).categoryCounts.find((entry) => entry.category === category)?.count ?? 0;
}

const roomCount = (client: BridgeClient): Promise<number> => countOf(client, "OST_Rooms");
const separatorCount = (client: BridgeClient): Promise<number> => countOf(client, "OST_RoomSeparationLines");

/** Calls a tool where it must refuse before anything changes, and returns the refusal. */
async function refusedAndUnchanged(client: BridgeClient, method: string, params: object, pattern: RegExp, what: string): Promise<BridgeRpcError> {
  await client.call("save_project", {});
  const before = [await roomCount(client), await separatorCount(client)];

  const error = await client.call(method, params).then(
    (result) => assert.fail(`${what}: should be refused, and returned ${JSON.stringify(result).slice(0, 500)}`),
    (reason: unknown) => reason,
  );

  assert.ok(error instanceof BridgeRpcError, `${what}: expected a plugin error, got ${String(error)}`);
  assert.equal(error.code, INVALID_PARAMS, error.message);
  assert.match(error.message, pattern, what);
  assert.deepEqual([await roomCount(client), await separatorCount(client)], before, `${what}: a refused call makes no room and no separator`);
  assert.equal((await modelInfo(client)).activeDocument?.isModified, false, `${what}: a refused call changes nothing`);

  return error;
}

/** A box of walls with one room in it, and the room as the model holds it. */
async function furnished(client: BridgeClient, roomName: string, number: string): Promise<{ walls: Walls; x: number; roomId: string; areaM2: number }> {
  const w = ready();
  const x = scene();
  const walls = await box(client, x, w.ground);
  const [room] = landed(await createRooms(client, [{ levelId: w.ground.id, pointMm: walls.centre, name: roomName, number }]), "created");
  assert.ok(room);

  return { walls, x, roomId: room.elementId, areaM2: room.actual.areaM2 };
}

describe("stage 3 live checks: rooms and room separators", { timeout: 180_000 }, () => {
  it("creates a project for this run", async () => {
    await withClient(async (client) => {
      await client.call("create_project", { name });

      const levels = (await client.call("create_levels", {
        items: [
          { name: `Этаж 2 ${stamp}`, elevationMm: STOREY_MM },
          { name: `Без плана ${stamp}`, elevationMm: 2 * STOREY_MM, createPlan: false },
        ],
      })) as Batch<unknown>;
      assert.equal(levels.committed, true, JSON.stringify(levels));

      const info = await modelInfo(client);
      assert.equal(info.activeDocument?.title, name);
      const ground = info.levels.find((level) => level.elevationMm === 0);
      const upper = info.levels.find((level) => level.elevationMm === STOREY_MM);
      const bare = info.levels.find((level) => level.elevationMm === 2 * STOREY_MM);
      assert.ok(ground && upper && bare, JSON.stringify(info.levels));

      const [wallType] = await listTypes(client, "walls");
      assert.ok(wallType);

      world = { ground, upper, bare, wallType };
      console.log(`# world: ${JSON.stringify(world)}`);
    });
  });

  it("closed room has the right area and a Cyrillic name", async () => {
    await withClient(async (client) => {
      const w = ready();
      const walls = await box(client, scene(), w.ground);
      const t = walls.thicknessMm;
      const roomsBefore = await roomCount(client);

      const asked = { levelId: w.ground.id, pointMm: walls.centre, name: "Гостиная", number: "101" };
      const [room] = landed(await createRooms(client, [asked]), "created");
      assert.ok(room);

      console.log(`# room: ${JSON.stringify(room.actual)} for walls ${t} mm thick`);
      assert.deepEqual(room.requested, asked, "the request comes back as it was sent");
      assert.equal(room.actual.name, "Гостиная");
      assert.equal(room.actual.number, "101");
      assertNear(room.actual.areaM2, netAreaM2(BOX_WIDTH_MM, BOX_DEPTH_MM, t), "area of the room", AREA_M2);
      assertNear(room.actual.perimeterMm, 2 * (BOX_WIDTH_MM - t + (BOX_DEPTH_MM - t)), "perimeter of the room", PERIMETER_MM);
      assert.equal((await roomCount(client)) - roomsBefore, 1);

      // The model says the same, and the name is the name, not the name with the number.
      const [read] = await roomsOf(client, { levelId: w.ground.id }).then((rooms) => rooms.filter((row) => row.id === room.elementId));
      assert.ok(read, "get_elements lists the room on its level");
      assert.equal(read.category, "rooms");
      assert.equal(read.name, "Гостиная");
      assert.equal(read.number, "101");
      assert.equal(read.levelId, w.ground.id);
      assert.equal(read.typeName, null, "a room has no type");
      assertNear(read.areaM2, room.actual.areaM2, "area from get_elements", 1e-9);

      const byId = await elementsOf(client, { ids: [room.elementId] });
      assert.deepEqual(byId.notFound, []);
      assert.deepEqual(
        [byId.elements[0]?.name, byId.elements[0]?.number, byId.elements[0]?.category],
        ["Гостиная", "101", "rooms"],
      );
      assert.deepEqual(
        (await roomsOf(client, { levelId: w.upper.id })).map((row) => row.id),
        [],
        "no room stands on the upper level",
      );

      // No number: Revit numbers the room itself, and the answer says which. A name with a space and a hyphen stays as it is.
      const second = await box(client, scene(), w.ground);
      const [numbered] = landed(await createRooms(client, [{ levelId: w.ground.id, pointMm: second.centre, name: "Кухня-столовая у окна" }]), "created");
      assert.ok(numbered);
      assert.equal(numbered.actual.name, "Кухня-столовая у окна");
      assert.ok(numbered.actual.number && numbered.actual.number !== "101", `Revit numbers the room: ${String(numbered.actual.number)}`);
      assertNear(numbered.actual.areaM2, netAreaM2(BOX_WIDTH_MM, BOX_DEPTH_MM, second.thicknessMm), "area of the second room", AREA_M2);

      // A number that another room has is accepted, and Revit's warning comes back with the call. The extra room is then taken away.
      const third = await box(client, scene(), w.ground);
      const twin = await createRooms(client, [{ levelId: w.ground.id, pointMm: third.centre, name: "Двойник", number: "101" }]);
      console.log(`# duplicate number: ${JSON.stringify(twin.warnings)}`);
      assert.equal(twin.committed, true, JSON.stringify(twin).slice(0, 1200));
      assert.equal(twin.items[0]?.status, "created");
      assert.equal(twin.items[0]?.actual?.number, "101");
      assert.ok(twin.warnings.some((warning) => /duplicate "Number" values/.test(warning)), JSON.stringify(twin.warnings));
      const deleted = (await client.call("delete_elements", { ids: [twin.items[0]?.elementId], dryRun: false })) as { committed: boolean };
      assert.equal(deleted.committed, true);
    });
  });

  it("point outside any enclosure fails", async () => {
    await withClient(async (client) => {
      const w = ready();
      const walls = await box(client, scene(), w.ground);
      const outside = { x: walls.centre.x, y: walls.centre.y + BOX_DEPTH_MM };
      await client.call("save_project", {});
      const before = await roomCount(client);

      // Alone: Revit makes the room with an area of 0 and a warning, and the tool turns that into a failed item and a rollback.
      const alone = await createRooms(client, [{ levelId: w.ground.id, pointMm: outside, name: "Снаружи" }]);

      console.log(`# outside: ${JSON.stringify(alone).slice(0, 900)}`);
      assert.equal(alone.committed, false);
      assert.equal(alone.items[0]?.status, "failed");
      assert.equal(alone.items[0]?.elementId, null);
      assert.equal(alone.items[0]?.actual, null);
      assert.match(alone.items[0]?.error ?? "", /has an area of 0/);
      assert.match(alone.items[0]?.error ?? "", new RegExp(`\\(${outside.x}, ${outside.y}\\)`), "names the point");
      assert.match(alone.items[0]?.error ?? "", new RegExp(w.ground.name), "names the level");
      assert.match(alone.errors.join("\n"), /nothing landed/);
      assert.equal(await roomCount(client), before);

      // After a good room, the whole call rolls back: the good room is not in the model either.
      const mixed = await createRooms(client, [
        { levelId: w.ground.id, pointMm: walls.centre, name: "Хорошая" },
        { levelId: w.ground.id, pointMm: outside, name: "Снаружи" },
      ]);

      assert.equal(mixed.committed, false);
      assert.deepEqual(
        mixed.items.map((item) => item.status),
        ["rolled_back", "failed"],
      );
      assert.equal(mixed.items[0]?.elementId, null, "a rolled back item has no element");
      assert.equal(mixed.items[0]?.actual, null);
      assert.equal(await roomCount(client), before, "the good room did not land");
      assert.deepEqual(
        (await roomsOf(client)).filter((row) => row.name === "Хорошая"),
        [],
      );

      // A point on the axis of a wall encloses nothing either, and an item after the failed one is not attempted.
      const onWall = await createRooms(client, [
        { levelId: w.ground.id, pointMm: { x: walls.centre.x, y: 0 }, name: "На стене" },
        { levelId: w.ground.id, pointMm: walls.centre, name: "Хорошая" },
      ]);

      assert.equal(onWall.committed, false);
      assert.deepEqual(
        onWall.items.map((item) => item.status),
        ["failed", "rolled_back"],
      );
      assert.match(onWall.items[1]?.error ?? "", /not attempted/i);
      assert.equal(await roomCount(client), before);
    });
  });

  it("second room in the same enclosure fails", async () => {
    await withClient(async (client) => {
      const w = ready();
      const first = await furnished(client, "Гостиная", "110");
      await client.call("save_project", {});
      const before = await roomCount(client);

      const second = await createRooms(client, [{ levelId: w.ground.id, pointMm: { x: first.x + 1000, y: first.walls.centre.y }, name: "Лишняя" }]);

      console.log(`# second room: ${JSON.stringify(second).slice(0, 900)}`);
      assert.equal(second.committed, false);
      assert.equal(second.items[0]?.status, "failed");
      assert.match(second.items[0]?.error ?? "", /has an area of 0/);
      assert.match(second.items[0]?.error ?? "", /one room to a region/);
      assert.equal(await roomCount(client), before, "no room was added");

      const [kept] = await elementsOf(client, { ids: [first.roomId] }).then((answer) => answer.elements);
      assert.ok(kept);
      assert.equal(kept.name, "Гостиная");
      assertNear(kept.areaM2, first.areaM2, "the first room keeps its area", 1e-9);

      // Two points in one fresh box in one call: the second finds a room made a moment earlier, and the first goes with it.
      const walls = await box(client, scene(), w.ground);
      const both = await createRooms(client, [
        { levelId: w.ground.id, pointMm: { x: walls.centre.x - 2000, y: walls.centre.y }, name: "Первая" },
        { levelId: w.ground.id, pointMm: { x: walls.centre.x + 2000, y: walls.centre.y }, name: "Вторая" },
      ]);

      assert.equal(both.committed, false);
      assert.deepEqual(
        both.items.map((item) => item.status),
        ["rolled_back", "failed"],
      );
      assert.equal(await roomCount(client), before, "neither room landed");
    });
  });

  it("separator splits one room into two", async () => {
    await withClient(async (client) => {
      const w = ready();
      const whole = await furnished(client, "Гостиная", "120");
      const t = whole.walls.thicknessMm;
      assertNear(whole.areaM2, netAreaM2(BOX_WIDTH_MM, BOX_DEPTH_MM, t), "the whole room", AREA_M2);
      const lines = await separatorCount(client);

      // From the axis of the south wall to the axis of the north wall, through the middle of the box.
      const midX = whole.x + BOX_WIDTH_MM / 2;
      const asked = { levelId: w.ground.id, startMm: { x: midX, y: 0 }, endMm: { x: midX, y: BOX_DEPTH_MM } };
      const [line] = landed(await createSeparators(client, [asked]), "created");
      assert.ok(line);

      console.log(`# separator: ${JSON.stringify(line.actual)}`);
      assert.deepEqual(line.requested, asked);
      assert.equal(line.actual.levelId, w.ground.id);
      assertNear(line.actual.startMm.x, midX, "x of the start");
      assertNear(line.actual.startMm.y, 0, "y of the start");
      assertNear(line.actual.endMm.x, midX, "x of the end");
      assertNear(line.actual.endMm.y, BOX_DEPTH_MM, "y of the end");
      assert.equal((await separatorCount(client)) - lines, 1);

      const [model] = (await elementsOf(client, { ids: [line.elementId] })).elements;
      assert.equal(model?.category, "OST_RoomSeparationLines");
      assert.equal(model?.levelId, w.ground.id);

      // The room that was there is cut in two at once, and the half that has no room is a room of its own.
      const half = ((BOX_WIDTH_MM / 2 - t / 2) * (BOX_DEPTH_MM - t)) / 1_000_000;
      const [left] = (await elementsOf(client, { ids: [whole.roomId] })).elements;
      assertNear(left?.areaM2, half, "the room that was whole is half now", AREA_M2);

      const [right] = landed(await createRooms(client, [{ levelId: w.ground.id, pointMm: { x: whole.x + 7500, y: BOX_DEPTH_MM / 2 }, name: "Кухня", number: "121" }]), "created");
      assert.ok(right);
      assertNear(right.actual.areaM2, half, "the new room is the other half", AREA_M2);
      assertNear((left?.areaM2 ?? 0) + right.actual.areaM2, whole.areaM2, "and the two make the whole again", AREA_M2);

      // The tool text says that delete_elements takes a separator away.
      const deleted = (await client.call("delete_elements", { ids: [line.elementId], dryRun: false })) as { committed: boolean; errors: string[] };
      assert.equal(deleted.committed, true, JSON.stringify(deleted));
      assert.equal(await separatorCount(client), lines, "the separator is gone");
      assert.deepEqual((await elementsOf(client, { ids: [line.elementId] })).notFound, [line.elementId]);
    });
  });

  it("kitchen and living room stay separate with no wall", async () => {
    await withClient(async (client) => {
      const w = ready();
      const x = scene();
      const width = 12000;
      const walls = await box(client, x, w.ground, width);
      const t = walls.thicknessMm;
      const wallsBefore = await elementsOf(client, { category: "walls", levelId: w.ground.id });

      // The line first, then a room on each side of it.
      const dividerX = x + 7000;
      landed(await createSeparators(client, [{ levelId: w.ground.id, startMm: { x: dividerX, y: 0 }, endMm: { x: dividerX, y: BOX_DEPTH_MM } }]), "created");
      const [living, kitchen] = landed(
        await createRooms(client, [
          { levelId: w.ground.id, pointMm: { x: x + 3500, y: BOX_DEPTH_MM / 2 }, name: "Гостиная", number: "130" },
          { levelId: w.ground.id, pointMm: { x: x + 9500, y: BOX_DEPTH_MM / 2 }, name: "Кухня", number: "131" },
        ]),
        "created",
        2,
      );
      assert.ok(living && kitchen);

      console.log(`# living ${JSON.stringify(living.actual)} kitchen ${JSON.stringify(kitchen.actual)}`);
      assert.deepEqual([living.actual.name, kitchen.actual.name], ["Гостиная", "Кухня"]);
      assertNear(living.actual.areaM2, ((7000 - t / 2) * (BOX_DEPTH_MM - t)) / 1_000_000, "living room area", AREA_M2);
      assertNear(kitchen.actual.areaM2, ((5000 - t / 2) * (BOX_DEPTH_MM - t)) / 1_000_000, "kitchen area", AREA_M2);
      assertNear(living.actual.areaM2 + kitchen.actual.areaM2, netAreaM2(width, BOX_DEPTH_MM, t), "together they fill the box", AREA_M2);

      // There is no wall between them: the walls of the level are the same as before the line, and none stands inside the box.
      const wallsAfter = await elementsOf(client, { category: "walls", levelId: w.ground.id });
      assert.deepEqual(
        wallsAfter.elements.map((row) => row.id),
        wallsBefore.elements.map((row) => row.id),
      );
      const inside = wallsAfter.elements.filter((row) => row.boundingBoxMm && row.boundingBoxMm.min.x > x + t && row.boundingBoxMm.max.x < x + width - t && row.boundingBoxMm.min.y > t && row.boundingBoxMm.max.y < BOX_DEPTH_MM - t);
      assert.deepEqual(inside, [], "no wall stands between the rooms");

      // A line that stops short of the north wall divides nothing, and Revit does not say so: the call lands as created with no warning,
      // and the second room finds the first one's region. This is what the tool text tells the model to check with the areas.
      const other = await box(client, scene(), w.ground);
      landed(await createSeparators(client, [{ levelId: w.ground.id, startMm: { x: other.centre.x, y: 0 }, endMm: { x: other.centre.x, y: BOX_DEPTH_MM - 2000 } }]), "created");
      const short = await createRooms(client, [
        { levelId: w.ground.id, pointMm: { x: other.centre.x - 2500, y: other.centre.y }, name: "Левая" },
        { levelId: w.ground.id, pointMm: { x: other.centre.x + 2500, y: other.centre.y }, name: "Правая" },
      ]);

      assert.equal(short.committed, false, "a short line leaves one region, so the second room has none");
      assert.deepEqual(
        short.items.map((item) => item.status),
        ["rolled_back", "failed"],
      );
    });
  });

  it("level without a floor plan is refused before any change", async () => {
    await withClient(async (client) => {
      const w = ready();
      const onBare = { levelId: w.bare.id, startMm: { x: 0, y: -9000 }, endMm: { x: 3000, y: -9000 } };

      const error = await refusedAndUnchanged(client, "create_room_separators", { items: [onBare] }, /create_room_separators item 0: level \d+ .* has no floor plan view/, "a level without a plan");

      console.log(`# refusal: ${error.message}`);
      assert.match(error.message, new RegExp(w.bare.name), "names the level");
      assert.match(error.message, new RegExp(`${w.ground.id} \\('${w.ground.name}'\\)`), "lists the levels that have a plan");
      assert.match(error.message, /createPlan is false/);

      // The same level behind a valid item: the valid one is not made either.
      const good = { levelId: w.ground.id, startMm: { x: 0, y: -9000 }, endMm: { x: 3000, y: -9000 } };
      await refusedAndUnchanged(client, "create_room_separators", { items: [good, onBare] }, /create_room_separators item 1/, "a valid item before a level without a plan");

      // A room on that level is no different from a room on another: walls decide, and the plan does not.
      const walls = await box(client, scene(), w.bare);
      const [room] = landed(await createRooms(client, [{ levelId: w.bare.id, pointMm: walls.centre, name: "Верхняя комната" }]), "created");
      assert.ok(room);
      assertNear(room.actual.areaM2, netAreaM2(BOX_WIDTH_MM, BOX_DEPTH_MM, walls.thicknessMm), "area of the room on a level with no plan", AREA_M2);
    });
  });

  it("bad input is refused before any change", async () => {
    await withClient(async (client) => {
      const w = ready();
      const point = { x: 1000, y: -9000 };
      const room = { levelId: w.ground.id, pointMm: point, name: "Комната" };
      const line = { levelId: w.ground.id, startMm: { x: 0, y: -9000 }, endMm: { x: 3000, y: -9000 } };
      const wallId = (await box(client, scene(), w.ground)).ids[0];

      for (const [items, pattern, what] of [
        [[{ ...room, levelId: "1" }], /create_rooms item 0: levelId "1" is not a level/, "no level"],
        [[{ ...room, levelId: wallId }], /is not a level/, "a wall for a level"],
        [[{ ...room, levelId: undefined }], /levelId must be an element id/, "no level given"],
        [[{ ...room, pointMm: undefined }], /pointMm must be a point with x and y/, "no point"],
        [[{ ...room, pointMm: { x: 1 } }], /pointMm must be a point with x and y/, "a point with no y"],
        [[{ ...room, name: undefined }], /name must be text/, "no name"],
        [[{ ...room, name: 5 }], /name must be text/, "a name that is a number"],
        [[{ ...room, name: "   " }], /name must not be empty or only spaces/, "a name of spaces"],
        [[{ ...room, number: 101 }], /number must be text/, "a number that is a number"],
        [[{ ...room, number: " " }], /number must not be empty or only spaces/, "a number of spaces"],
        [[room, { ...room, name: undefined }], /create_rooms item 1/, "a valid room before an invalid one"],
      ] as const) {
        await refusedAndUnchanged(client, "create_rooms", { items }, pattern, what);
      }

      for (const [items, pattern, what] of [
        [[{ ...line, levelId: "1" }], /create_room_separators item 0: levelId "1" is not a level/, "no level"],
        [[{ ...line, levelId: wallId }], /is not a level/, "a wall for a level"],
        [[{ ...line, startMm: undefined }], /startMm must be a point with x and y/, "no start"],
        [[{ ...line, endMm: { y: 0 } }], /endMm must be a point with x and y/, "an end with no x"],
        [[{ ...line, endMm: line.startMm }], /closer than the .* mm Revit can draw/, "a line of no length"],
        [[{ ...line, endMm: { x: line.startMm.x + 0.1, y: line.startMm.y } }], /closer than the .* mm Revit can draw/, "a line too short to draw"],
        [[line, { ...line, startMm: undefined }], /create_room_separators item 1/, "a valid line before an invalid one"],
      ] as const) {
        await refusedAndUnchanged(client, "create_room_separators", { items }, pattern, what);
      }
    });
  });

  it("one call is one undo step", async (t) => {
    await withClient(async (client) => {
      const w = ready();
      const first = await box(client, scene(), w.ground);
      const second = await box(client, scene(), w.ground);
      const roomsBefore = await roomCount(client);

      const rooms = landed(
        await createRooms(client, [
          { levelId: w.ground.id, pointMm: first.centre, name: "Первая", number: "140" },
          { levelId: w.ground.id, pointMm: second.centre, name: "Вторая", number: "141" },
        ]),
        "created",
        2,
      );
      const roomIds = rooms.map((room) => room.elementId);
      assert.equal((await roomCount(client)) - roomsBefore, 2);

      const undoneRooms = await undoWithOneRetry(t, client);

      console.log(`# undo rooms: ${JSON.stringify({ ...undoneRooms, createdIds: undoneRooms.createdIds.length })}`);
      assert.equal(undoneRooms.transactionName, "MCP: create_rooms");
      for (const id of roomIds) {
        assert.ok(undoneRooms.createdIds.includes(id), `room ${id} is named as created`);
      }
      assert.deepEqual((await elementsOf(client, { ids: roomIds })).notFound, roomIds);
      assert.equal(await roomCount(client), roomsBefore, "both rooms went with one undo");

      const linesBefore = await separatorCount(client);
      const [line] = landed(await createSeparators(client, [{ levelId: w.ground.id, startMm: { x: first.centre.x, y: 0 }, endMm: { x: first.centre.x, y: BOX_DEPTH_MM } }]), "created");
      assert.ok(line);
      assert.equal((await separatorCount(client)) - linesBefore, 1);

      const undoneLine = await undoWithOneRetry(t, client);

      assert.equal(undoneLine.transactionName, "MCP: create_room_separators");
      assert.ok(undoneLine.createdIds.includes(line.elementId), "the separator is named as created");
      assert.deepEqual((await elementsOf(client, { ids: [line.elementId] })).notFound, [line.elementId]);
      assert.equal(await separatorCount(client), linesBefore);
      assert.deepEqual((await elementsOf(client, { ids: first.ids })).notFound, [], "the walls below are still there");
    });
  });

  it("a room that lost a wall is still read, with an area of 0", async () => {
    await withClient(async (client) => {
      const w = ready();
      const kept = await furnished(client, "Осиротевшая", "150");
      assert.ok(kept.areaM2 > 0);

      // Without one wall the room is not enclosed any more: Revit keeps it, with its name and number, and its area is 0. It stays placed, so this is
      // not an unplaced room, which no tool can make.
      const walled = (await client.call("delete_elements", { ids: [kept.walls.ids[0]], dryRun: false })) as { committed: boolean; errors: string[] };
      assert.equal(walled.committed, true, JSON.stringify(walled));

      const byId = await elementsOf(client, { ids: [kept.roomId] });
      console.log(`# room without a wall: ${JSON.stringify(byId.elements[0])}`);
      assert.deepEqual(byId.notFound, []);
      const [row] = byId.elements;
      assert.deepEqual([row?.category, row?.name, row?.number, row?.levelId, row?.areaM2], ["rooms", "Осиротевшая", "150", w.ground.id, 0]);

      const listed = (await roomsOf(client, { levelId: w.ground.id })).find((entry) => entry.id === kept.roomId);
      assert.ok(listed, "the room is still listed on its level");
      assert.equal(listed.areaM2, 0);

      // The room goes too, so the warning of a room that is not enclosed does not stay in the model for the tests after this one.
      const gone = (await client.call("delete_elements", { ids: [kept.roomId], dryRun: false })) as { committed: boolean };
      assert.equal(gone.committed, true);
      assert.deepEqual((await elementsOf(client, { ids: [kept.roomId] })).notFound, [kept.roomId]);
    });
  });

  // Run last, after a save. A separator from a 3D view closed Revit in the probe of task 1, so nothing in the command touches the
  // active view or passes a view that is not the floor plan of the level, and this checks that a 3D view in the project changes
  // none of that. It does NOT test an active 3D view: no tool switches the view that is open in the Revit window (create_3d_view
  // leaves it as it is), so the 3D view made here exists but is not the open one. That case waits for a person to switch Revit to a
  // 3D view (task 13), and the call is repeated then. If Revit closes or a dialog comes up, stop: do not run it again, a person has
  // to answer Revit.
  it("separator is drawn in the floor plan of its level while the project has a 3D view", async (t) => {
    await withClient(async (client) => {
      const w = ready();
      const viewName = `Вид-3D для разделителя ${stamp}`;
      const view = (await client.call("create_3d_view", { name: viewName, kind: "isometric", displayStyle: "shading" })) as { committed: boolean; viewId: string };
      assert.equal(view.committed, true, JSON.stringify(view));
      await client.call("save_project", {});
      assert.equal((await modelInfo(client)).activeDocument?.isModified, false, "everything is saved before the call");

      const walls = await box(client, scene(), w.ground);
      await client.call("save_project", {});
      const lines = await separatorCount(client);

      const [line] = landed(
        await createSeparators(client, [{ levelId: w.ground.id, startMm: { x: walls.centre.x, y: 0 }, endMm: { x: walls.centre.x, y: BOX_DEPTH_MM } }]),
        "created",
      );

      assert.ok(line);
      t.diagnostic(
        `The case of an ACTIVE 3D view was NOT exercised. 3D view "${viewName}" (${view.viewId}) exists in the project, but no tool makes it the open view of Revit, and the open view stayed the floor plan. Repeat this call with Revit switched to that view by hand.`,
      );
      assert.equal(line.actual.levelId, w.ground.id);
      assert.equal((await separatorCount(client)) - lines, 1);
      assert.ok((await modelInfo(client)).views.some((entry) => entry.id === view.viewId && entry.viewType === "ThreeD"), "the 3D view is still there");

      await client.call("save_project", {});
      assert.deepEqual(checkCanClose((await modelInfo(client)).openDocuments), { ok: true, reasons: [] });
    });
  });
});
