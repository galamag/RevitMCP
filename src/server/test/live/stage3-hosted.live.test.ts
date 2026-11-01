import assert from "node:assert/strict";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { checkCanClose } from "../../src/cli/closeRule.ts";
import { BridgeClient } from "../../src/client.ts";
import { defaultConnectionPath } from "../../src/connection.ts";
import { BridgeRpcError } from "../../src/errors.ts";
import { decodePng, meanColour, type Pixels, type Region } from "../pngPixels.ts";
import { undoWithOneRetry } from "../undoRetry.ts";

// These tests need a running Revit with the RevitMCP plugin loaded. Each run creates one new project in the test folder and
// leaves it open and saved. They place real doors and windows from the library of this machine in walls. What a tool says is
// checked against the model, read another way (the box of the element), and the cut is checked on a picture: a snapshot of a dark
// wall with a bright wall behind it, where the pixels say whether the window lets light through and the door shows its leaf.
// The PNGs are kept in the test folder too, for a person or a model to look at. Scenes stand far apart, so no wall of one touches another.

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

interface Box {
  min: { x: number; y: number; z: number };
  max: { x: number; y: number; z: number };
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

interface HostedActual {
  hostId: string | null;
  offsetAlongWallMm: number;
  sillHeightMm: number | null;
  facingFlipped: boolean;
  handFlipped: boolean;
  fromRoomId: string | null;
  toRoomId: string | null;
  cutsWall: boolean;
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

interface Placed {
  typeId: string;
  wallId: string;
  offsetAlongWallMm: number;
  sillHeightMm?: number;
  flipFacing?: boolean;
  flipHand?: boolean;
}

const INVALID_PARAMS = -32602;
const NEAR_MM = 0.01;
/** A written size reads back as the same number, within the noise of feet. */
const SIZE_NEAR_MM = 0.01;
const WALL_LENGTH_MM = 6000;
const WALL_HEIGHT_MM = 3000;
const SCENE_PITCH_MM = 20000;
/** The scene of the picture stands far from the others, so nothing of theirs is behind it. */
const PICTURE_SCENE_Y_MM = 500000;
const SNAPSHOT_WIDTH_PX = 1200;

/** The library of this machine, the same folder as LibraryFolder.Root in the plugin. */
const DOOR = "Russia\\Двери\\Дверь-Одинарная-Панель.rfa";
const WINDOW = "Russia\\Окна\\Окно-закрепленное.rfa";
const BED = "Russia\\Мебель\\Кровати\\Кровать-Стандарт.rfa";
/** A door that is a bare opening: its type says no width and no height that Revit names as such. */
const DOOR_OPENING = "Russia\\Двери\\Дверь-Проем.rfa";
/** A window that is a bare opening: its type says no width and no height either. */
const WINDOW_OPENING = "Russia\\Окна\\Окно-Квадратный проем.rfa";
/** A family of the library whose types are no doors or windows, though it lies in the folder of windows. */
const OTHER_OPENING = "Russia\\Окна\\Экземпляр - Проем.rfa";

const stamp = new Date().toTimeString().slice(0, 8).replaceAll(":", "");
const name = `проверка-этап3-двери-окна-${stamp}`;
const snapshotFolder = path.join(homedir(), "Documents", "RevitMCP", "task7-hosted");

/** What the tests share: the levels, the wall type, and the door and window types that most tests place. */
interface World {
  ground: Level;
  upper: Level;
  wallType: TypeRow;
  /** The door 800 wide and 2100 high, and the window 600 wide and 1200 high. */
  door: TypeActual;
  window: TypeActual;
  /** A window 600 wide and 600 high, which fits above a door in a wall of 3000. */
  lowWindow: TypeActual;
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

const loadFamily = (client: BridgeClient, items: unknown[]): Promise<Batch<FamilyActual>> => client.call("load_family", { items }) as Promise<Batch<FamilyActual>>;

const place = (client: BridgeClient, items: Placed[]): Promise<Batch<HostedActual>> => client.call("place_hosted", { items }) as Promise<Batch<HostedActual>>;

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

function assertLanded<A>(batch: Batch<A>): void {
  assert.equal(batch.committed, true, JSON.stringify(batch).slice(0, 1500));
  assert.deepEqual(batch.errors, []);
  assert.deepEqual(batch.dialogs, []);

  // A placement must land with nothing for Revit to warn about, openings that touch included. A load of a catalog family warns by design.
  if (batch.items.some((item) => item.actual !== null && typeof item.actual === "object" && "cutsWall" in item.actual)) {
    assert.deepEqual(batch.warnings, [], "nothing here should give Revit something to warn about");
  }
}

/** Everything landed with the status asked for, and the items are returned. */
function landed<A>(batch: Batch<A>, status: string): Array<Item<A> & { elementId: string; actual: A }> {
  assertLanded(batch);

  return batch.items.map((item) => {
    assert.equal(item.status, status, JSON.stringify(item));
    assert.ok(item.elementId && item.actual, JSON.stringify(item));
    assert.deepEqual(item.warnings, [], JSON.stringify(item));
    return item as Item<A> & { elementId: string; actual: A };
  });
}

function assertNear(actual: unknown, expected: number, what: string, within = NEAR_MM): void {
  assert.equal(typeof actual, "number", what);
  assert.ok(Math.abs((actual as number) - expected) < within, `${what}: ${String(actual)}, expected ${expected}`);
}

const countOf = (info: ModelInfo, category: string): number => info.categoryCounts.find((entry) => entry.category === category)?.count ?? 0;

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

/** The doors and windows of the model, to compare before and after a call that must change nothing. */
async function openingsOf(client: BridgeClient): Promise<{ doors: number; windows: number }> {
  const info = await modelInfo(client);

  return { doors: countOf(info, "OST_Doors"), windows: countOf(info, "OST_Windows") };
}

/** A call that must be refused and leave the model as it was: the same doors and windows, and nothing unsaved. */
async function refusedAndUnchanged(client: BridgeClient, items: Placed[], pattern: RegExp, what: string): Promise<BridgeRpcError> {
  await saved(client);
  const before = await openingsOf(client);

  const refused = await refusal(client, "place_hosted", { items });
  assert.match(refused.message, pattern, `${what}: ${refused.message}`);
  assert.match(refused.message, /place_hosted item \d+/, `${what}: the refusal should name the item`);

  assert.deepEqual(await openingsOf(client), before, `${what}: a refused call places nothing`);
  assert.equal(await isModified(client), false, `${what}: a refused call changes nothing`);
  return refused;
}

/** A straight wall on a level, as the model has it. */
async function makeWall(
  client: BridgeClient,
  from: { x: number; y: number },
  to: { x: number; y: number },
  extra: { level?: Level; heightMm?: number; baseOffsetMm?: number; typeId?: string } = {},
): Promise<string> {
  const w = ready();
  const batch = (await client.call("create_walls", {
    items: [
      {
        startMm: from,
        endMm: to,
        typeId: extra.typeId ?? w.wallType.id,
        levelId: (extra.level ?? w.ground).id,
        heightMm: extra.heightMm ?? WALL_HEIGHT_MM,
        ...(extra.baseOffsetMm === undefined ? {} : { baseOffsetMm: extra.baseOffsetMm }),
      },
    ],
  })) as Batch<unknown>;
  const [wall] = landed(batch, "created");
  assert.ok(wall);

  return wall.elementId;
}

/** The wall along +X from x 0 to 6000, in a scene of its own. */
async function wallAlongX(client: BridgeClient, extra: Parameters<typeof makeWall>[3] = {}): Promise<{ id: string; y: number }> {
  const y = scene();

  return { id: await makeWall(client, { x: 0, y }, { x: WALL_LENGTH_MM, y }, extra), y };
}

/** One row of a family loaded with the sizes given, and the type it makes. */
async function loadRow(client: BridgeClient, family: string, typeName: string, widthMm: number, heightMm: number): Promise<TypeActual> {
  const [loaded] = landed(await loadFamily(client, [{ path: family, typeName, widthMm, heightMm }]), "created");
  assert.ok(loaded);
  const type = loaded.actual.typeIds.find((row) => row.name === typeName);
  assert.ok(type, `no type '${typeName}' in ${JSON.stringify(loaded.actual.typeIds)}`);
  assertNear(type.widthMm, widthMm, `${typeName}: width`, SIZE_NEAR_MM);
  assertNear(type.heightMm, heightMm, `${typeName}: height`, SIZE_NEAR_MM);

  return type;
}

/** The box of an element in the model. */
async function boxOf(client: BridgeClient, id: string): Promise<Box> {
  const [row] = (await elementsOf(client, [id])).elements;
  assert.ok(row?.boundingBoxMm, `element ${id} has a box`);

  return row.boundingBoxMm;
}

const centreOf = (box: Box): { x: number; y: number; z: number } => ({
  x: (box.min.x + box.max.x) / 2,
  y: (box.min.y + box.max.y) / 2,
  z: (box.min.z + box.max.z) / 2,
});

/** Looks at a scene from a point and keeps the picture. */
async function snapshot(client: BridgeClient, title: string, eyeMm: { x: number; y: number; z: number }, targetMm: { x: number; y: number; z: number }): Promise<Pixels> {
  const view = (await client.call("create_3d_view", {
    name: `${title} ${stamp}`,
    kind: "perspective",
    displayStyle: "realistic",
    eyeMm,
    targetMm,
  })) as { committed: boolean; viewId: string; displayStyle: string };
  assert.equal(view.committed, true, JSON.stringify(view));
  assert.equal(view.displayStyle, "realistic");

  const shot = (await client.call("get_view_snapshot", { viewId: view.viewId, widthPx: SNAPSHOT_WIDTH_PX })) as { path: string; dialogs: unknown[] };
  assert.deepEqual(shot.dialogs, []);

  await mkdir(snapshotFolder, { recursive: true });
  const kept = path.join(snapshotFolder, `${title}-${stamp}.png`);
  await copyFile(shot.path, kept);
  console.log(`# snapshot: ${kept}`);

  return decodePng(await readFile(kept));
}

type Colour = readonly [number, number, number];

/** A box of pixels, edges included. */
interface PixelRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  count: number;
}

function colourAt(pixels: Pixels, x: number, y: number): Colour {
  const at = (y * pixels.width + x) * pixels.channels;

  return [pixels.data[at]!, pixels.data[at + 1]!, pixels.data[at + 2]!];
}

const distance = (a: Colour, b: Colour): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

const luminance = (colour: Colour): number => 0.299 * colour[0] + 0.587 * colour[1] + 0.114 * colour[2];

/** The smallest box that holds every pixel of a part of the picture that passes the test, or null. */
function boundsWhere(pixels: Pixels, within: { left: number; top: number; right: number; bottom: number }, test: (colour: Colour) => boolean): PixelRect | null {
  let found: PixelRect | null = null;

  for (let y = within.top; y <= within.bottom; y++) {
    for (let x = within.left; x <= within.right; x++) {
      if (test(colourAt(pixels, x, y))) {
        found = found
          ? { left: Math.min(found.left, x), top: Math.min(found.top, y), right: Math.max(found.right, x), bottom: Math.max(found.bottom, y), count: found.count + 1 }
          : { left: x, top: y, right: x, bottom: y, count: 1 };
      }
    }
  }

  return found;
}

describe("stage 3 live checks: doors and windows in walls", { timeout: 900_000 }, () => {
  it("creates a project for this run, with the types it needs", async () => {
    await withClient(async (client) => {
      await client.call("create_project", { name });

      const info = await modelInfo(client);
      assert.equal(info.activeDocument?.title, name);
      const ground = info.levels.find((level) => level.elevationMm === 0);
      assert.ok(ground, `no level at the origin in ${JSON.stringify(info.levels)}`);
      const upper = info.levels.find((level) => level.elevationMm > 0);
      assert.ok(upper, `no upper level in ${JSON.stringify(info.levels)}`);

      const walls = await listTypes(client, "walls");
      const wallType = walls.find((row) => /^Наружный - Стена из бруса толщиной 180 мм/.test(row.name));
      assert.ok(wallType, `no wall type to build with in ${JSON.stringify(walls.map((row) => row.name))}`);

      // The sizes are given: a catalog row that is loaded as it is has the size of its family, not the one its name says.
      const door = await loadRow(client, DOOR, "800 x 2100 мм", 800, 2100);
      const window = await loadRow(client, WINDOW, "600 x 1200 мм", 600, 1200);
      const lowWindow = await loadRow(client, WINDOW, "600 x 1050 мм", 600, 600);

      world = { ground, upper, wallType, door, window, lowWindow };
      console.log(`# world: ${JSON.stringify(world)}`);
    });
  });

  it("window has the requested offset and sill", async () => {
    await withClient(async (client) => {
      const w = ready();
      const { id: wallId, y } = await wallAlongX(client);

      // Four windows at offsets and sills that nothing suggests, with decimals in the first, each read back from the model after the commit.
      const asked: Placed[] = [
        { typeId: w.window.id, wallId, offsetAlongWallMm: 700.5, sillHeightMm: 600.5 },
        { typeId: w.window.id, wallId, offsetAlongWallMm: 2000, sillHeightMm: 900 },
        { typeId: w.window.id, wallId, offsetAlongWallMm: 3300, sillHeightMm: 1100 },
        { typeId: w.window.id, wallId, offsetAlongWallMm: 4600, sillHeightMm: 1500 },
      ];
      const windows = landed(await place(client, asked), "created");
      assert.equal(windows.length, asked.length);

      const read = await elementsOf(client, windows.map((window) => window.elementId));
      assert.deepEqual(read.notFound, []);

      for (const [index, request] of asked.entries()) {
        const window = windows[index]!;
        const { actual } = window;
        const what = `window ${index}`;
        console.log(`# ${what}: ${JSON.stringify(actual)}`);

        assert.deepEqual(window.requested, request, `${what}: the request comes back as it was sent`);
        assert.equal(actual.hostId, wallId, what);
        assertNear(actual.offsetAlongWallMm, request.offsetAlongWallMm, `${what}: offset`, SIZE_NEAR_MM);
        assertNear(actual.sillHeightMm, request.sillHeightMm!, `${what}: sill`, SIZE_NEAR_MM);
        assert.equal(actual.facingFlipped, false, what);
        assert.equal(actual.handFlipped, false, what);
        assert.equal(actual.cutsWall, true, `${what}: the wall must list the window among its inserts`);
        // No rooms exist, and the keys are there all the same: null is the answer, not a missing key.
        assert.equal(actual.fromRoomId, null, what);
        assert.equal(actual.toRoomId, null, what);
        assert.ok("fromRoomId" in actual && "toRoomId" in actual);

        // The same from another side: the element is a window in the model, on the ground level, and its box is centred on the offset.
        const row = read.elements.find((element) => element.id === window.elementId);
        assert.ok(row, `${what}: get_elements has it`);
        assert.equal(row.category, "windows");
        assert.equal(row.levelId, w.ground.id);
        assert.equal(row.typeName, w.window.name);
        const box = row.boundingBoxMm;
        assert.ok(box, `${what}: box`);
        assertNear(centreOf(box).x, request.offsetAlongWallMm, `${what}: the middle of the box along the wall`, 1);
        // Measured: the trim and the sill reach out of the opening, by 80 mm up and down and some 300 mm across, to the side the window faces.
        assert.ok(Math.abs(box.min.y - y) < 400 && Math.abs(box.max.y - y) < 400, `${what}: the box lies on the axis of the wall, not off it: ${JSON.stringify(box)}`);
        assert.ok(Math.abs(box.min.z - request.sillHeightMm!) < 120, `${what}: the box starts at ${box.min.z}, the sill is ${request.sillHeightMm}`);
        assert.ok(Math.abs(box.max.z - box.min.z - w.window.heightMm!) < 250, `${what}: the box is ${box.max.z - box.min.z} high, the type is ${w.window.heightMm}`);
      }

      // The sill is what was asked for, not what the family keeps: the same type at two sills reads two different ones.
      assert.notEqual(windows[1]!.actual.sillHeightMm, windows[2]!.actual.sillHeightMm);
    });
  });

  it("door cuts the wall", async () => {
    await withClient(async (client) => {
      const w = ready();
      const { id: wallId } = await wallAlongX(client);
      const before = await openingsOf(client);

      // A door with no sill height stands on the level, and one with a sill height of its own stands on it. The family's sill is not used.
      const doors = landed(
        await place(client, [
          { typeId: w.door.id, wallId, offsetAlongWallMm: 1500 },
          { typeId: w.door.id, wallId, offsetAlongWallMm: 4000, sillHeightMm: 150 },
        ]),
        "created",
      );
      for (const door of doors) {
        console.log(`# door: ${JSON.stringify(door.actual)}`);
        assert.equal(door.actual.hostId, wallId);
        assert.equal(door.actual.cutsWall, true, "the wall must list the door among its inserts");
      }
      assertNear(doors[0]!.actual.offsetAlongWallMm, 1500, "first door offset", SIZE_NEAR_MM);
      assertNear(doors[0]!.actual.sillHeightMm, 0, "a door with no sillHeightMm takes 0", SIZE_NEAR_MM);
      assertNear(doors[1]!.actual.sillHeightMm, 150, "a door with a sill height keeps it", SIZE_NEAR_MM);

      assert.deepEqual(await openingsOf(client), { doors: before.doors + 2, windows: before.windows });
      const read = await elementsOf(client, doors.map((door) => door.elementId));
      for (const row of read.elements) {
        assert.equal(row.category, "doors");
        assert.equal(row.typeName, w.door.name);
      }
      // The door that stands 150 above the level is 150 higher than the one that stands on it.
      const heights = await Promise.all(doors.map(async (door) => (await boxOf(client, door.elementId)).max.z));
      assertNear(heights[1]! - heights[0]!, 150, "the raised door stands higher by its sill", 1);
    });
  });

  it("first instance of a new type cuts the wall", async (t) => {
    await withClient(async (client) => {
      const w = ready();
      const y = PICTURE_SCENE_Y_MM;

      // Two rows that nothing has placed yet, so their symbols are not active: the first instance of each is the case that does not cut
      // unless the document is regenerated after the activation. The dark wall is the one thing in the picture that is dark.
      const door = await loadRow(client, DOOR, "900 x 2100 мм", 900, 2100);
      const window = await loadRow(client, WINDOW, "900 x 1200 мм", 900, 1200);

      const [dark] = landed((await client.call("create_materials", { items: [{ name: `Тёмная-стена ${stamp}`, colorRgb: { r: 20, g: 20, b: 20 } }] })) as Batch<unknown>, "created");
      const [light] = landed((await client.call("create_materials", { items: [{ name: `Светлая-стена ${stamp}`, colorRgb: { r: 255, g: 255, b: 255 } }] })) as Batch<unknown>, "created");
      assert.ok(dark && light);
      const [darkType, lightType] = landed(
        (await client.call("create_type", {
          items: [
            { category: "walls", baseTypeId: w.wallType.id, name: `Стена тёмная ${stamp}`, layers: [{ thicknessMm: 200, materialId: dark.elementId, function: "structure" }] },
            { category: "walls", baseTypeId: w.wallType.id, name: `Стена светлая ${stamp}`, layers: [{ thicknessMm: 200, materialId: light.elementId, function: "structure" }] },
          ],
        })) as Batch<unknown>,
        "created",
      );
      assert.ok(darkType && lightType);

      // The dark wall, and a white wall 4 m behind it that is higher and wider, so the light that comes through an opening is white.
      const wallId = await makeWall(client, { x: 0, y }, { x: WALL_LENGTH_MM, y }, { typeId: darkType.elementId });
      await makeWall(client, { x: -3000, y: y + 4000 }, { x: 9000, y: y + 4000 }, { typeId: lightType.elementId, heightMm: 6000 });

      const windowAt = 1500;
      const doorAt = 4000;
      const [placedWindow, placedDoor] = landed(
        await place(client, [
          { typeId: window.id, wallId, offsetAlongWallMm: windowAt, sillHeightMm: 900 },
          { typeId: door.id, wallId, offsetAlongWallMm: doorAt },
        ]),
        "created",
      );
      assert.ok(placedWindow && placedDoor);
      assert.equal(placedWindow.actual.cutsWall, true, "the first window of its type cuts the wall");
      assert.equal(placedDoor.actual.cutsWall, true, "the first door of its type cuts the wall");

      // The camera stands 10 m south of the wall and looks at the middle of it, level, so the wall is a flat rectangle in the picture.
      const pixels = await snapshot(client, "проёмы-вид-снаружи", { x: 3000, y: y - 10000, z: 1500 }, { x: 3000, y, z: 1500 });
      const centre = colourAt(pixels, Math.floor(pixels.width / 2), Math.floor(pixels.height / 2));
      const wallColour = centre;
      assert.ok(luminance(wallColour) < 90, `the middle of the picture is the dark wall between the openings, and it is ${JSON.stringify(wallColour)}`);

      const wall = boundsWhere(pixels, { left: 0, top: 0, right: pixels.width - 1, bottom: pixels.height - 1 }, (colour) => distance(colour, wallColour) <= 12);
      assert.ok(wall && wall.count > 50000, `the dark wall is the one big dark thing in the picture: ${JSON.stringify(wall)}`);
      const perMmX = (wall.right - wall.left + 1) / WALL_LENGTH_MM;
      const perMmY = (wall.bottom - wall.top + 1) / WALL_HEIGHT_MM;
      assertNear(perMmX / perMmY, 1, "the wall is seen square on, so a millimetre is as long across as it is up", 0.02);
      console.log(`# the wall in the picture: ${JSON.stringify(wall)}, ${perMmX.toFixed(4)} pixels a millimetre`);

      const regionOf = (fromX: number, toX: number, fromZ: number, toZ: number): Region => ({
        left: (wall.left + fromX * perMmX) / pixels.width,
        right: (wall.left + toX * perMmX) / pixels.width,
        top: (wall.bottom + 1 - toZ * perMmY) / pixels.height,
        bottom: (wall.bottom + 1 - fromZ * perMmY) / pixels.height,
      });
      const worldX = (pixel: number): number => (pixel - wall.left) / perMmX;
      const worldZ = (pixel: number): number => (wall.bottom + 1 - pixel) / perMmY;
      const mean = (region: Region): Colour => {
        const { r, g, b } = meanColour(pixels, region);
        return [r, g, b];
      };

      // The wall between and beside the openings is the colour of the wall everywhere: this is what the other regions are measured against.
      for (const [what, region] of [
        ["between the openings", regionOf(2200, 3000, 300, 2500)],
        ["right of the door", regionOf(4800, 5800, 300, 2500)],
        ["above the openings", regionOf(300, 5700, 2300, 2800)],
      ] as const) {
        const colour = mean(region);
        console.log(`# wall ${what}: ${JSON.stringify(colour.map(Math.round))}`);
        assert.ok(distance(colour, wallColour) < 10, `wall ${what} should be the colour of the wall: ${JSON.stringify(colour)}`);
      }

      // The window lets the white wall behind it show through its glass, so its middle is much lighter than the dark wall.
      const glass = mean(regionOf(windowAt - 200, windowAt + 200, 1100, 1900));
      console.log(`# glass of the window: ${JSON.stringify(glass.map(Math.round))}`);
      assert.ok(luminance(glass) > 200, `light comes through the window: ${JSON.stringify(glass)}`);
      assert.ok(luminance(glass) - luminance(wallColour) > 120, "and the window is far lighter than the wall");

      // Where the light is, along the wall and up it, is where the window was asked for.
      // The light of the window is looked for on its side of the wall only, as the leaf of the door is light too.
      const bright = boundsWhere(pixels, { left: wall.left, top: wall.top, right: Math.floor(wall.left + 3000 * perMmX), bottom: wall.bottom }, (colour) => luminance(colour) > 200);
      assert.ok(bright && bright.count > 1000, `the light of the window: ${JSON.stringify(bright)}`);
      assertNear(worldX((bright.left + bright.right + 1) / 2), windowAt, "the light of the window, along the wall", 60);
      assertNear(worldZ((bright.top + bright.bottom + 1) / 2), 900 + window.heightMm! / 2, "the light of the window, up the wall", 60);

      // The door stands in its opening, and its leaf shows: something that is not the wall, to the right of the window, from the floor up to the head.
      // The search stays off the edges of the wall, where its pixels blend with the white wall behind it and are not the wall colour either.
      const leaf = boundsWhere(
        pixels,
        { left: Math.floor(wall.left + 2600 * perMmX), top: Math.ceil(wall.bottom - 2800 * perMmY), right: Math.floor(wall.left + 5400 * perMmX), bottom: wall.bottom },
        (colour) => distance(colour, wallColour) > 60,
      );
      assert.ok(leaf && leaf.count > 1000, `the leaf of the door: ${JSON.stringify(leaf)}`);
      console.log(`# the door in the picture: ${JSON.stringify(leaf)}`);
      assertNear(worldX((leaf.left + leaf.right + 1) / 2), doorAt, "the door, along the wall", 60);
      assertNear(worldZ(leaf.top), door.heightMm!, "the head of the door", 60);
      assertNear(worldZ(leaf.bottom + 1), 0, "the foot of the door", 60);
      const leafColour = mean(regionOf(doorAt - 250, doorAt + 250, 300, 1800));
      assert.ok(distance(leafColour, wallColour) > 80, `the leaf of the door is not the wall: ${JSON.stringify(leafColour)}`);

      t.diagnostic(`window light ${JSON.stringify(glass.map(Math.round))}, wall ${JSON.stringify(wallColour)}, door ${JSON.stringify(leafColour.map(Math.round))}`);
    });
  });

  it("offset past the wall end fails before any change", async () => {
    await withClient(async (client) => {
      const w = ready();
      const { id: wallId } = await wallAlongX(client);
      const good: Placed = { typeId: w.door.id, wallId, offsetAlongWallMm: 1500 };

      // The door is 800 wide, so its centre at 5800 puts its end at 6200, 200 past the end of a wall of 6000. Half past the end is the
      // case that Revit takes with no warning, so it is the one that matters: a centre inside the wall is not enough.
      const past = await refusedAndUnchanged(client, [good, { typeId: w.door.id, wallId, offsetAlongWallMm: 5800 }], /5400 mm to 6200 mm along/, "the end of the wall");
      assert.match(past.message, /place_hosted item 1/, "the good item is item 0 and the bad one is item 1");
      assert.match(past.message, /6000 mm long/, "the message says how long the wall is");
      assert.match(past.message, /from \(0, \d+\) mm to \(6000, \d+\) mm/, "and where it runs");

      // The start of the wall: a centre of 300 puts the door 100 before it. And a centre outside the wall altogether, on either side.
      await refusedAndUnchanged(client, [{ typeId: w.door.id, wallId, offsetAlongWallMm: 300 }], /-100 mm to 700 mm along/, "the start of the wall");
      await refusedAndUnchanged(client, [{ typeId: w.door.id, wallId, offsetAlongWallMm: 7000 }], /6600 mm to 7400 mm along/, "far past the end");
      await refusedAndUnchanged(client, [{ typeId: w.window.id, wallId, offsetAlongWallMm: -500, sillHeightMm: 900 }], /-800 mm to -200 mm along/, "before the start");

      // 1 mm past the end is past it too.
      await refusedAndUnchanged(client, [{ typeId: w.door.id, wallId, offsetAlongWallMm: 5601 }], /5201 mm to 6001 mm along/, "1 mm past the end");
    });
  });

  it("opening above the wall top fails before any change", async () => {
    await withClient(async (client) => {
      const w = ready();
      const { id: wallId } = await wallAlongX(client);

      // The window is 1200 high: from a sill of 2500 its head is at 3700, 700 above a wall of 3000.
      const above = await refusedAndUnchanged(
        client,
        [{ typeId: w.door.id, wallId, offsetAlongWallMm: 1000 }, { typeId: w.window.id, wallId, offsetAlongWallMm: 3000, sillHeightMm: 2500 }],
        /2500 mm to 3700 mm above level/,
        "the head of the window",
      );
      assert.match(above.message, /place_hosted item 1/);
      assert.match(above.message, /reaches only 3000 mm above that level/, "the message says how high the wall is");
      assert.match(above.message, /700 mm above the top of the wall/);

      // 1 mm over is over, and a door taller than the whole wall is too.
      await refusedAndUnchanged(client, [{ typeId: w.window.id, wallId, offsetAlongWallMm: 3000, sillHeightMm: 1801 }], /1801 mm to 3001 mm above level/, "1 mm over the top");
      const yLow = scene();
      const low = await makeWall(client, { x: 0, y: yLow }, { x: WALL_LENGTH_MM, y: yLow }, { heightMm: 2000 });
      await refusedAndUnchanged(client, [{ typeId: w.door.id, wallId: low, offsetAlongWallMm: 3000 }], /0 mm to 2100 mm above level/, "a door taller than the wall");

      // Exactly to the top is inside: a window whose head is the top of the wall lands, and it lands whole.
      const [flush] = landed(await place(client, [{ typeId: w.window.id, wallId, offsetAlongWallMm: 3000, sillHeightMm: 1800 }]), "created");
      assert.ok(flush);
      assert.equal(flush.actual.cutsWall, true);
      assertNear(flush.actual.sillHeightMm, 1800, "a window flush with the top", SIZE_NEAR_MM);
    });
  });

  it("overlapping openings fail before any change", async () => {
    await withClient(async (client) => {
      const w = ready();
      const { id: wallId } = await wallAlongX(client);

      // The door stands from 1100 to 1900, 0 to 2100 high.
      const [door] = landed(await place(client, [{ typeId: w.door.id, wallId, offsetAlongWallMm: 1500 }]), "created");
      assert.ok(door);

      // A window that crosses it in both extents is refused, and the message says which element it overlaps and where that stands.
      const overlap = await refusedAndUnchanged(client, [{ typeId: w.window.id, wallId, offsetAlongWallMm: 2000, sillHeightMm: 900 }], /overlaps the door/, "a window over a door that is there");
      assert.ok(overlap.message.includes(door.elementId), `the message names the door ${door.elementId}: ${overlap.message}`);
      assert.match(overlap.message, /1100 to 1900 mm along the wall/);
      assert.match(overlap.message, /0 to 2100 mm above level/);
      // Another door on it, exactly on top of it, and one that shares 1 mm.
      await refusedAndUnchanged(client, [{ typeId: w.door.id, wallId, offsetAlongWallMm: 1500 }], /overlaps the door/, "a door exactly on a door");
      await refusedAndUnchanged(client, [{ typeId: w.door.id, wallId, offsetAlongWallMm: 2299 }], /overlaps the door/, "a door sharing 1 mm");

      // Two items of one call that cross each other: the second is refused, naming the first, and nothing of the call is placed.
      const pair = await refusedAndUnchanged(
        client,
        [
          { typeId: w.window.id, wallId, offsetAlongWallMm: 4000, sillHeightMm: 900 },
          { typeId: w.window.id, wallId, offsetAlongWallMm: 4500, sillHeightMm: 1000 },
        ],
        /overlaps item 0 of this list/,
        "two windows of one call",
      );
      assert.match(pair.message, /place_hosted item 1/);

      // What shares one extent only is no overlap. A window above the door is higher, and a window beside it is further along.
      const fine = landed(
        await place(client, [
          { typeId: w.lowWindow.id, wallId, offsetAlongWallMm: 1500, sillHeightMm: 2200 },
          { typeId: w.window.id, wallId, offsetAlongWallMm: 3000, sillHeightMm: 900 },
        ]),
        "created",
      );
      for (const item of fine) {
        assert.equal(item.actual.cutsWall, true);
      }

      // A window below the sill of another one in the same column is the other way round of the same thing.
      const [below] = landed(await place(client, [{ typeId: w.lowWindow.id, wallId, offsetAlongWallMm: 3000, sillHeightMm: 100 }]), "created");
      assert.ok(below);

      // And one that was deleted is not there to overlap any more.
      const deleted = (await client.call("delete_elements", { ids: [door.elementId], dryRun: false })) as { committed: boolean };
      assert.equal(deleted.committed, true);
      const [again] = landed(await place(client, [{ typeId: w.door.id, wallId, offsetAlongWallMm: 1500 }]), "created");
      assert.ok(again);
    });
  });

  it("exact edges: an opening ending at the wall end, and openings that touch", async () => {
    await withClient(async (client) => {
      const w = ready();
      const { id: wallId } = await wallAlongX(client);

      // A door from 0 to 800 at the start, a window from 5400 to 6000 at the end, a window from 800 to 1400 against the door, and a door
      // from 1400 to 2200 against that window: each ends where the next begins, and the first and last end where the wall does.
      const placed = landed(
        await place(client, [
          { typeId: w.door.id, wallId, offsetAlongWallMm: 400 },
          { typeId: w.window.id, wallId, offsetAlongWallMm: 1100, sillHeightMm: 900 },
          { typeId: w.door.id, wallId, offsetAlongWallMm: 1800 },
          { typeId: w.window.id, wallId, offsetAlongWallMm: 5700, sillHeightMm: 900 },
        ]),
        "created",
      );
      for (const item of placed) {
        assert.equal(item.actual.cutsWall, true, JSON.stringify(item));
        assert.equal(item.actual.hostId, wallId);
      }
      assertNear(placed[0]!.actual.offsetAlongWallMm, 400, "door at the start", SIZE_NEAR_MM);
      assertNear(placed[3]!.actual.offsetAlongWallMm, 5700, "window at the end", SIZE_NEAR_MM);

      // Touching in height is fine too: a window whose sill is the head of the door.
      const [onTop] = landed(await place(client, [{ typeId: w.lowWindow.id, wallId, offsetAlongWallMm: 1800, sillHeightMm: 2100 }]), "created");
      assert.ok(onTop);
      assert.equal(onTop.actual.cutsWall, true);

      // But one more millimetre is an overlap, and one more millimetre out is past the end.
      await refusedAndUnchanged(client, [{ typeId: w.window.id, wallId, offsetAlongWallMm: 3000, sillHeightMm: 900 }, { typeId: w.window.id, wallId, offsetAlongWallMm: 3599, sillHeightMm: 900 }], /overlaps item 0/, "windows sharing 1 mm");
      await refusedAndUnchanged(client, [{ typeId: w.lowWindow.id, wallId, offsetAlongWallMm: 1800, sillHeightMm: 2099 }], /overlaps the (door|window)/, "a window 1 mm into the head of a door");
    });
  });

  it("window without a sill height is refused", async () => {
    await withClient(async (client) => {
      const w = ready();
      const { id: wallId } = await wallAlongX(client);

      const refused = await refusedAndUnchanged(
        client,
        [{ typeId: w.door.id, wallId, offsetAlongWallMm: 1000 }, { typeId: w.window.id, wallId, offsetAlongWallMm: 3000 }],
        /is a window, so sillHeightMm is required/,
        "a window with no sill",
      );
      assert.match(refused.message, /place_hosted item 1/);
      assert.match(refused.message, /A door takes 0 when it is left out/);

      // A null is no value: the server may send one for a key that was left out, and it is the same refusal.
      const nulled = await refusal(client, "place_hosted", { items: [{ typeId: w.window.id, wallId, offsetAlongWallMm: 3000, sillHeightMm: null }] });
      assert.match(nulled.message, /sillHeightMm is required/);

      // A sill of 0 is a value: a window on the floor lands, as the family's own sill is not used.
      const [floor] = landed(await place(client, [{ typeId: w.window.id, wallId, offsetAlongWallMm: 3000, sillHeightMm: 0 }]), "created");
      assert.ok(floor);
      assertNear(floor.actual.sillHeightMm, 0, "a sill of 0", SIZE_NEAR_MM);
    });
  });

  it("flip changes facing", async () => {
    await withClient(async (client) => {
      const w = ready();
      const { id: wallId, y } = await wallAlongX(client);

      // The wall runs along +X, so what faces the left of its direction faces +y. The door swing lies on that side, and the box with it.
      const doors = landed(
        await place(client, [
          { typeId: w.door.id, wallId, offsetAlongWallMm: 1000 },
          { typeId: w.door.id, wallId, offsetAlongWallMm: 2500, flipFacing: true },
          { typeId: w.door.id, wallId, offsetAlongWallMm: 4000, flipHand: true },
          { typeId: w.door.id, wallId, offsetAlongWallMm: 5200, flipFacing: true, flipHand: true },
        ]),
        "created",
      );
      const flags = doors.map((door) => [door.actual.facingFlipped, door.actual.handFlipped]);
      assert.deepEqual(flags, [[false, false], [true, false], [false, true], [true, true]], "each flip is reported as it was asked");

      const boxes = await Promise.all(doors.map((door) => boxOf(client, door.elementId)));
      const reach = boxes.map((box) => ({ left: Math.round(box.max.y - y), right: Math.round(y - box.min.y) }));
      console.log(`# how far each door reaches to the left and to the right of the axis of the wall: ${JSON.stringify(reach)}`);

      // Not flipped: the swing is on the left (+y). Flipped: it is on the right. The hand does not change the side.
      assert.ok(reach[0]!.left - reach[0]!.right > 300, `the door that is not flipped swings to the left: ${JSON.stringify(reach[0])}`);
      assert.ok(reach[1]!.right - reach[1]!.left > 300, `the door with flipFacing swings to the right: ${JSON.stringify(reach[1])}`);
      assert.ok(reach[2]!.left - reach[2]!.right > 300, `flipHand leaves the swing on the left: ${JSON.stringify(reach[2])}`);
      assert.ok(reach[3]!.right - reach[3]!.left > 300, `both flips swing to the right: ${JSON.stringify(reach[3])}`);
      assert.ok(doors.every((door) => door.actual.cutsWall), "a flip does not undo the cut");

      // A wall that runs the other way has its left on the other side, so the same door with no flip swings to -y there.
      const yBack = scene();
      const back = await makeWall(client, { x: WALL_LENGTH_MM, y: yBack }, { x: 0, y: yBack });
      const [reversed] = landed(await place(client, [{ typeId: w.door.id, wallId: back, offsetAlongWallMm: 1500 }]), "created");
      assert.ok(reversed);
      const reversedBox = await boxOf(client, reversed.elementId);
      assert.ok(yBack - reversedBox.min.y - (reversedBox.max.y - yBack) > 300, `on a wall that runs along -X the left is -y: ${JSON.stringify(reversedBox)}`);
      assert.equal(reversed.actual.facingFlipped, false, "the facing is not flipped: the wall runs the other way");
    });
  });

  it("flip a type cannot do is refused before any change", async () => {
    await withClient(async (client) => {
      const w = ready();
      const { id: wallId } = await wallAlongX(client);

      // The fixed window cannot flip its hand. Revit says so for an instance only, so this is found by making one and rolling it back,
      // and nothing of that is left: the project is as saved, with the same doors and windows, and the type is as it was.
      const refused = await refusedAndUnchanged(
        client,
        [{ typeId: w.door.id, wallId, offsetAlongWallMm: 1000, flipHand: true }, { typeId: w.window.id, wallId, offsetAlongWallMm: 3000, sillHeightMm: 900, flipHand: true }],
        /cannot flip its hand/,
        "flipHand of a fixed window",
      );
      assert.match(refused.message, /place_hosted item 1/);

      // The same window can flip its facing, and the door its hand: only the thing it cannot do is refused.
      const placed = landed(
        await place(client, [
          { typeId: w.window.id, wallId, offsetAlongWallMm: 3000, sillHeightMm: 900, flipFacing: true },
          { typeId: w.door.id, wallId, offsetAlongWallMm: 1000, flipHand: true },
        ]),
        "created",
      );
      assert.equal(placed[0]?.actual.facingFlipped, true);
      assert.equal(placed[1]?.actual.handFlipped, true);
    });
  });

  it("type that is no door or window is refused", async () => {
    await withClient(async (client) => {
      const w = ready();
      const { id: wallId } = await wallAlongX(client);

      const [bed] = landed(await loadFamily(client, [{ path: BED }]), "created");
      assert.ok(bed);
      const bedType = bed.actual.typeIds[0];
      assert.ok(bedType);

      // A bed, which is furniture: refused naming the item, and saying what to do instead.
      const refused = await refusedAndUnchanged(
        client,
        [{ typeId: w.door.id, wallId, offsetAlongWallMm: 1000 }, { typeId: bedType.id, wallId, offsetAlongWallMm: 3000, sillHeightMm: 0 }],
        /another category than doors and windows/,
        "a bed",
      );
      assert.match(refused.message, /place_hosted item 1/);
      assert.match(refused.message, /list_types with doors or windows/);

      // A wall id where a type is wanted, and a type id where a wall is wanted.
      await refusedAndUnchanged(client, [{ typeId: wallId, wallId, offsetAlongWallMm: 1000 }], /is not a type of a loaded family/, "a wall as a type");
      await refusedAndUnchanged(client, [{ typeId: w.door.id, wallId: w.door.id, offsetAlongWallMm: 1000 }], /is not one of the walls of this model/, "a type as a wall");

      // A family of the library that lies among the windows and is neither door nor window: its type is of another category all the same.
      const [other] = landed(await loadFamily(client, [{ path: OTHER_OPENING }]), "created");
      assert.ok(other?.actual.typeIds[0]);
      await refusedAndUnchanged(client, [{ typeId: other.actual.typeIds[0].id, wallId, offsetAlongWallMm: 3000, sillHeightMm: 900 }], /another category than doors and windows/, "a family of another category among the windows");

      // A type that does not say its size cannot be checked against the wall, so it is refused naming the type, rather than guessed at.
      // Both are real families of the library, and both read a width and a height of 0: a door that is a bare opening, and a window that is.
      const [doorOpening] = landed(await loadFamily(client, [{ path: DOOR_OPENING, typeName: "0762 x 2032 мм" }]), "created");
      const [windowOpening] = landed(await loadFamily(client, [{ path: WINDOW_OPENING }]), "created");
      assert.ok(doorOpening && windowOpening);
      for (const [what, type] of [
        ["a door opening", doorOpening.actual.typeIds[0]],
        ["a window opening", windowOpening.actual.typeIds[0]],
      ] as const) {
        assert.ok(type, what);
        const noSize = await refusedAndUnchanged(client, [{ typeId: type.id, wallId, offsetAlongWallMm: 3000, sillHeightMm: 900 }], /says no width above zero or no height above zero/, what);
        assert.ok(noSize.message.includes(type.id), `${what}: the message names the type ${type.id}`);
        assert.match(noSize.message, /nothing is placed on a guess/);
      }
    });
  });

  it("walls that start away from the origin and run in any direction", async () => {
    await withClient(async (client) => {
      const w = ready();
      const y = scene();

      // Walls of 6000 whose start is nowhere near the origin: along +X, along -X, along +Y and along -Y, and one at an angle of 36.87 degrees.
      const cases = [
        { what: "along +X from (25000, y)", from: { x: 25000, y }, to: { x: 31000, y }, dx: 1, dy: 0 },
        { what: "along -X from (31000, y+5000)", from: { x: 31000, y: y + 5000 }, to: { x: 25000, y: y + 5000 }, dx: -1, dy: 0 },
        { what: "along +Y from (40000, y)", from: { x: 40000, y }, to: { x: 40000, y: y + 6000 }, dx: 0, dy: 1 },
        { what: "along -Y from (45000, y+6000)", from: { x: 45000, y: y + 6000 }, to: { x: 45000, y }, dx: 0, dy: -1 },
        { what: "at an angle, from (50000, y)", from: { x: 50000, y }, to: { x: 54800, y: y + 3600 }, dx: 0.8, dy: 0.6 },
      ];

      for (const entry of cases) {
        const wallId = await makeWall(client, entry.from, entry.to);
        const length = Math.hypot(entry.to.x - entry.from.x, entry.to.y - entry.from.y);
        assertNear(length, 6000, `${entry.what}: length`, 0.01);

        // Windows, whose box is symmetric along the wall, at an offset measured from the start of the wall whichever way it runs.
        const asked = [1500, 3750].map((offset) => ({ typeId: w.window.id, wallId, offsetAlongWallMm: offset, sillHeightMm: 900 }));
        const windows = landed(await place(client, asked), "created");

        for (const [index, window] of windows.entries()) {
          const offset = asked[index]!.offsetAlongWallMm;
          assertNear(window.actual.offsetAlongWallMm, offset, `${entry.what}: offset ${offset}`, SIZE_NEAR_MM);
          assert.equal(window.actual.cutsWall, true, entry.what);

          // Where it is in the model: the start of the wall plus the offset along its direction. The box of a window is off the axis across the
          // wall, by its trim (some 90 mm measured), so the centre of the box is measured along the wall and across it, and not in x and y.
          const centre = centreOf(await boxOf(client, window.elementId));
          const along = (centre.x - entry.from.x) * entry.dx + (centre.y - entry.from.y) * entry.dy;
          const across = -(centre.x - entry.from.x) * entry.dy + (centre.y - entry.from.y) * entry.dx;
          console.log(`# ${entry.what}, offset ${offset}: the box is centred ${along.toFixed(1)} along the wall and ${across.toFixed(1)} across it`);
          assertNear(along, offset, `${entry.what}, offset ${offset}: along the wall`, 60);
          assert.ok(Math.abs(across) < 250, `${entry.what}, offset ${offset}: the box is centred ${across} off the axis`);
        }
      }

      // An offset that is past the end of a wall that runs the other way is past its end all the same, and the message gives where it runs.
      const reversed = await makeWall(client, { x: 31000, y: y + 9000 }, { x: 25000, y: y + 9000 });
      const refused = await refusedAndUnchanged(client, [{ typeId: w.door.id, wallId: reversed, offsetAlongWallMm: 5800 }], /5400 mm to 6200 mm along/, "past the end of a wall that runs along -X");
      assert.match(refused.message, /from \(31000, \d+\) mm to \(25000, \d+\) mm/);
    });
  });

  it("window on a wall of the second level, with a base offset", async () => {
    await withClient(async (client) => {
      const w = ready();
      const y = scene();
      const baseOffset = -500;
      const upperMm = w.upper.elevationMm;
      const foot = upperMm + baseOffset;
      const top = foot + WALL_HEIGHT_MM;

      // A wall on the upper level whose foot is 500 below that level: the sill is measured from the level, not from the foot.
      const wallId = await makeWall(client, { x: 0, y }, { x: WALL_LENGTH_MM, y }, { level: w.upper, baseOffsetMm: baseOffset });
      const wall = (await elementsOf(client, [wallId])).elements[0];
      assertNear(wall?.boundingBoxMm?.min.z, foot, "the foot of the wall", 1);
      assertNear(wall?.topMm, top, "the top of the wall", 1);

      const [window] = landed(await place(client, [{ typeId: w.window.id, wallId, offsetAlongWallMm: 2000, sillHeightMm: 900 }]), "created");
      assert.ok(window);
      assert.equal(window.actual.hostId, wallId);
      assertNear(window.actual.sillHeightMm, 900, "the sill above the upper level", SIZE_NEAR_MM);
      assert.equal(window.actual.cutsWall, true);

      const row = (await elementsOf(client, [window.elementId])).elements[0];
      assert.equal(row?.levelId, w.upper.id, "the window belongs to the level of the wall");
      const box = row?.boundingBoxMm;
      assert.ok(box);
      // In the model it starts at the level plus 900, which is 1400 above the foot of the wall.
      assert.ok(Math.abs(box.min.z - (upperMm + 900)) < 120, `the window starts at ${box.min.z}, the level is ${upperMm} and the sill 900`);

      // The same sill against the foot would put it 500 lower: the box says it is not.
      assert.ok(box.min.z - foot > 1200, `the box is ${box.min.z - foot} above the foot of the wall, and not 900`);

      // The top: 3000 from the foot is 2500 above the level. A window to 2500 is flush with it and lands, and 1 mm over is refused naming the level.
      const [flush] = landed(await place(client, [{ typeId: w.window.id, wallId, offsetAlongWallMm: 4500, sillHeightMm: 1300 }]), "created");
      assert.ok(flush);
      assertNear(flush.actual.sillHeightMm, 1300, "flush with the top of the wall", SIZE_NEAR_MM);
      const over = await refusedAndUnchanged(client, [{ typeId: w.window.id, wallId, offsetAlongWallMm: 500, sillHeightMm: 1301 }], /reaches only 2500 mm above that level/, "1 mm over the top of a wall with a base offset");
      assert.ok(over.message.includes(w.upper.name), `the message names the level of the sill, ${w.upper.name}: ${over.message}`);

      // The foot: a sill of -500 is the foot, and lands for a door; -501 is below it. The door is 2100 high, so its head is at 1600 above the level.
      const [atFoot] = landed(await place(client, [{ typeId: w.door.id, wallId, offsetAlongWallMm: 3300, sillHeightMm: baseOffset }]), "created");
      assert.ok(atFoot);
      assertNear(atFoot.actual.sillHeightMm, baseOffset, "a door on the foot of the wall", SIZE_NEAR_MM);
      assert.equal(atFoot.actual.cutsWall, true);
      const below = await refusedAndUnchanged(client, [{ typeId: w.door.id, wallId, offsetAlongWallMm: 5500, sillHeightMm: baseOffset - 1 }], /below the foot of the wall/, "below the foot");
      assert.match(below.message, /Raise sillHeightMm to at least -500/);

      // A door at sill 0 stands on the level, 500 above the foot, and is fine: the foot is below it.
      const [onLevel] = landed(await place(client, [{ typeId: w.door.id, wallId, offsetAlongWallMm: 5500 }]), "created");
      assert.ok(onLevel);
      assertNear(onLevel.actual.sillHeightMm, 0, "a door on the level", SIZE_NEAR_MM);
    });
  });

  it("a wall that cannot be measured along is refused by name", async () => {
    await withClient(async (client) => {
      const w = ready();
      const walls = await listTypes(client, "walls");
      const curtain = walls.find((row) => row.family === "Curtain Wall");
      assert.ok(curtain, `the template has a curtain wall type: ${JSON.stringify(walls.map((row) => row.family))}`);

      const y = scene();
      const wallId = await makeWall(client, { x: 0, y }, { x: WALL_LENGTH_MM, y }, { typeId: curtain.id });
      const refused = await refusedAndUnchanged(client, [{ typeId: w.door.id, wallId, offsetAlongWallMm: 3000 }], /is a curtain wall/, "a curtain wall");
      assert.ok(refused.message.includes(wallId), `the message names the wall ${wallId}: ${refused.message}`);
    });
  });

  it("a batch with a good item and a bad item leaves nothing", async () => {
    await withClient(async (client) => {
      const w = ready();
      const { id: wallId } = await wallAlongX(client);

      // Items 0 and 2 are good and item 1 is bad: nothing is placed, not even the first, and the refusal names the bad item.
      const refused = await refusedAndUnchanged(
        client,
        [
          { typeId: w.door.id, wallId, offsetAlongWallMm: 1000 },
          { typeId: w.window.id, wallId, offsetAlongWallMm: 2500 },
          { typeId: w.door.id, wallId, offsetAlongWallMm: 4000 },
        ],
        /is a window, so sillHeightMm is required/,
        "a window with no sill between two good items",
      );
      assert.match(refused.message, /place_hosted item 1/);
      assert.doesNotMatch(refused.message, /item 0|item 2/);

      // The wall is as it was: the same door can still be placed where the first good item asked, and it is the first one on the wall.
      const [door] = landed(await place(client, [{ typeId: w.door.id, wallId, offsetAlongWallMm: 1000 }]), "created");
      assert.ok(door);
    });
  });

  it("one call is one Undo step", { timeout: 450_000 }, async (t) => {
    await withClient(async (client) => {
      const w = ready();
      const { id: wallId } = await wallAlongX(client);
      await saved(client);
      const before = await openingsOf(client);

      const placed = landed(
        await place(client, [
          { typeId: w.door.id, wallId, offsetAlongWallMm: 1000 },
          { typeId: w.window.id, wallId, offsetAlongWallMm: 2500, sillHeightMm: 900 },
          { typeId: w.door.id, wallId, offsetAlongWallMm: 4000, flipFacing: true, flipHand: true },
        ]),
        "created",
      );
      assert.deepEqual(await openingsOf(client), { doors: before.doors + 2, windows: before.windows + 1 });

      // One Undo takes all three, named for the tool, and the instances are gone from the model.
      const undone = await undoWithOneRetry(t, client);
      console.log(`# undo of place_hosted: ${JSON.stringify(undone)}`);
      assert.equal(undone.state, "undone", JSON.stringify(undone));
      assert.equal(undone.transactionName, "MCP: place_hosted");
      for (const item of placed) {
        assert.ok(undone.createdIds.includes(item.elementId), `${item.elementId} should be among the created ids of the undo`);
      }
      assert.deepEqual((await elementsOf(client, placed.map((item) => item.elementId))).notFound.sort(), placed.map((item) => item.elementId).sort());
      assert.deepEqual(await openingsOf(client), before, "the one Undo took all three");

      // The wall is whole again: the door that was there can be placed again where it was, and it overlaps nothing.
      const [again] = landed(await place(client, [{ typeId: w.door.id, wallId, offsetAlongWallMm: 1000 }]), "created");
      assert.ok(again);
    });
  });

  it("leaves Revit in a state the close rule accepts", async () => {
    await withClient(async (client) => {
      await client.call("save_project", {});
      assert.deepEqual(checkCanClose((await modelInfo(client)).openDocuments), { ok: true, reasons: [] });
    });
  });
});
