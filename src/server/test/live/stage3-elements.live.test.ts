import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { checkCanClose } from "../../src/cli/closeRule.ts";
import { BridgeClient } from "../../src/client.ts";
import { defaultConnectionPath } from "../../src/connection.ts";

// These tests need a running Revit with the RevitMCP plugin loaded. Each run creates one new project in the test folder and leaves it
// open and saved. They read what the inspector of a finished building reads: where a door or window stands, which rooms a door joins, and
// the area of a floor, a ceiling and a roof. What get_elements says is compared with what was asked for and with values worked out by
// hand, never with the answer of place_hosted, which comes from the same reader. Scenes stand far apart, so that no room reaches another.

interface Level {
  id: string;
  name: string;
  elevationMm: number;
}

interface ModelInfo {
  activeDocument: { title: string; isModified: boolean } | null;
  openDocuments: Array<{ title: string; path: string; isModified: boolean }>;
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
  min: Point & { z: number };
  max: Point & { z: number };
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

type Landed<A> = Item<A> & { elementId: string; actual: A };

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

/** The keys of a door or window, in place_hosted and in get_elements alike. */
interface Opening {
  hostId: string | null;
  offsetAlongWallMm: number | null;
  sillHeightMm: number | null;
  widthMm: number | null;
  heightMm: number | null;
  facingFlipped: boolean;
  handFlipped: boolean;
  fromRoomId: string | null;
  toRoomId: string | null;
  cutsWall: boolean;
}

interface ElementRow extends Partial<Opening> {
  id: string;
  category: string | null;
  typeName: string | null;
  levelId: string | null;
  boundingBoxMm: Box | null;
  topMm?: number | null;
  name?: string;
  number?: string;
  areaM2?: number | null;
}

interface ElementsAnswer {
  elements: ElementRow[];
  notFound: string[];
  truncated: boolean;
}

interface WallActual {
  startMm: Point;
  endMm: Point;
  lengthMm: number;
  widthMm: number;
}

interface LastUndo {
  state: string;
  transactionName: string | null;
}

const OPENING_KEYS = ["hostId", "offsetAlongWallMm", "sillHeightMm", "widthMm", "heightMm", "facingFlipped", "handFlipped", "fromRoomId", "toRoomId", "cutsWall"] as const;

/** A position or a size reads back as the number asked for, within the noise of feet. */
const NEAR_MM = 0.01;
/** Areas come back in square metres with the noise of feet: far above it, far below any real difference. */
const NEAR_M2 = 0.001;
const SCENE_PITCH_MM = 40000;
const STOREY_MM = 3000;
const BOX_WIDTH_MM = 10000;
const BOX_DEPTH_MM = 6000;

/** The library of this machine, the same folder as LibraryFolder.Root in the plugin. */
const DOOR = "Russia\\Двери\\Дверь-Одинарная-Панель.rfa";
const WINDOW = "Russia\\Окна\\Окно-закрепленное.rfa";
const BED = "Russia\\Мебель\\Кровати\\Кровать-Стандарт.rfa";
const WC = "Russia\\Сантехника\\Архитектурные\\Приборы\\Унитазы\\Туалет-Домашний-3D.rfa";
/** A door that is a bare opening, with no leaf: its Width and Height read 0, and its size is in its Rough Width and Rough Height. */
const DOOR_OPENING = "Russia\\Двери\\Дверь-Проем.rfa";
/** A door and a window that are panels of a curtain wall: a Revit Panel, which is a FamilyInstance of the category doors or windows. */
const CURTAIN_DOOR = "Russia\\Двери\\Дверь-Витраж-Одинарная-Остекление.rfa";
const CURTAIN_WINDOW = "Russia\\Окна\\Витраж-тент.rfa";

const stamp = new Date().toTimeString().slice(0, 8).replaceAll(":", "");
const name = `проверка-этап3-чтение-проёмов-${stamp}`;

/** What the tests share: the levels, and the types they place. */
interface World {
  ground: Level;
  upper: Level;
  wallType: TypeRow;
  floorType: TypeRow;
  ceilingType: TypeRow;
  roofType: TypeRow;
  landType: TypeRow;
  /** The door 800 wide and 2100 high, and the window 600 wide and 1200 high. */
  door: TypeActual;
  window: TypeActual;
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

const listTypes = (client: BridgeClient, category: string): Promise<TypeRow[]> => client.call("list_types", { category }) as Promise<TypeRow[]>;

const elementsOf = (client: BridgeClient, params: object): Promise<ElementsAnswer> => client.call("get_elements", params) as Promise<ElementsAnswer>;

const call = <A>(client: BridgeClient, method: string, items: unknown[]): Promise<Batch<A>> => client.call(method, { items }) as Promise<Batch<A>>;

function ready(): World {
  assert.ok(world, "the first test creates the project");
  return world;
}

/** The x of the next scene, so that no scene touches another. */
function scene(): number {
  const x = nextSceneX;
  nextSceneX += SCENE_PITCH_MM;
  return x;
}

function assertNear(actual: unknown, expected: number, what: string, within = NEAR_MM): void {
  assert.equal(typeof actual, "number", `${what}: ${String(actual)}`);
  assert.ok(Math.abs((actual as number) - expected) < within, `${what}: ${String(actual)}, expected ${expected}`);
}

/** A call that landed with the status asked for, and its items. An item carries no warning unless the caller says it should. */
function landed<A>(batch: Batch<A>, status: string, itemWarnings: "none" | "some" = "none"): Array<Landed<A>> {
  assert.equal(batch.committed, true, JSON.stringify(batch).slice(0, 1800));
  assert.deepEqual(batch.errors, []);
  assert.deepEqual(batch.dialogs, []);

  return batch.items.map((item) => {
    assert.equal(item.status, status, JSON.stringify(item).slice(0, 1200));
    assert.ok(item.elementId && item.actual, JSON.stringify(item).slice(0, 1200));
    if (itemWarnings === "none") {
      assert.deepEqual(item.warnings, [], JSON.stringify(item).slice(0, 1200));
    }
    return item as Landed<A>;
  });
}

function only<A>(items: Array<Landed<A>>): Landed<A> {
  assert.equal(items.length, 1);
  return items[0]!;
}

async function typeNamed(client: BridgeClient, category: string, pattern: RegExp): Promise<TypeRow> {
  const rows = await listTypes(client, category);
  const found = rows.find((type) => pattern.test(type.name));
  assert.ok(found, `no ${category} type matches ${String(pattern)} in ${JSON.stringify(rows.map((row) => row.name))}`);

  return found;
}

const rectangle = (x0: number, y0: number, x1: number, y1: number): Point[] => [
  { x: x0, y: y0 },
  { x: x1, y: y0 },
  { x: x1, y: y1 },
  { x: x0, y: y1 },
];

/** One row of a family loaded with the sizes given, and the type it makes. */
async function loadRow(client: BridgeClient, family: string, typeName: string, widthMm?: number, heightMm?: number): Promise<TypeActual> {
  const sizes = widthMm === undefined ? {} : { widthMm, heightMm };
  const loaded = only(landed(await call<FamilyActual>(client, "load_family", [{ path: family, typeName, ...sizes }]), "created", "some"));
  const type = loaded.actual.typeIds.find((row) => row.name === typeName);
  assert.ok(type, `no type '${typeName}' in ${JSON.stringify(loaded.actual.typeIds)}`);

  return type;
}

/** Straight walls of the wall type on the ground level, as one call. */
async function makeWalls(client: BridgeClient, lines: Array<[Point, Point]>, extra: { baseOffsetMm?: number } = {}): Promise<Array<Landed<WallActual>>> {
  const w = ready();

  return landed(
    await call<WallActual>(
      client,
      "create_walls",
      lines.map(([startMm, endMm]) => ({ startMm, endMm, typeId: w.wallType.id, levelId: w.ground.id, heightMm: STOREY_MM, ...extra })),
    ),
    "created",
  );
}

/** Four walls round a rectangle that run counter-clockwise from its south west corner, so south, east, north and west, joined at the corners by Revit. */
async function boxOfWalls(client: BridgeClient, x: number, width = BOX_WIDTH_MM, depth = BOX_DEPTH_MM, extra: { baseOffsetMm?: number } = {}): Promise<{ ids: [string, string, string, string]; thicknessMm: number; corners: Point[] }> {
  const corners = rectangle(x, 0, x + width, depth);
  const walls = await makeWalls(client, corners.map((from, index) => [from, corners[(index + 1) % corners.length]!]), extra);

  return { ids: walls.map((wall) => wall.elementId) as [string, string, string, string], thicknessMm: walls[0]!.actual.widthMm, corners };
}

async function place(client: BridgeClient, items: object[], itemWarnings: "none" | "some" = "none"): Promise<Array<Landed<Opening>>> {
  return landed(await call<Opening>(client, "place_hosted", items), "created", itemWarnings);
}

/** One element as get_elements reads it by id. */
async function rowOf(client: BridgeClient, id: string): Promise<ElementRow> {
  const answer = await elementsOf(client, { ids: [id] });
  assert.deepEqual(answer.notFound, []);
  assert.equal(answer.elements.length, 1);

  return answer.elements[0]!;
}

async function rooms(client: BridgeClient, items: object[]): Promise<Array<Landed<{ name: string; areaM2: number }>>> {
  return landed(await call<{ name: string; areaM2: number }>(client, "create_rooms", items), "created");
}

const centreOf = (box: Box | null): Point => {
  assert.ok(box);
  return { x: (box.min.x + box.max.x) / 2, y: (box.min.y + box.max.y) / 2 };
};

const degrees = (value: number): number => (value * Math.PI) / 180;

/** The area of a floor or a ceiling or a roof as get_elements reads it, by id and by its category word, which must agree. */
async function areaOf(client: BridgeClient, id: string, category: string): Promise<number> {
  const row = await rowOf(client, id);
  assert.equal(row.category, category);
  const listed = (await elementsOf(client, { category })).elements.find((element) => element.id === id);
  assert.equal(listed?.areaM2, row.areaM2, `the area of ${id} is the same by id and by category`);
  assert.equal(typeof row.areaM2, "number", JSON.stringify(row));

  return row.areaM2 as number;
}

/** A gable roof over a rectangle, whose two long sides slope, read by area. */
async function gableAreaM2(client: BridgeClient, widthMm: number, depthMm: number, slopeDeg: number, overhangMm: number): Promise<number> {
  const w = ready();
  const x = scene();
  const roof = only(
    landed(
      await call<unknown>(client, "create_roof", [
        { outlineMm: rectangle(x, 0, x + widthMm, depthMm), levelId: w.upper.id, typeId: w.roofType.id, overhangMm, edgeSlopesDeg: [slopeDeg, null, slopeDeg, null] },
      ]),
      "created",
    ),
  );

  return areaOf(client, roof.elementId, "roofs");
}

describe("stage 3 live checks: get_elements reads openings and areas", { timeout: 600_000 }, () => {
  it("creates a project for this run, with the types it needs", async () => {
    await withClient(async (client) => {
      await client.call("create_project", { name });

      const info = await modelInfo(client);
      assert.equal(info.activeDocument?.title, name);
      const ground = info.levels.find((level) => level.elevationMm === 0);
      const upper = info.levels.find((level) => level.elevationMm > 0);
      assert.ok(ground && upper, `no two levels in ${JSON.stringify(info.levels)}`);

      const wallType = await typeNamed(client, "walls", /^Наружный - Стена из бруса толщиной 180 мм/);
      const floorType = await typeNamed(client, "floors", /^Типовой 300мм$/);
      const ceilingType = await typeNamed(client, "ceilings", /^Типовой$/);
      const roofType = await typeNamed(client, "roofs", /^Теплая крыша - Деревянный брус$/);
      const landType = await typeNamed(client, "toposolid", /^Луг/);

      // The sizes are given: a catalog row that is loaded as it is has the size of its family, not the one its name says.
      const door = await loadRow(client, DOOR, "800 x 2100 мм", 800, 2100);
      const window = await loadRow(client, WINDOW, "600 x 1200 мм", 600, 1200);

      world = { ground, upper, wallType, floorType, ceilingType, roofType, landType, door, window };
      console.log(`# world: ${JSON.stringify(world)}`);
    });
  });

  it("a door placed before the rooms on both its sides reads those two rooms afterwards", async () => {
    await withClient(async (client) => {
      const w = ready();
      const x = scene();
      await boxOfWalls(client, x);

      // A partition from the south wall to the north wall, with the door in it, and no room in the model on either side of it.
      const [partition] = await makeWalls(client, [[{ x: x + 5000, y: 0 }, { x: x + 5000, y: BOX_DEPTH_MM }]]);
      assert.ok(partition);
      const door = only(await place(client, [{ typeId: w.door.id, wallId: partition.elementId, offsetAlongWallMm: 3000 }]));
      assert.deepEqual([door.actual.fromRoomId, door.actual.toRoomId], [null, null], "there is no room yet");

      const early = await rowOf(client, door.elementId);
      assert.ok("fromRoomId" in early && "toRoomId" in early, "null is the answer, not a missing key");
      assert.deepEqual([early.fromRoomId, early.toRoomId], [null, null], "and get_elements says the same");

      const [left, right] = await rooms(client, [
        { levelId: w.ground.id, pointMm: { x: x + 2500, y: 3000 }, name: "Гостиная", number: "1" },
        { levelId: w.ground.id, pointMm: { x: x + 7500, y: 3000 }, name: "Кухня", number: "2" },
      ]);
      assert.ok(left && right);

      const late = await rowOf(client, door.elementId);
      console.log(`# door between two rooms: ${JSON.stringify(late)}, rooms ${left.elementId} and ${right.elementId}`);
      assert.ok(late.fromRoomId && late.toRoomId, `Revit gives the door its rooms: ${JSON.stringify(late)}`);
      assert.deepEqual([late.fromRoomId, late.toRoomId].sort(), [left.elementId, right.elementId].sort(), "the door joins those two rooms");

      // The ids are rooms that get_elements reads by name, which is how the inspector names them.
      assert.deepEqual([(await rowOf(client, late.fromRoomId)).name, (await rowOf(client, late.toRoomId)).name].sort(), ["Гостиная", "Кухня"].sort());
    });
  });

  it("a door in an outer wall reads one room and one null", async () => {
    await withClient(async (client) => {
      const w = ready();
      const x = scene();
      const { ids } = await boxOfWalls(client, x);
      const door = only(await place(client, [{ typeId: w.door.id, wallId: ids[0], offsetAlongWallMm: 4000 }]));
      const room = only(await rooms(client, [{ levelId: w.ground.id, pointMm: { x: x + 5000, y: 3000 }, name: "Прихожая", number: "3" }]));

      const row = await rowOf(client, door.elementId);
      console.log(`# door in an outer wall: from ${String(row.fromRoomId)}, to ${String(row.toRoomId)}, room ${room.elementId}`);
      const sides = [row.fromRoomId, row.toRoomId];
      assert.ok("fromRoomId" in row && "toRoomId" in row);
      assert.deepEqual(sides.filter((side) => side === null).length, 1, `one side is outdoors: ${JSON.stringify(sides)}`);
      assert.deepEqual(sides.filter((side) => side !== null), [room.elementId], "and the other is the room");
    });
  });

  it("a window reads what was asked, on a wall away from the origin, on one drawn right to left and on a slanted one", async () => {
    await withClient(async (client) => {
      const w = ready();
      const x = scene();
      const y = 5000;

      // A wall along +X that starts at x + 1000, the same drawn from its other end, and one at a slant of 3:4, whose length is 5000.
      const [forward, backward, slanted] = await makeWalls(client, [
        [{ x: x + 1000, y }, { x: x + 9000, y }],
        [{ x: x + 9000, y: y + 6000 }, { x: x + 1000, y: y + 6000 }],
        [{ x: x + 12000, y }, { x: x + 15000, y: y + 4000 }],
      ]);
      assert.ok(forward && backward && slanted);

      const asked = [
        { typeId: w.window.id, wallId: forward.elementId, offsetAlongWallMm: 2345.5, sillHeightMm: 912.5 },
        { typeId: w.window.id, wallId: backward.elementId, offsetAlongWallMm: 2345.5, sillHeightMm: 700 },
        { typeId: w.window.id, wallId: slanted.elementId, offsetAlongWallMm: 2500, sillHeightMm: 1000 },
      ];
      const placed = await place(client, asked);

      // Where the middle of each window must stand in the plan, worked out from the request alone.
      const expected = [
        { x: x + 1000 + 2345.5, y },
        { x: x + 9000 - 2345.5, y: y + 6000 },
        { x: x + 12000 + 1500, y: y + 2000 },
      ];

      for (const [index, request] of asked.entries()) {
        const row = await rowOf(client, placed[index]!.elementId);
        const what = `window ${index}`;
        console.log(`# ${what}: ${JSON.stringify(row)}`);

        assert.equal(row.hostId, request.wallId, what);
        assertNear(row.offsetAlongWallMm, request.offsetAlongWallMm, `${what}: offset, as asked`);
        assertNear(row.sillHeightMm, request.sillHeightMm, `${what}: sill, as asked`);
        assertNear(row.widthMm, w.window.widthMm!, `${what}: width`);
        assertNear(row.heightMm, w.window.heightMm!, `${what}: height`);
        assert.equal(row.cutsWall, true, what);
        assert.equal(row.facingFlipped, false, what);
        assert.equal(row.handFlipped, false, what);

        // The box says where it is from another side, and along the axis: its reach across the wall differs on each side.
        const centre = centreOf(row.boundingBoxMm);
        const along = index === 2 ? (centre.x - expected[2]!.x) * 0.6 + (centre.y - expected[2]!.y) * 0.8 : centre.x - expected[index]!.x;
        assertNear(along, 0, `${what}: the middle of its box along the wall is where the offset says`, 1);
      }
    });
  });

  it("the offset of a door counts from the start of the axis after a joined wall moves that start", async () => {
    await withClient(async (client) => {
      const w = ready();
      const x = scene();
      const { ids } = await boxOfWalls(client, x);
      const [south, east, , west] = ids;

      const door = only(await place(client, [{ typeId: w.door.id, wallId: south, offsetAlongWallMm: 3000 }]));
      const before = await rowOf(client, door.elementId);
      assertNear(before.offsetAlongWallMm, 3000, "the door before the walls move");
      const standsAt = centreOf(before.boundingBoxMm);

      // The west wall moves 1000 out, across itself, and the south wall follows it: its axis starts at x - 1000 now. Revit leaves the door where it stood.
      const moved = only(landed(await call<{ startMm: Point }>(client, "update_elements", [{ id: west, moveMm: { x: -1000, y: 0, z: 0 } }]), "updated"));
      assertNear(moved.actual.startMm.x, x - 1000, "the west wall moved");

      const lengthened = await rowOf(client, door.elementId);
      console.log(`# door after the start of its wall moved 1000 out: ${JSON.stringify(lengthened)}`);
      assertNear(centreOf(lengthened.boundingBoxMm).x, standsAt.x, "the door stands where it stood", 0.01);
      assertNear(lengthened.offsetAlongWallMm, 4000, "the start of the axis is 1000 further from the door");

      // The end of the same wall moves, which the offset does not count from.
      landed(await call<unknown>(client, "update_elements", [{ id: east, moveMm: { x: 500, y: 0, z: 0 } }]), "updated");
      assertNear((await rowOf(client, door.elementId)).offsetAlongWallMm, 4000, "the end of the axis is no part of the offset");
    });
  });

  it("sizes are those of the type, and a bare opening reads its rough size", async () => {
    await withClient(async (client) => {
      const w = ready();
      const x = scene();
      const [wall] = await makeWalls(client, [[{ x, y: 0 }, { x: x + 9000, y: 0 }]]);
      assert.ok(wall);

      const opening = await loadRow(client, DOOR_OPENING, "0762 x 2032 мм");
      assert.deepEqual([opening.widthMm, opening.heightMm], [0, 0], "a bare opening reads a Width and a Height of 0");

      const placed = await place(
        client,
        [
          { typeId: w.door.id, wallId: wall.elementId, offsetAlongWallMm: 1000 },
          { typeId: w.window.id, wallId: wall.elementId, offsetAlongWallMm: 3000, sillHeightMm: 900 },
          { typeId: opening.id, wallId: wall.elementId, offsetAlongWallMm: 5000 },
        ],
        "some",
      );

      const sizes = [[800, 2100], [600, 1200], [762, 2032]] as const;
      for (const [index, [widthMm, heightMm]] of sizes.entries()) {
        const { actual, elementId } = placed[index]!;
        const row = await rowOf(client, elementId);
        console.log(`# size ${index}: place_hosted ${actual.widthMm} x ${actual.heightMm}, get_elements ${row.widthMm} x ${row.heightMm}`);
        assertNear(actual.widthMm, widthMm, `place_hosted, width ${index}`);
        assertNear(actual.heightMm, heightMm, `place_hosted, height ${index}`);
        assert.equal(row.widthMm, actual.widthMm, `the width of ${index} is one reader`);
        assert.equal(row.heightMm, actual.heightMm, `the height of ${index} is one reader`);
      }
    });
  });

  it("a door type, furniture, plumbing and a wall carry none of the new keys, and a read that mixes them with a door succeeds", async () => {
    await withClient(async (client) => {
      const w = ready();
      const x = scene();
      const [wall] = await makeWalls(client, [[{ x, y: 0 }, { x: x + 6000, y: 0 }]]);
      assert.ok(wall);
      const door = only(await place(client, [{ typeId: w.door.id, wallId: wall.elementId, offsetAlongWallMm: 2000 }]));

      const bed = await loadRow(client, BED, "1372 x 1905мм - Двуспальная");
      const family = only(landed(await call<FamilyActual>(client, "load_family", [{ path: WC }]), "created", "some"));
      const [placedBed, placedWc] = landed(
        await call<unknown>(client, "place_instances", [
          { typeId: bed.id, pointMm: { x: x + 1500, y: 3000 }, levelId: w.ground.id },
          { typeId: family.actual.typeIds[0]!.id, pointMm: { x: x + 4000, y: 3000 }, levelId: w.ground.id },
        ]),
        "created",
      );
      assert.ok(placedBed && placedWc);

      const ids = [w.door.id, placedBed.elementId, door.elementId, placedWc.elementId, wall.elementId];
      const answer = await elementsOf(client, { ids });
      assert.deepEqual(answer.notFound, []);
      assert.deepEqual(answer.elements.map((row) => row.id), ids, "each comes back, in the order asked");
      console.log(`# mixed: ${JSON.stringify(answer.elements.map((row) => Object.keys(row)))}`);

      const [typeRow, bedRow, doorRow, wcRow, wallRow] = answer.elements;
      assert.ok(typeRow && bedRow && doorRow && wcRow && wallRow);
      assert.deepEqual([typeRow.category, bedRow.category, doorRow.category, wcRow.category, wallRow.category], ["doors", "furniture", "doors", "plumbing", "walls"]);

      for (const row of [typeRow, bedRow, wcRow, wallRow]) {
        for (const key of [...OPENING_KEYS, "areaM2"]) {
          assert.ok(!(key in row), `${row.category} ${row.id} carries no ${key}: ${JSON.stringify(row)}`);
        }
      }
      for (const key of OPENING_KEYS) {
        assert.ok(key in doorRow, `the door carries ${key}: ${JSON.stringify(doorRow)}`);
      }
      assert.ok(!("areaM2" in doorRow), "a door has no area");
      assert.ok(!("topMm" in doorRow), "and no top");
      assert.equal(typeof wallRow.topMm, "number", "a wall keeps its top");
    });
  });

  it("the categories doors and windows list what a read by id gives", async () => {
    await withClient(async (client) => {
      const w = ready();
      const x = scene();
      const [wall] = await makeWalls(client, [[{ x, y: 0 }, { x: x + 6000, y: 0 }]]);
      assert.ok(wall);
      const [door, window] = await place(client, [
        { typeId: w.door.id, wallId: wall.elementId, offsetAlongWallMm: 1500, flipHand: true, flipFacing: true },
        { typeId: w.window.id, wallId: wall.elementId, offsetAlongWallMm: 4000, sillHeightMm: 800 },
      ]);
      assert.ok(door && window);

      for (const [category, id] of [["doors", door.elementId], ["windows", window.elementId]] as const) {
        const listed = await elementsOf(client, { category });
        assert.equal(listed.truncated, false);
        const row = listed.elements.find((element) => element.id === id);
        assert.ok(row, `${category} lists ${id}`);
        assert.deepEqual(row, await rowOf(client, id), `${category}: the same row`);
        assert.deepEqual(Object.keys(row).sort(), ["id", "category", "typeName", "levelId", "boundingBoxMm", ...OPENING_KEYS].sort(), `${category}: the same keys`);

        for (const other of listed.elements) {
          assert.deepEqual(Object.keys(other).sort(), Object.keys(row).sort(), `${category}: every row has the same keys`);
        }
      }

      const flipped = await rowOf(client, door.elementId);
      assert.deepEqual([flipped.facingFlipped, flipped.handFlipped], [true, true], "the flips are read from the model");
    });
  });

  it("a door and a window that are panels of a curtain wall give nulls and do not fail a read", async () => {
    await withClient(async (client) => {
      const w = ready();
      const curtain = (await listTypes(client, "walls")).find((row) => row.family === "Curtain Wall");
      assert.ok(curtain, "a curtain wall type in the template");

      // place_hosted refuses a curtain wall, so the way to such a door is the one a person takes: the panel of the wall is given the type of a door. get_elements has no category
      // word for panels, but a curtain wall of one cell makes its panel right after itself, so the panel is found by its id and read by it.
      for (const [family, category] of [[CURTAIN_DOOR, "doors"], [CURTAIN_WINDOW, "windows"]] as const) {
        const x = scene();
        const type = only(landed(await call<FamilyActual>(client, "load_family", [{ path: family }]), "created", "some")).actual.typeIds[0];
        assert.ok(type, family);
        const wall: Landed<WallActual> = only(landed(await call<WallActual>(client, "create_walls", [{ startMm: { x, y: 0 }, endMm: { x: x + 2000, y: 0 }, typeId: curtain.id, levelId: w.ground.id, heightMm: 2600 }]), "created"));

        const near = await elementsOf(client, { ids: Array.from({ length: 8 }, (_, index) => String(Number(wall.elementId) + index + 1)) });
        const panel = near.elements.find((row) => row.category === "OST_CurtainWallPanels" && row.typeName !== null);
        assert.ok(panel, `the panel of the curtain wall: ${JSON.stringify(near.elements.map((row) => [row.id, row.category, row.typeName]))}`);
        assert.ok(!("hostId" in panel), "a glass panel is no door or window, and it carries none of the keys");

        const swapped = only(landed(await call<unknown>(client, "update_elements", [{ id: panel.id, typeId: type.id }]), "updated"));
        assert.equal(swapped.elementId, panel.id, "the panel keeps its id");

        const row = await rowOf(client, panel.id);
        console.log(`# panel of ${category}: ${JSON.stringify(row)}`);
        assert.equal(row.category, category, "the panel is an element of that category now");
        assert.equal(row.hostId, wall.elementId, "its host is the curtain wall");
        assert.equal(row.offsetAlongWallMm, null, "a panel does not sit in the axis of its wall, so it has no offset");
        assert.equal(row.cutsWall, false, "a panel is no insert of its wall");
        for (const key of OPENING_KEYS) {
          assert.ok(key in row, `${key} is there, null or not: ${JSON.stringify(row)}`);
        }

        // Listed with the others of its category, it does not fail them, and it reads the same.
        assert.deepEqual((await elementsOf(client, { category })).elements.find((element) => element.id === panel.id), row);
      }
    });
  });

  it("a floor reads the area of its outline, with what walls stand on counted, and a room inside reads net of them", async () => {
    await withClient(async (client) => {
      const w = ready();
      const x = scene();
      const { thicknessMm } = await boxOfWalls(client, x);

      // The floor runs along the axes of the walls, so half of each wall stands on it, and the partition stands on the middle of it. A room comes last, so it reads the partition.
      const floor = only(landed(await call<{ areaM2: number }>(client, "create_floors", [{ boundaryMm: rectangle(x, 0, x + BOX_WIDTH_MM, BOX_DEPTH_MM), typeId: w.floorType.id, levelId: w.ground.id }]), "created"));
      const gross = (BOX_WIDTH_MM * BOX_DEPTH_MM) / 1_000_000;
      assertNear(await areaOf(client, floor.elementId, "floors"), gross, "the floor before anything more stands on it", NEAR_M2);

      await makeWalls(client, [[{ x: x + 5000, y: 0 }, { x: x + 5000, y: BOX_DEPTH_MM }]]);
      const area = await areaOf(client, floor.elementId, "floors");
      console.log(`# floor under walls: ${area} m2, the outline is ${gross} m2`);
      assertNear(area, gross, "the walls that stand on the floor take nothing off it", NEAR_M2);

      const [left, right] = await rooms(client, [
        { levelId: w.ground.id, pointMm: { x: x + 2500, y: 3000 }, name: "Левая", number: "10" },
        { levelId: w.ground.id, pointMm: { x: x + 7500, y: 3000 }, name: "Правая", number: "11" },
      ]);
      assert.ok(left && right);
      const net = (((BOX_WIDTH_MM - 2 * thicknessMm) * (BOX_DEPTH_MM - thicknessMm)) / 1_000_000);
      console.log(`# the rooms on that floor: ${left.actual.areaM2} + ${right.actual.areaM2} m2, net of the walls ${net} m2, for walls ${thicknessMm} mm thick`);
      assertNear(left.actual.areaM2 + right.actual.areaM2, net, "the rooms on it are net of the walls", NEAR_M2);
      assert.ok(area - (left.actual.areaM2 + right.actual.areaM2) > 1, "so the floor reads more than its rooms by what the walls take");
    });
  });

  it("a floor crossed by walls that go down past it reads the same area", async () => {
    await withClient(async (client) => {
      const w = ready();
      const x = scene();

      // As in the house: walls with a foot 400 below the level, and a floor 300 thick drawn along their axes, so half of each wall passes through the edge of the floor.
      await boxOfWalls(client, x, BOX_WIDTH_MM, BOX_DEPTH_MM, { baseOffsetMm: -400 });
      const floor = only(landed(await call<unknown>(client, "create_floors", [{ boundaryMm: rectangle(x, 0, x + BOX_WIDTH_MM, BOX_DEPTH_MM), typeId: w.floorType.id, levelId: w.ground.id }]), "created"));

      const area = await areaOf(client, floor.elementId, "floors");
      console.log(`# floor crossed by walls: ${area} m2`);
      assertNear(area, (BOX_WIDTH_MM * BOX_DEPTH_MM) / 1_000_000, "the walls take nothing off it", NEAR_M2);
    });
  });

  it("a floor with an opening reads net of the hole", async () => {
    await withClient(async (client) => {
      const w = ready();
      const x = scene();
      const floor = only(landed(await call<unknown>(client, "create_floors", [{ boundaryMm: rectangle(x, 0, x + 8000, 5000), typeId: w.floorType.id, levelId: w.ground.id }]), "created"));
      assertNear(await areaOf(client, floor.elementId, "floors"), 40, "8 x 5", NEAR_M2);

      landed(await call<unknown>(client, "create_floor_openings", [{ floorId: floor.elementId, boundaryMm: rectangle(x + 1000, 1000, x + 3500, 3000) }]), "created");

      const area = await areaOf(client, floor.elementId, "floors");
      console.log(`# floor of 40 m2 with a hole of 5 m2: ${area} m2`);
      assertNear(area, 35, "40 less the hole of 2.5 x 2", NEAR_M2);
    });
  });

  it("a ceiling reads the area of its outline", async () => {
    await withClient(async (client) => {
      const w = ready();
      const x = scene();
      const ceiling = only(landed(await call<unknown>(client, "create_ceilings", [{ boundaryMm: rectangle(x, 0, x + 6400, 4500), typeId: w.ceilingType.id, levelId: w.ground.id, heightOffsetMm: 2600 }]), "created"));

      const area = await areaOf(client, ceiling.elementId, "ceilings");
      console.log(`# ceiling of 6.4 x 4.5: ${area} m2`);
      assertNear(area, 28.8, "6.4 x 4.5", NEAR_M2);
    });
  });

  it("a roof reads its area along the slope", async () => {
    await withClient(async (client) => {
      for (const [widthMm, depthMm, slopeDeg, overhangMm] of [
        [10000, 6000, 30, 0],
        [10000, 6000, 45, 0],
        [8000, 7000, 30, 600],
      ] as const) {
        const footprint = ((widthMm + 2 * overhangMm) * (depthMm + 2 * overhangMm)) / 1_000_000;
        const along = footprint / Math.cos(degrees(slopeDeg));
        const area = await gableAreaM2(client, widthMm, depthMm, slopeDeg, overhangMm);
        console.log(`# gable ${widthMm} x ${depthMm} at ${slopeDeg} degrees, overhang ${overhangMm}: ${area} m2, footprint ${footprint}, along the slope ${along}`);
        assertNear(area, along, `gable at ${slopeDeg} degrees`, NEAR_M2);
      }
    });
  });

  it("a toposolid has no areaM2", async () => {
    await withClient(async (client) => {
      const w = ready();
      const x = scene();
      const land = only(landed(await call<unknown>(client, "create_ground", [{ boundaryMm: rectangle(x, 0, x + 9000, 9000), levelId: w.ground.id, topOffsetMm: -400, typeId: w.landType.id }]), "created"));

      const row = await rowOf(client, land.elementId);
      assert.equal(row.category, "toposolid");
      assert.ok(!("areaM2" in row), `the ground is out of scope: ${JSON.stringify(row)}`);
    });
  });

  it("reading changes nothing in the model", async () => {
    await withClient(async (client) => {
      await client.call("save_project", {});
      const before = await modelInfo(client);
      const lastUndo = (await client.call("get_last_undo_result", {})) as LastUndo;
      assert.equal(before.activeDocument?.isModified, false);

      for (const category of ["doors", "windows", "floors", "ceilings", "roofs", "toposolid", "rooms", "walls"]) {
        await elementsOf(client, { category });
      }

      const after = await modelInfo(client);
      assert.deepEqual(after.categoryCounts, before.categoryCounts, "no element came or went");
      assert.equal(after.activeDocument?.isModified, false, "the project stays as saved");
      assert.deepEqual(await client.call("get_last_undo_result", {}), lastUndo, "and nothing joined the history of undo");
    });
  });

  it("leaves the project saved, in a state the close rule accepts", async () => {
    await withClient(async (client) => {
      await client.call("save_project", {});
      const info = await modelInfo(client);

      assert.equal(info.activeDocument?.isModified, false);
      assert.deepEqual(checkCanClose(info.openDocuments), { ok: true, reasons: [] });
    });
  });
});
