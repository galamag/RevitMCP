import assert from "node:assert/strict";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { checkCanClose } from "../../src/cli/closeRule.ts";
import { BridgeClient } from "../../src/client.ts";
import { defaultConnectionPath } from "../../src/connection.ts";
import { BridgeRpcError } from "../../src/errors.ts";
import { boundsOfBand, decodePng, reportColours, reportHues, type Band, type Pixels, type PixelBox, type Region } from "../pngPixels.ts";
import { undoWithOneRetry } from "../undoRetry.ts";

// These tests need a running Revit with the RevitMCP plugin loaded. Each run creates one new project in the test folder
// and leaves it open and saved. The model is judged two ways. Numbers come from the model after the commit, and the pixels
// of snapshots are read here, so a machine decides what a picture shows. The PNGs are kept in the test folder too, for a
// person or a model to look at. Scenes stand far apart, so no ground or floor of one touches another.

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

interface Point {
  x: number;
  y: number;
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

interface ElementRow {
  id: string;
  category: string | null;
  levelId: string | null;
  boundingBoxMm: Box | null;
  /** The real top of a wall, read from its shape. */
  topMm?: number | null;
}

interface ElementsAnswer {
  elements: ElementRow[];
  notFound: string[];
}

interface WarningRow {
  definitionId: string;
  text: string;
  elementIds: string[];
}

interface CeilingActual {
  areaM2: number | null;
  heightOffsetMm: number;
  typeId: string;
  levelId: string;
  boundingBoxMm: Box | null;
}

interface OpeningActual {
  floorId: string | null;
  areaBeforeM2: number;
  areaAfterM2: number;
  cutM2: number;
  floorAreaAfterCallM2: number | null;
  boundaryMm: Point[] | null;
}

interface GroundActual {
  topOffsetMm: number;
  typeId: string;
  levelId: string;
  boundingBoxMm: Box | null;
}

interface FloorActual {
  areaM2: number;
  boundingBoxMm: Box | null;
}

interface WallActual {
  baseOffsetMm: number;
  heightMm: number;
  widthMm: number;
}

interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** What the tests share: the levels, and the types the template has under names that are read here, not guessed. */
interface World {
  ground: Level;
  upper: Level;
  floorType: TypeRow;
  basicCeiling: TypeRow;
  compoundCeiling: TypeRow;
  wallType: TypeRow;
  meadow: TypeRow;
  groundTypes: TypeRow[];
  /** One layer of red, so that a picture tells the house from the ground. */
  redWall: string;
  redFloor: string;
  ceilingIds: string[];
}

const INVALID_PARAMS = -32602;
/** The id of the warning Revit keeps for a toposolid that overlaps a floor. A GUID, so it does not change with the language of Revit. Observed. */
const OVERLAP_WARNING_ID = "2e5915d8-c4a4-472d-8e2d-f161cfc8ce68";
const NEAR_MM = 0.01;
/** Areas come back from Revit with noise in the 13th place. */
const NEAR_M2 = 1e-6;
const UPPER_LEVEL_MM = 5200;
/** Revit's own height for a new ceiling. A test that asks for it proves nothing, so none does. */
const REVIT_DEFAULT_CEILING_MM = 2600;
const FLOOR_THICKNESS_MM = 300;
const WALL_BASE_MM = -400;
const WALL_HEIGHT_MM = 3400;
const SNAPSHOT_WIDTH_PX = 1200;
const SCENE_PITCH_MM = 150000;

/** A coloured region counts as showing a colour when almost all of its coloured pixels are of that band. */
const MIN_BAND_SHARE = 0.95;
/** Red is flat and fills its region. */
const MIN_RED_COLOURED = 0.9;
/** The grass of the meadow is olive, hue 60 to 100 degrees on every picture, which is in none of the three bands. Measured on this run's pictures. */
const GRASS_FROM_DEG = 55;
const GRASS_TO_DEG = 110;
/** The grass has pale specks, which are not coloured, so it fills less of a region. Measured 0.89 to 1. */
const MIN_GRASS_COLOURED = 0.7;

/*
 * The picture of the house, from the south at eye height, and what each check on it catches. Measured on controls: the same house with
 * the ground top at 0, at -400, which is right, and at -2400.
 *
 * - The wall rows: 129, 145 and 145 rows at 30 m. They catch a ground that covers the foot of the wall (top 0), and nothing lower.
 * - Grass under the foot and in front of the house: grass in all three. They catch a ground that is missing or does not reach the
 *   house, and say nothing of its height.
 * - Grass beside the house at the height of its foot: grass at 0 and at -400, and not at -2400, where the coloured share is 0.15. That is
 *   incidental: it fails because the far edge of the ground, at row 521, lies below the rows that are looked at. It is not relied on.
 * - The far edge of the ground. The camera looks level, so a row below the horizon is a height at a distance, and the first grass row
 *   beside the house is the far edge of the ground at a distance that the scene sets: 70 m. One row is 55 mm of height there. The check
 *   turns that row back into the top of the ground, and wants it at the foot of the wall: rows 477, 485 and 521 for 0, -400 and -2400,
 *   read back as 18, -420 and -2396 mm. This is a check of the top of the ground, but only because the scene puts the far edge in frame.
 *   A ground that reached the horizon would show no edge, and the check would fail instead of passing, as it asks for an edge below it.
 *   Its limits: one row is 55 mm, so the tolerance of 200 mm is the finest it can be; it reads the far edge of the top face and says
 *   nothing of the thickness below; and it trusts the far edge of the ground to lie where the scene put it.
 */
/** 140 rows at least: the wall of 3400 mm fills 145, and a ground with its top at 0 covers 400 mm of it and leaves 129. */
const MIN_WALL_ROWS = 140;
/** The wall base and the ground meet: the first rows under the wall are ground, within this many rows. */
const CONTACT_ROWS = 8;
const EYE_HEIGHT_MM = 1500;
const EYE_DISTANCE_MM = 30000;
/** How far the meadow of a house reaches north of its wall, and so how far its far edge is from the eye: this and EYE_DISTANCE_MM. */
const GROUND_REACH_MM = 40000;
/** The top of the ground, as the far edge shows it, may differ from the foot of the wall by this much: 3.6 rows, and the measured error is under 1. */
const GROUND_TOP_TOLERANCE_MM = 200;
/** The far edge has to lie this many rows below the horizon, or it is the horizon that was found. */
const MIN_ROWS_BELOW_HORIZON = 5;
/** Grass rows of the far edge: this many in a row, each at least half coloured. Pale specks are not coloured. */
const EDGE_CONFIRM_ROWS = 6;
const EDGE_MIN_COLOURED = 0.5;

const stamp = new Date().toTimeString().slice(0, 8).replaceAll(":", "");
const name = `проверка-этап3-проёмы-${stamp}`;
const snapshotFolder = path.join(homedir(), "Documents", "RevitMCP", "task5-host");

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

const warningsOf = (client: BridgeClient): Promise<WarningRow[]> => client.call("get_warnings", {}) as Promise<WarningRow[]>;

const ceilings = (client: BridgeClient, items: unknown[]): Promise<Batch<CeilingActual>> => client.call("create_ceilings", { items }) as Promise<Batch<CeilingActual>>;

const openings = (client: BridgeClient, items: unknown[]): Promise<Batch<OpeningActual>> => client.call("create_floor_openings", { items }) as Promise<Batch<OpeningActual>>;

const grounds = (client: BridgeClient, items: unknown[]): Promise<Batch<GroundActual>> => client.call("create_ground", { items }) as Promise<Batch<GroundActual>>;

function ready(): World {
  assert.ok(world, "the first test reads the template");
  return world;
}

/** The start of the next scene, in y, so that no scene touches another. */
function scene(): number {
  const y = nextSceneY;
  nextSceneY += SCENE_PITCH_MM;
  return y;
}

const rectangle = ({ x0, y0, x1, y1 }: Rect): Point[] => [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];

const areaOf = ({ x0, y0, x1, y1 }: Rect): number => ((x1 - x0) * (y1 - y0)) / 1e6;

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
  assert.deepEqual(batch.warnings, [], "nothing here should give Revit something to warn about");
}

function created<A>(batch: Batch<A>): Array<{ id: string; actual: A }> {
  assertLanded(batch);

  return batch.items.map((item) => {
    assert.equal(item.status, "created", JSON.stringify(item));
    assert.ok(item.elementId && item.actual, JSON.stringify(item));
    return { id: item.elementId, actual: item.actual };
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

/** A floor of the given type on the ground level, which stands for one scene. */
async function makeFloor(client: BridgeClient, rect: Rect, typeId: string): Promise<{ id: string; actual: FloorActual }> {
  const batch = (await client.call("create_floors", {
    items: [{ boundaryMm: rectangle(rect), typeId, levelId: ready().ground.id }],
  })) as Batch<FloorActual>;
  const [floor] = created(batch);
  assert.ok(floor);
  return floor;
}

/** Looks at the scene from a point and keeps the picture. A camera straight above has north up in the picture. */
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

const FROM_ABOVE_MM = 30000;

/** Straight down on the middle of a floor. */
const fromAbove = (client: BridgeClient, title: string, rect: Rect): Promise<Pixels> =>
  snapshot(client, title, { x: (rect.x0 + rect.x1) / 2, y: (rect.y0 + rect.y1) / 2, z: FROM_ABOVE_MM }, { x: (rect.x0 + rect.x1) / 2, y: (rect.y0 + rect.y1) / 2, z: 0 });

/** Where the plan lies in a picture taken from above, found from the floor itself, which is the only red thing in it. */
interface Frame {
  pixels: Pixels;
  floor: Rect;
  box: PixelBox;
}

function frameOf(pixels: Pixels, floor: Rect): Frame {
  const box = boundsOfBand(pixels, "red");
  assert.ok(box && box.count > 20000, `the floor should be the red part of the picture: ${JSON.stringify(box)}`);
  const ratio = (box.right - box.left + 1) / (box.bottom - box.top + 1);
  assertNear(ratio, (floor.x1 - floor.x0) / (floor.y1 - floor.y0), "the shape of the floor in the picture", 0.02);
  console.log(`# the floor in the picture: ${JSON.stringify(box)}`);

  return { pixels, floor, box };
}

/** The part of the picture that a part of the plan covers, taken in from every side by `inset`, as fractions of the picture. */
function planRegion(frame: Frame, part: Rect, inset = 0.2): Region {
  const { box, floor, pixels } = frame;
  const perMmX = (box.right - box.left + 1) / (floor.x1 - floor.x0);
  const perMmY = (box.bottom - box.top + 1) / (floor.y1 - floor.y0);
  const left = box.left + (part.x0 - floor.x0) * perMmX;
  const right = box.left + (part.x1 - floor.x0) * perMmX;
  const top = box.top + (floor.y1 - part.y1) * perMmY;
  const bottom = box.top + (floor.y1 - part.y0) * perMmY;
  const dx = (right - left) * inset;
  const dy = (bottom - top) * inset;

  return { left: (left + dx) / pixels.width, top: (top + dy) / pixels.height, right: (right - dx) / pixels.width, bottom: (bottom - dy) / pixels.height };
}

/** Asserts that a region of a picture is of one colour, or holds none of it, and logs what it measured. */
function assertShows(pixels: Pixels, region: Region, expected: Band, what: string, minColoured = MIN_RED_COLOURED): void {
  const report = reportColours(pixels, region);
  const shares = { red: report.bands.red.share, green: report.bands.green.share, blue: report.bands.blue.share };
  console.log(`# ${what}: expected ${expected}, ${report.coloured} of ${report.pixels} pixels coloured, shares ${JSON.stringify(shares)}`);

  assert.equal(report.dominant, expected, what);
  assert.ok(report.bands[expected].share >= MIN_BAND_SHARE, `${what}: only ${report.bands[expected].share} of the colour is ${expected}`);
  assert.ok(report.coloured / report.pixels >= minColoured, `${what}: only ${report.coloured} of ${report.pixels} pixels are coloured`);
}

interface Measured {
  ok: boolean;
  detail: string;
}

/** Measures whether a region of a picture shows the meadow: nearly all of what is coloured in it has the hue of its grass. */
function measureGrass(pixels: Pixels, region: Region, minColoured = MIN_GRASS_COLOURED): Measured {
  const report = reportHues(pixels, GRASS_FROM_DEG, GRASS_TO_DEG, region);
  const filled = report.coloured / report.pixels;

  return {
    ok: report.share >= MIN_BAND_SHARE && filled >= minColoured,
    detail: `${report.coloured} of ${report.pixels} pixels coloured (${filled.toFixed(2)}), ${report.share.toFixed(3)} of them grass`,
  };
}

/** Asserts that a region of a picture shows the meadow, and logs what it measured. */
function assertGrass(pixels: Pixels, region: Region, what: string): void {
  const measured = measureGrass(pixels, region);
  console.log(`# ${what}: expected grass, ${measured.detail}`);

  assert.ok(measured.ok, `${what}: ${measured.detail}`);
}

/** The first row, from the top, where the columns hold grass for EDGE_CONFIRM_ROWS rows in a row, or null. */
function firstGrassRow(pixels: Pixels, left: number, right: number): number | null {
  let run = 0;

  for (let y = 0; y < pixels.height; y++) {
    // A quarter row in from each edge, so that the region is exactly this row whatever the rounding of the fractions.
    const row = { left, right, top: (y + 0.25) / pixels.height, bottom: (y + 0.75) / pixels.height };
    run = measureGrass(pixels, row, EDGE_MIN_COLOURED).ok ? run + 1 : 0;

    if (run === EDGE_CONFIRM_ROWS) {
      return y - EDGE_CONFIRM_ROWS + 1;
    }
  }

  return null;
}

/** What the model says of a house and its camera, for what the picture of it has to show. */
interface HouseScene {
  /** The foot and the top of its walls, read from the model, in millimetres in model coordinates. */
  footMm: number;
  topMm: number;
  /** Along the line of sight, from the eye to the outer face of the front wall, and to the far edge of the ground. */
  frontMm: number;
  farMm: number;
}

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

const CHECK = {
  wallRows: "the ground does not cover the foot of the wall",
  underFoot: "grass right under the foot of the wall",
  inFront: "grass in front of the house",
  besideLeft: "grass left of the house at the height of its foot",
  besideRight: "grass right of the house at the height of its foot",
  farEdge: "the top of the ground, read from its far edge, is the foot of the wall",
} as const;

/** The checks on the picture of a house from the south. They are listed by name, so that a control can say which of them a wrong ground fails. */
function houseChecks(south: Pixels, scene: HouseScene): Check[] {
  const house = boundsOfBand(south, "red");
  assert.ok(house && house.count > 20000, `the house should be the red part of the picture: ${JSON.stringify(house)}`);

  const rows = house.bottom - house.top + 1;
  const columns = { left: house.left / south.width, right: (house.right + 1) / south.width };
  const row = (from: number, to: number): { top: number; bottom: number } => ({ top: from / south.height, bottom: to / south.height });
  const grass = (name: string, region: Region): Check => ({ name, ...measureGrass(south, region) });
  const beside = row(house.bottom - 30, house.bottom - 5);

  // The scale of the picture, from the top edge of the wall, which no ground can cover. The line of sight is level, so that edge lies
  // (top of the wall - eye) above the horizon, at the distance of the front face.
  const horizon = south.height / 2;
  const focalPx = ((horizon - house.top) * scene.frontMm) / (scene.topMm - EYE_HEIGHT_MM);
  const topFromRow = (edgeRow: number): number => EYE_HEIGHT_MM - ((edgeRow - horizon) * scene.farMm) / focalPx;

  const edges = [["left", 0.1, 0.25], ["right", 0.75, 0.9]] as const;
  const found = edges.map(([side, left, right]) => ({ side, row: firstGrassRow(south, left, right) }));
  const tops = found.map((edge) => (edge.row === null ? null : topFromRow(edge.row)));
  const farEdgeOk = found.every((edge, index) => {
    const top = tops[index];
    return edge.row !== null && edge.row >= horizon + MIN_ROWS_BELOW_HORIZON && typeof top === "number" && Math.abs(top - scene.footMm) <= GROUND_TOP_TOLERANCE_MM;
  });

  return [
    { name: CHECK.wallRows, ok: rows >= MIN_WALL_ROWS, detail: `the wall fills ${rows} rows, ${MIN_WALL_ROWS} at least` },
    grass(CHECK.underFoot, { ...columns, ...row(house.bottom + 1, house.bottom + CONTACT_ROWS) }),
    grass(CHECK.inFront, { ...columns, ...row(house.bottom + CONTACT_ROWS + 1, south.height) }),
    grass(CHECK.besideLeft, { left: 0.02, right: (house.left - 20) / south.width, ...beside }),
    grass(CHECK.besideRight, { left: (house.right + 20) / south.width, right: 0.98, ...beside }),
    {
      name: CHECK.farEdge,
      ok: farEdgeOk,
      detail:
        `first grass row ${found.map((edge) => `${edge.side} ${String(edge.row)}`).join(", ")} against the horizon at ${horizon}, which reads as the top of the ground at ` +
        `${tops.map((top) => (top === null ? "none" : `${top.toFixed(0)} mm`)).join(", ")}, and the foot of the wall is at ${scene.footMm} mm, within ${GROUND_TOP_TOLERANCE_MM}`,
    },
  ];
}

/** A house, a scene of its own, and the picture of it from the south. */
interface House {
  walls: Array<{ id: string; actual: WallActual }>;
  /** The foot of each wall, from the model. */
  feet: number[];
  groundBatch: Batch<GroundActual>;
  groundTopMm: number;
  south: Pixels;
  scene: HouseScene;
}

/**
 * Four red walls 3400 high that start at the foot of the ground at -400, a red floor inside them, and meadow around with its top at
 * `groundTopMm`, which is the thing that varies. The camera stands 30 m south at the height of 1500 and looks north, level.
 */
async function buildHouse(client: BridgeClient, title: string, groundTopMm: number): Promise<House> {
  const w = ready();
  const y = scene();
  const footprint: Rect = { x0: 0, y0: y, x1: 10000, y1: y + 8000 };
  const corners = rectangle(footprint);

  const walls = created(
    (await client.call("create_walls", {
      items: corners.map((start, index) => ({
        startMm: start,
        endMm: corners[(index + 1) % corners.length],
        typeId: w.redWall,
        levelId: w.ground.id,
        heightMm: WALL_HEIGHT_MM,
        baseOffsetMm: WALL_BASE_MM,
      })),
    })) as Batch<WallActual>,
  );
  await makeFloor(client, footprint, w.redFloor);
  const groundBatch = await grounds(client, [
    { boundaryMm: rectangle({ x0: -25000, y0: y - GROUND_REACH_MM, x1: 35000, y1: y + GROUND_REACH_MM }), levelId: w.ground.id, topOffsetMm: groundTopMm, typeId: w.meadow.id },
  ]);
  const groundTopMeasured = groundBatch.items[0]?.actual?.boundingBoxMm?.max.z;

  const walled = await elementsOf(client, walls.map((wall) => wall.id));
  assert.deepEqual(walled.notFound, []);
  const feet = walled.elements.map((wall) => wall.boundingBoxMm?.min.z as number);
  const tops = walled.elements.map((wall) => wall.topMm as number);
  assert.ok(tops.every((top) => Math.abs(top - tops[0]!) < NEAR_MM), `the walls have one top: ${JSON.stringify(tops)}`);

  const eye = { x: 5000, y: y - EYE_DISTANCE_MM, z: EYE_HEIGHT_MM };
  const south = await snapshot(client, title, eye, { x: 5000, y, z: EYE_HEIGHT_MM });

  return {
    walls,
    feet,
    groundBatch,
    groundTopMm: groundTopMeasured as number,
    south,
    scene: {
      footMm: feet[0]!,
      topMm: tops[0]!,
      frontMm: EYE_DISTANCE_MM - walls[0]!.actual.widthMm / 2,
      farMm: EYE_DISTANCE_MM + GROUND_REACH_MM,
    },
  };
}

describe("stage 3 live checks: ceilings, floor openings and ground", { timeout: 900_000 }, () => {
  it("creates a project for this run, with an upper level and the types it needs", async () => {
    await withClient(async (client) => {
      await client.call("create_project", { name });

      const info = await modelInfo(client);
      assert.equal(info.activeDocument?.title, name);
      const ground = info.levels.find((level) => level.elevationMm === 0);
      assert.ok(ground, `no level at the origin in ${JSON.stringify(info.levels)}`);

      const [upper] = created((await client.call("create_levels", { items: [{ name: `Верх ${stamp}`, elevationMm: UPPER_LEVEL_MM }] })) as Batch<unknown>);
      assert.ok(upper);

      const floors = await listTypes(client, "floors");
      const walls = await listTypes(client, "walls");
      const ceilingTypes = await listTypes(client, "ceilings");
      const groundTypes = await listTypes(client, "toposolid");
      const find = (rows: TypeRow[], pattern: RegExp): TypeRow => {
        const found = rows.find((row) => pattern.test(row.name));
        assert.ok(found, `no type matches ${String(pattern)} in ${JSON.stringify(rows.map((row) => row.name))}`);
        return found;
      };
      assert.ok(groundTypes.length > 0, "the template has types of ground, and list_types toposolid lists them");

      const [red] = created(
        (await client.call("create_materials", { items: [{ name: `Красный ${stamp}`, colorRgb: { r: 255, g: 0, b: 0 } }] })) as Batch<unknown>,
      );
      assert.ok(red);
      const floorType = find(floors, /^Типовой 300мм$/);
      const wallType = find(walls, /^Наружный - Стена из бруса толщиной 180 мм/);
      const [redWall] = created(
        (await client.call("create_type", {
          items: [{ category: "walls", baseTypeId: wallType.id, name: `Стена красная ${stamp}`, layers: [{ thicknessMm: 200, materialId: red.id, function: "structure" }] }],
        })) as Batch<unknown>,
      );
      const [redFloor] = created(
        (await client.call("create_type", {
          items: [{ category: "floors", baseTypeId: floorType.id, name: `Пол красный ${stamp}`, layers: [{ thicknessMm: FLOOR_THICKNESS_MM, materialId: red.id, function: "structure" }] }],
        })) as Batch<unknown>,
      );
      assert.ok(redWall && redFloor);

      world = {
        ground,
        upper: { id: upper.id, name: `Верх ${stamp}`, elevationMm: UPPER_LEVEL_MM },
        floorType,
        basicCeiling: find(ceilingTypes, /^Типовой$/),
        compoundCeiling: find(ceilingTypes, /^Гладкий$/),
        wallType,
        meadow: find(groundTypes, /^Луг/),
        groundTypes,
        redWall: redWall.id,
        redFloor: redFloor.id,
        ceilingIds: [],
      };
      console.log(`# template: ${JSON.stringify(world)}`);
    });
  });

  it("ceiling sits at the requested height", async () => {
    await withClient(async (client) => {
      const w = ready();
      const y = scene();

      // Heights that no level suggests, and none of them is the 2600 that Revit would pick. Each ceiling has a place of its own.
      const cases = [
        { what: "a basic ceiling 2350 above the first level", type: w.basicCeiling, level: w.ground, offset: 2350 },
        { what: "a compound ceiling 3700 above the first level, higher than the 2600 of Revit", type: w.compoundCeiling, level: w.ground, offset: 3700 },
        { what: "a compound ceiling at 0, on the level itself", type: w.compoundCeiling, level: w.ground, offset: 0 },
        { what: "a basic ceiling 300 below the upper level", type: w.basicCeiling, level: w.upper, offset: -300 },
        { what: "a compound ceiling 2350 above the upper level", type: w.compoundCeiling, level: w.upper, offset: 2350.5 },
      ];
      for (const entry of cases) {
        assert.notEqual(entry.offset, REVIT_DEFAULT_CEILING_MM, entry.what);
      }
      const places = cases.map((_, index): Rect => ({ x0: index * 6000, y0: y, x1: index * 6000 + 5000, y1: y + 4000 }));

      const batch = await ceilings(
        client,
        cases.map((entry, index) => ({ boundaryMm: rectangle(places[index]!), typeId: entry.type.id, levelId: entry.level.id, heightOffsetMm: entry.offset })),
      );
      const made = created(batch);
      assert.equal(made.length, cases.length);
      w.ceilingIds.push(...made.map((entry) => entry.id));

      // What the model holds after the commit, from the tool and again from get_elements, which reads the box of the element.
      const read = await elementsOf(client, made.map((entry) => entry.id));
      assert.deepEqual(read.notFound, []);

      for (const [index, entry] of cases.entries()) {
        const { id, actual } = made[index]!;
        const underside = entry.level.elevationMm + entry.offset;
        console.log(`# ${entry.what}: ${JSON.stringify(actual)}`);

        assertNear(actual.heightOffsetMm, entry.offset, `${entry.what}: height offset`);
        assert.equal(actual.typeId, entry.type.id, entry.what);
        assert.equal(actual.levelId, entry.level.id, entry.what);
        assertNear(actual.areaM2, areaOf(places[index]!), `${entry.what}: area`, NEAR_M2);
        assertNear(actual.boundingBoxMm?.min.z, underside, `${entry.what}: underside in the box of the tool`);

        const row = read.elements.find((element) => element.id === id);
        assert.ok(row, `${entry.what}: get_elements has no ceiling ${id}`);
        assert.equal(row.category, "ceilings");
        assert.equal(row.levelId, entry.level.id);
        assertNear(row.boundingBoxMm?.min.z, underside, `${entry.what}: underside in the model`);
        assertNear(row.boundingBoxMm?.min.x, places[index]!.x0, `${entry.what}: x of the outline`);
        assertNear(row.boundingBoxMm?.max.y, places[index]!.y1, `${entry.what}: y of the outline`);

        // The thickness of a compound ceiling goes up from the underside, and a basic ceiling has none.
        const thickness = (row.boundingBoxMm?.max.z ?? Number.NaN) - (row.boundingBoxMm?.min.z ?? Number.NaN);
        if (entry.type === w.basicCeiling) {
          assertNear(thickness, 0, `${entry.what}: thickness`);
        } else {
          assert.ok(thickness > 0, `${entry.what}: a compound ceiling has a thickness, not ${thickness}`);
        }
      }
    });
  });

  it("opening cuts the floor", async () => {
    await withClient(async (client) => {
      const w = ready();
      const y = scene();
      const floorRect: Rect = { x0: 0, y0: y, x1: 10000, y1: y + 8000 };
      const hole: Rect = { x0: 6000, y0: y + 2000, x1: 9000, y1: y + 5000 };
      const notch: Rect = { x0: 9000, y0: y + 5500, x1: 11000, y1: y + 7000 };
      /** The part of the notch that lies over the floor, which is where its cut shows. */
      const notchOverFloor: Rect = { ...notch, x1: floorRect.x1 };
      const control: Rect = { x0: 1000, y0: y + 1000, x1: 5000, y1: y + 7000 };

      // A red floor with grass under it, so that a hole shows green. The top of the ground lies below the underside of the floor: no warning.
      const floor = await makeFloor(client, floorRect, w.redFloor);
      assertNear(floor.actual.areaM2, areaOf(floorRect), "the area of the floor", NEAR_M2);
      const groundRect: Rect = { x0: -25000, y0: y - 25000, x1: 35000, y1: y + 35000 };
      const [meadow] = created(await grounds(client, [{ boundaryMm: rectangle(groundRect), levelId: w.ground.id, topOffsetMm: -400, typeId: w.meadow.id }]));
      assert.ok(meadow);

      const whole = frameOf(await fromAbove(client, "проём-до", floorRect), floorRect);
      assertShows(whole.pixels, planRegion(whole, hole), "red", "before: where the opening will be");
      assertShows(whole.pixels, planRegion(whole, notchOverFloor), "red", "before: where the opening across the edge will be");
      assertShows(whole.pixels, planRegion(whole, control), "red", "before: the rest of the floor");

      // An opening inside the floor takes its area off, and says so from the model.
      const countBefore = countOf(await modelInfo(client), "OST_FloorOpening");
      const [inside] = created(await openings(client, [{ floorId: floor.id, boundaryMm: rectangle(hole) }]));
      assert.ok(inside);
      console.log(`# the opening inside: ${JSON.stringify(inside.actual)}`);
      assert.equal(inside.actual.floorId, floor.id);
      assertNear(inside.actual.areaBeforeM2, areaOf(floorRect), "area before", NEAR_M2);
      assertNear(inside.actual.areaAfterM2, areaOf(floorRect) - areaOf(hole), "area after", NEAR_M2);
      assertNear(inside.actual.cutM2, areaOf(hole), "area cut", NEAR_M2);
      assertNear(inside.actual.floorAreaAfterCallM2, areaOf(floorRect) - areaOf(hole), "area of the floor after the call", NEAR_M2);
      assert.ok(inside.actual.areaAfterM2 < inside.actual.areaBeforeM2, "the area of the floor fell");
      assert.equal(inside.actual.boundaryMm?.length, 4);
      for (const corner of rectangle(hole)) {
        assert.ok(
          inside.actual.boundaryMm?.some((point) => Math.abs(point.x - corner.x) < NEAR_MM && Math.abs(point.y - corner.y) < NEAR_MM),
          `the opening has no edge starting at ${JSON.stringify(corner)}: ${JSON.stringify(inside.actual.boundaryMm)}`,
        );
      }
      const row = (await elementsOf(client, [inside.id])).elements[0];
      assert.equal(row?.category, "OST_FloorOpening");
      assert.equal(countOf(await modelInfo(client), "OST_FloorOpening"), countBefore + 1);

      // An opening across the edge of the floor succeeds with a smaller cut: only what overlaps is taken, and Revit has nothing to warn of.
      const overlap = notchOverFloor;
      const crossing = await openings(client, [{ floorId: floor.id, boundaryMm: rectangle(notch) }]);
      const [edge] = created(crossing);
      assert.ok(edge);
      console.log(`# the opening across the edge: ${JSON.stringify(edge.actual)}`);
      assert.ok(areaOf(notch) > areaOf(overlap), "the outline reaches beyond the floor");
      assertNear(edge.actual.areaBeforeM2, areaOf(floorRect) - areaOf(hole), "area before the crossing opening", NEAR_M2);
      assertNear(edge.actual.cutM2, areaOf(overlap), "the cut is the overlap, not the outline", NEAR_M2);
      assertNear(edge.actual.floorAreaAfterCallM2, areaOf(floorRect) - areaOf(hole) - areaOf(overlap), "area of the floor after the crossing opening", NEAR_M2);

      // On the snapshot, the ground shows through both openings, and the rest of the floor is red as it was.
      const after = await fromAbove(client, "проём-после", floorRect);
      assertGrass(after, planRegion(whole, hole), "after: the opening shows the ground");
      assertGrass(after, planRegion(whole, notchOverFloor), "after: the opening across the edge shows the ground");
      assertShows(after, planRegion(whole, control), "red", "after: the rest of the floor");
      const outline = boundsOfBand(after, "red");
      assert.ok(outline);
      for (const edge of ["left", "top", "right", "bottom"] as const) {
        assert.ok(Math.abs(outline[edge] - whole.box[edge]) <= 2, `the ${edge} edge of the floor is where it was: ${outline[edge]} against ${whole.box[edge]}`);
      }
      const grassBeside = planRegion(whole, { x0: -7000, y0: floorRect.y0, x1: -1000, y1: floorRect.y1 });
      assertGrass(after, grassBeside, "after: the ground beside the floor");
    });
  });

  it("opening outside the floor fails", async () => {
    await withClient(async (client) => {
      const w = ready();
      const y = scene();
      const floorRect: Rect = { x0: 0, y0: y, x1: 6000, y1: y + 4000 };
      const inside: Rect = { x0: 1000, y0: y + 1000, x1: 2000, y1: y + 2000 };
      const outside: Rect = { x0: 20000, y0: y + 20000, x1: 22000, y1: y + 22000 };
      const floor = await makeFloor(client, floorRect, w.floorType.id);

      // The floor has one opening, so that its area is not the one it was made with.
      const [first] = created(await openings(client, [{ floorId: floor.id, boundaryMm: rectangle(inside) }]));
      assert.ok(first);
      const areaNow = areaOf(floorRect) - areaOf(inside);
      assertNear(first.actual.floorAreaAfterCallM2, areaNow, "area of the floor", NEAR_M2);

      await saved(client);
      const infoBefore = await modelInfo(client);
      const warningsBefore = await warningsOf(client);

      // An opening wholly outside: Revit takes it and warns, and the tool sees the area stand still. The item fails, and the one before it is rolled back.
      const next: Rect = { x0: 3000, y0: y + 1000, x1: 4000, y1: y + 2000 };
      const failed = await openings(client, [
        { floorId: floor.id, boundaryMm: rectangle(next) },
        { floorId: floor.id, boundaryMm: rectangle(outside) },
      ]);
      console.log(`# the opening outside: ${JSON.stringify(failed)}`);
      assert.equal(failed.committed, false);
      assert.deepEqual(failed.items.map((item) => item.status), ["rolled_back", "failed"]);
      assert.equal(failed.items[0]?.elementId, null);
      assert.equal(failed.items[1]?.elementId, null);
      assert.equal(failed.items[1]?.actual, null);
      // The item before it had cut a square metre by then, so the floor had this much when the outside opening was cut, and still has it.
      const areaThen = String(Math.round((areaNow - areaOf(next)) * 1000) / 1000);
      assert.match(failed.items[1]?.error ?? "", /cut nothing/);
      assert.ok(failed.items[1]?.error?.includes(floor.id), "the error names the floor");
      assert.ok(failed.items[1]?.error?.includes(`has ${areaThen} m² after it, and had ${areaThen} m² before`), `the error names both areas, ${areaThen} m²: ${String(failed.items[1]?.error)}`);
      assert.ok(failed.errors.some((text) => /Item 1 failed, so nothing landed/.test(text)), JSON.stringify(failed.errors));
      assert.deepEqual(failed.dialogs, []);

      // Nothing landed, and the floor is as it was: no opening was added, no warning was kept, and the next opening starts from the same area.
      const infoAfter = await modelInfo(client);
      assert.equal(countOf(infoAfter, "OST_FloorOpening"), countOf(infoBefore, "OST_FloorOpening"));
      assert.deepEqual(await warningsOf(client), warningsBefore);
      const [again] = created(await openings(client, [{ floorId: floor.id, boundaryMm: rectangle(next) }]));
      assert.ok(again);
      assertNear(again.actual.areaBeforeM2, areaNow, "the floor starts from the area it had", NEAR_M2);
      assertNear(again.actual.floorAreaAfterCallM2, areaNow - areaOf(next), "area after the opening that was rolled back before", NEAR_M2);

      // An opening inside one cut before it in the same list cuts nothing either, and fails the same way. The other order is below.
      const small: Rect = { x0: 4500, y0: y + 2500, x1: 5500, y1: y + 3500 };
      const large: Rect = { x0: 4200, y0: y + 2200, x1: 5800, y1: y + 3800 };
      const twice = await openings(client, [
        { floorId: floor.id, boundaryMm: rectangle(large) },
        { floorId: floor.id, boundaryMm: rectangle(small) },
      ]);
      assert.equal(twice.committed, false);
      assert.deepEqual(twice.items.map((item) => item.status), ["rolled_back", "failed"]);
      assert.match(twice.items[1]?.error ?? "", /inside an opening cut before it/);
      assert.equal(countOf(await modelInfo(client), "OST_FloorOpening"), countOf(infoAfter, "OST_FloorOpening") + 1, "the batches that failed left no opening, and the call that landed added one");

      // The other order lands: a large opening after a small one that it encloses. Revit takes both, the small one stays in the model with
      // the status created, and the large one cuts only what the small one left. Nothing says that the small one now adds nothing.
      const floorAreaNow = areaNow - areaOf(next);
      const enclosing = created(await openings(client, [{ floorId: floor.id, boundaryMm: rectangle(small) }, { floorId: floor.id, boundaryMm: rectangle(large) }]));
      console.log(`# an opening that encloses one cut before it: ${JSON.stringify(enclosing.map((entry) => ({ ...entry.actual, boundaryMm: undefined })))}`);
      assertNear(enclosing[0]?.actual.areaBeforeM2, floorAreaNow, "area before the small opening", NEAR_M2);
      assertNear(enclosing[0]?.actual.cutM2, areaOf(small), "the small opening cuts its own area", NEAR_M2);
      assertNear(enclosing[1]?.actual.areaBeforeM2, floorAreaNow - areaOf(small), "the large opening starts from what the small one left", NEAR_M2);
      assertNear(enclosing[1]?.actual.cutM2, areaOf(large) - areaOf(small), "the large opening cuts only what the small one left", NEAR_M2);
      for (const entry of enclosing) {
        assertNear(entry.actual.floorAreaAfterCallM2, floorAreaNow - areaOf(large), "the floor after the call has lost the large opening, and no more", NEAR_M2);
      }
      assert.deepEqual((await elementsOf(client, enclosing.map((entry) => entry.id))).notFound, [], "both openings are in the model");
      assert.equal(countOf(await modelInfo(client), "OST_FloorOpening"), countOf(infoAfter, "OST_FloorOpening") + 3);
    });
  });

  it("a floor takes two openings in one call, and the second sees what the first left", async () => {
    await withClient(async (client) => {
      const w = ready();
      const y = scene();
      const floorRect: Rect = { x0: 0, y0: y, x1: 12000, y1: y + 6000 };
      const first: Rect = { x0: 1000, y0: y + 1000, x1: 3000, y1: y + 3000 };
      const second: Rect = { x0: 6000, y0: y + 1000, x1: 7000, y1: y + 4000 };
      const third: Rect = { x0: 9000, y0: y + 2000, x1: 11000, y1: y + 3000 };
      const floor = await makeFloor(client, floorRect, w.floorType.id);
      const full = areaOf(floorRect);

      const made = created(await openings(client, [{ floorId: floor.id, boundaryMm: rectangle(first) }, { floorId: floor.id, boundaryMm: rectangle(second) }]));
      assert.equal(made.length, 2);
      assert.notEqual(made[0]?.id, made[1]?.id, "two openings, two elements");
      console.log(`# two openings: ${JSON.stringify(made.map((entry) => entry.actual))}`);

      assertNear(made[0]?.actual.areaBeforeM2, full, "area before the first", NEAR_M2);
      assertNear(made[0]?.actual.areaAfterM2, full - areaOf(first), "area after the first", NEAR_M2);
      assertNear(made[1]?.actual.areaBeforeM2, full - areaOf(first), "the second starts from what the first left", NEAR_M2);
      assertNear(made[1]?.actual.areaAfterM2, full - areaOf(first) - areaOf(second), "area after the second", NEAR_M2);
      for (const entry of made) {
        assert.equal(entry.actual.floorId, floor.id);
        assertNear(entry.actual.floorAreaAfterCallM2, full - areaOf(first) - areaOf(second), "the area of the floor after the call is the same for both", NEAR_M2);
      }

      // Items for two floors in one list, and a third opening for the first floor in another call.
      const other = await makeFloor(client, { x0: 20000, y0: y, x1: 24000, y1: y + 4000 }, w.floorType.id);
      const mixed = created(
        await openings(client, [
          { floorId: other.id, boundaryMm: rectangle({ x0: 21000, y0: y + 1000, x1: 22000, y1: y + 2000 }) },
          { floorId: floor.id, boundaryMm: rectangle(third) },
        ]),
      );
      assert.equal(mixed[0]?.actual.floorId, other.id);
      assertNear(mixed[0]?.actual.areaBeforeM2, 16, "the other floor", NEAR_M2);
      assert.equal(mixed[1]?.actual.floorId, floor.id);
      assertNear(mixed[1]?.actual.areaBeforeM2, full - areaOf(first) - areaOf(second), "the first floor starts from what its two openings left", NEAR_M2);
      assertNear(mixed[1]?.actual.floorAreaAfterCallM2, full - areaOf(first) - areaOf(second) - areaOf(third), "the first floor with three openings", NEAR_M2);
    });
  });

  it("ground whose top is above the underside of the floor keeps the overlap warning in the result", async () => {
    await withClient(async (client) => {
      const w = ready();

      // The floor lies 300 thick below its level. A ground whose top is on the level reaches into it.
      const overlapping = scene();
      const floorRect: Rect = { x0: 0, y0: overlapping, x1: 8000, y1: overlapping + 6000 };
      const floor = await makeFloor(client, floorRect, w.floorType.id);
      assertNear(floor.actual.boundingBoxMm?.min.z, -FLOOR_THICKNESS_MM, "the underside of the floor");
      const groundRect: Rect = { x0: -5000, y0: overlapping - 5000, x1: 13000, y1: overlapping + 11000 };

      const high = await grounds(client, [{ boundaryMm: rectangle(groundRect), levelId: w.ground.id, topOffsetMm: 0, typeId: w.meadow.id }]);
      console.log(`# the ground above the underside of the floor: ${JSON.stringify(high)}`);
      assert.equal(high.committed, true, JSON.stringify(high));
      assert.equal(high.items[0]?.status, "created");
      assert.deepEqual(high.errors, []);
      assert.deepEqual(high.dialogs, []);
      assert.equal(high.warnings.length, 1, JSON.stringify(high.warnings));
      assert.match(high.warnings[0] ?? "", /toposolid and floor overlap/);
      const highId = high.items[0]?.elementId;
      assert.ok(highId);

      // Revit still holds the warning, for these two elements.
      const held = (await warningsOf(client)).filter((warning) => warning.definitionId === OVERLAP_WARNING_ID);
      assert.equal(held.length, 1, JSON.stringify(held));
      assert.deepEqual([...(held[0]?.elementIds ?? [])].sort(), [floor.id, highId].sort());

      // A ground whose top is below the underside of the floor, 400 under a floor that reaches down 300, gives none.
      const clear = scene();
      const clearFloor = await makeFloor(client, { x0: 0, y0: clear, x1: 8000, y1: clear + 6000 }, w.floorType.id);
      const [low] = created(await grounds(client, [{ boundaryMm: rectangle({ x0: -5000, y0: clear - 5000, x1: 13000, y1: clear + 11000 }), levelId: w.ground.id, topOffsetMm: -400, typeId: w.meadow.id }]));
      assert.ok(low);
      assertNear(low.actual.topOffsetMm, -400, "the top offset read back");
      assertNear(low.actual.boundingBoxMm?.max.z, -400, "the top of the ground in the model");
      const everything = await warningsOf(client);
      assert.equal(everything.some((warning) => warning.elementIds.includes(low.id) || warning.elementIds.includes(clearFloor.id)), false, "no warning for the ground below the floor");

      // The top is read back from the model whatever it is: above the level, and far below it. Nothing stands here, so nothing overlaps.
      const free = scene();
      const [up, down] = created(
        await grounds(client, [
          { boundaryMm: rectangle({ x0: 0, y0: free, x1: 10000, y1: free + 10000 }), levelId: w.ground.id, topOffsetMm: 150.5, typeId: w.meadow.id },
          { boundaryMm: rectangle({ x0: 20000, y0: free, x1: 30000, y1: free + 10000 }), levelId: w.upper.id, topOffsetMm: -1000, typeId: w.groundTypes[0]!.id },
        ]),
      );
      assert.ok(up && down);
      assertNear(up.actual.topOffsetMm, 150.5, "a top above the level");
      assertNear(up.actual.boundingBoxMm?.max.z, 150.5, "the top of that ground in the model");
      assertNear(down.actual.topOffsetMm, -1000, "a top below the upper level");
      assertNear(down.actual.boundingBoxMm?.max.z, UPPER_LEVEL_MM - 1000, "the top of that ground, from the upper level");
      assert.equal(up.actual.levelId, w.ground.id);
      assert.equal(down.actual.levelId, w.upper.id);

      const listed = await elementsOf(client, [up.id, down.id]);
      assert.deepEqual(listed.elements.map((element) => element.category), ["toposolid", "toposolid"]);
    });
  });

  it("house stands on the ground in a snapshot", async () => {
    await withClient(async (client) => {
      const house = await buildHouse(client, "дом-на-земле", WALL_BASE_MM);
      assertLanded(house.groundBatch);

      // In the model, the feet of the walls and the top of the ground are one height.
      console.log(`# feet of the walls ${JSON.stringify(house.feet)}, top of the ground ${String(house.groundTopMm)}`);
      for (const foot of house.feet) {
        assertNear(foot, WALL_BASE_MM, "the foot of a wall");
        assertNear(foot, house.groundTopMm, "the foot of the wall against the top of the ground");
      }

      // In the picture: the checks of houseChecks, each of which is told apart from the others by what its controls do (see below).
      const checks = houseChecks(house.south, house.scene);
      for (const check of checks) {
        console.log(`# ${check.ok ? "passes" : "FAILS"}: ${check.name}: ${check.detail}`);
      }
      assert.deepEqual(
        checks.filter((check) => !check.ok).map((check) => `${check.name}: ${check.detail}`),
        [],
      );
    });
  });

  it("a ground at the wrong height fails the picture of the house, and the far edge is what tells them apart", async () => {
    await withClient(async (client) => {
      // The same house with the ground top at 0, where the ground covers the foot of the wall and overlaps the floor, and at -2400, which
      // is 2000 below the foot. The failing checks are pinned as measured: scenes and camera are the same on every run, so are the pixels.
      const controls: Array<[string, number, string[]]> = [
        ["дом-земля-0", 0, [CHECK.wallRows, CHECK.farEdge]],
        ["дом-земля-минус-2400", -2400, [CHECK.besideLeft, CHECK.besideRight, CHECK.farEdge]],
      ];

      for (const [title, groundTop, expected] of controls) {
        const house = await buildHouse(client, title, groundTop);
        assertNear(house.groundTopMm, groundTop, `${title}: the top of the ground in the model`);
        assertNear(house.feet[0], WALL_BASE_MM, `${title}: the foot of the wall`);
        assert.equal(house.groundBatch.committed, true, JSON.stringify(house.groundBatch));
        assert.equal(house.groundBatch.items[0]?.status, "created");

        // Revit holds that ground at 0 overlaps the floor, and says so. The one at -2400 gives nothing to warn of.
        if (groundTop === 0) {
          assert.equal(house.groundBatch.warnings.length, 1, JSON.stringify(house.groundBatch.warnings));
          assert.match(house.groundBatch.warnings[0] ?? "", /toposolid and floor overlap/);
        } else {
          assert.deepEqual(house.groundBatch.warnings, []);
        }

        const checks = houseChecks(house.south, house.scene);
        for (const check of checks) {
          console.log(`# ${title}: ${check.ok ? "passes" : "FAILS"}: ${check.name}: ${check.detail}`);
        }
        assert.deepEqual(
          checks.filter((check) => !check.ok).map((check) => check.name),
          expected,
          `${title}: the checks that fail`,
        );
      }
    });
  });

  it("an opening over the whole floor lands and leaves nothing of the floor, while Revit warns that it cuts nothing", async () => {
    await withClient(async (client) => {
      const w = ready();
      const y = scene();
      const floorRect: Rect = { x0: 0, y0: y, x1: 10000, y1: y + 8000 };
      const floor = await makeFloor(client, floorRect, w.redFloor);
      created(await grounds(client, [{ boundaryMm: rectangle({ x0: -25000, y0: y - 25000, x1: 35000, y1: y + 35000 }), levelId: w.ground.id, topOffsetMm: -400, typeId: w.meadow.id }]));
      const whole = frameOf(await fromAbove(client, "всё-до", floorRect), floorRect);

      // An outline larger than the floor on every side. Pinned as Revit does it today, and the answer of the tool is true to the model:
      // the area is 0, and the opening is there. What is wrong is Revit's warning, which says that the opening cuts nothing.
      const over: Rect = { x0: -1000, y0: y - 1000, x1: 11000, y1: y + 9000 };
      const batch = await openings(client, [{ floorId: floor.id, boundaryMm: rectangle(over) }]);
      console.log(`# an opening over the whole floor: ${JSON.stringify({ ...batch, items: batch.items.map((item) => ({ ...item, actual: item.actual && { ...item.actual, boundaryMm: undefined } })) })}`);
      assert.equal(batch.committed, true, JSON.stringify(batch));
      assert.deepEqual(batch.errors, []);
      assert.deepEqual(batch.dialogs, []);
      assert.equal(batch.items[0]?.status, "created");
      assertNear(batch.items[0]?.actual?.areaBeforeM2, areaOf(floorRect), "area before", NEAR_M2);
      assertNear(batch.items[0]?.actual?.areaAfterM2, 0, "area after", NEAR_M2);
      assertNear(batch.items[0]?.actual?.cutM2, areaOf(floorRect), "the whole floor is cut", NEAR_M2);
      assertNear(batch.items[0]?.actual?.floorAreaAfterCallM2, 0, "area of the floor after the call", NEAR_M2);
      assert.equal(batch.warnings.length, 1, JSON.stringify(batch.warnings));
      assert.match(batch.warnings[0] ?? "", /not cutting anything/);

      // The floor is still an element of the model, and its box in get_elements is the old one, as the box of a wall cut by a roof is.
      const read = await elementsOf(client, [floor.id]);
      assert.deepEqual(read.notFound, []);
      for (const corner of ["min", "max"] as const) {
        for (const axis of ["x", "y", "z"] as const) {
          assertNear(read.elements[0]?.boundingBoxMm?.[corner][axis], floor.actual.boundingBoxMm?.[corner][axis] as number, `the box of the emptied floor, ${corner}.${axis}`);
        }
      }

      // In the picture nothing of the floor is left: the ground shows where it was, and the red is gone.
      const after = await fromAbove(client, "всё-после", floorRect);
      assert.equal(boundsOfBand(after, "red"), null, "no red is left in the picture");
      assertGrass(after, planRegion(whole, floorRect, 0.1), "the ground shows where the floor was");

      // A later opening on that floor cuts nothing, and fails as it does anywhere.
      const later = await openings(client, [{ floorId: floor.id, boundaryMm: rectangle({ x0: 1000, y0: y + 1000, x1: 2000, y1: y + 2000 }) }]);
      assert.equal(later.committed, false);
      assert.equal(later.items[0]?.status, "failed");
      assert.match(later.items[0]?.error ?? "", /has 0 m² after it, and had 0 m² before/);

      // An outline that is exactly the outline of the floor does the same.
      const second: Rect = { x0: 20000, y0: y, x1: 26000, y1: y + 4000 };
      const other = await makeFloor(client, second, w.floorType.id);
      const same = await openings(client, [{ floorId: other.id, boundaryMm: rectangle(second) }]);
      assert.equal(same.committed, true, JSON.stringify(same));
      assert.equal(same.items[0]?.status, "created");
      assertNear(same.items[0]?.actual?.areaAfterM2, 0, "the same outline: area after", NEAR_M2);
      assert.equal(same.warnings.length, 1, JSON.stringify(same.warnings));
      assert.match(same.warnings[0] ?? "", /not cutting anything/);
    });
  });

  it("bad ceilings, openings and ground fail before any change", async () => {
    await withClient(async (client) => {
      const w = ready();
      const y = scene();
      const outline = rectangle({ x0: 0, y0: y, x1: 4000, y1: y + 3000 });
      const floor = await makeFloor(client, { x0: 0, y0: y, x1: 4000, y1: y + 3000 }, w.floorType.id);
      const goodCeiling = { boundaryMm: outline, typeId: w.basicCeiling.id, levelId: w.ground.id, heightOffsetMm: 2350 };
      const goodOpening = { floorId: floor.id, boundaryMm: rectangle({ x0: 1000, y0: y + 1000, x1: 2000, y1: y + 2000 }) };
      const goodGround = { boundaryMm: outline, levelId: w.ground.id, topOffsetMm: -400, typeId: w.meadow.id };
      const bowtie = [{ x: 0, y: y }, { x: 4000, y: y + 3000 }, { x: 4000, y }, { x: 0, y: y + 3000 }];
      const { heightOffsetMm: _height, ...noHeight } = goodCeiling;
      const { topOffsetMm: _top, ...noTop } = goodGround;

      await saved(client);
      const before = await modelInfo(client);
      const typesBefore = [await listTypes(client, "ceilings"), await listTypes(client, "toposolid")];

      const requests: Array<[string, string, object, object, RegExp]> = [
        ["create_ceilings", "no height offset", goodCeiling, noHeight, /heightOffsetMm must be a number\./],
        ["create_ceilings", "a height offset in text", goodCeiling, { ...goodCeiling, heightOffsetMm: "2350" }, /heightOffsetMm must be a number, not "2350"/],
        ["create_ceilings", "a height offset of null", goodCeiling, { ...goodCeiling, heightOffsetMm: null }, /heightOffsetMm must be a number/],
        ["create_ceilings", "a floor type for a ceiling", goodCeiling, { ...goodCeiling, typeId: w.floorType.id }, /typeId .* is not a type of ceilings/],
        ["create_ceilings", "a type id that is no id", goodCeiling, { ...goodCeiling, typeId: "потолок" }, /typeId .* is not a type of ceilings/],
        ["create_ceilings", "a level that is a type", goodCeiling, { ...goodCeiling, levelId: w.floorType.id }, /levelId .* is not a level/],
        ["create_ceilings", "two points", goodCeiling, { ...goodCeiling, boundaryMm: outline.slice(0, 2) }, /boundaryMm must be a list of at least 3 points/],
        ["create_ceilings", "an outline that crosses itself", goodCeiling, { ...goodCeiling, boundaryMm: bowtie }, /Revit does not take boundaryMm as an outline/],
        ["create_ceilings", "the first point repeated", goodCeiling, { ...goodCeiling, boundaryMm: [...outline, outline[0]] }, /closer than/],
        ["create_floor_openings", "a floor id that is a type", goodOpening, { ...goodOpening, floorId: w.floorType.id }, /floorId .* is not one of the floors of this model/],
        ["create_floor_openings", "a floor id that is a ceiling", goodOpening, { ...goodOpening, floorId: w.ceilingIds[0] }, /floorId .* is not one of the floors of this model/],
        ["create_floor_openings", "a floor id that is no number", goodOpening, { ...goodOpening, floorId: "пол" }, /floorId .* is not one of the floors of this model/],
        ["create_floor_openings", "a floor id that is no text", goodOpening, { ...goodOpening, floorId: 12 }, /floorId must be an element id, as text/],
        ["create_floor_openings", "no floor id", goodOpening, { boundaryMm: goodOpening.boundaryMm }, /floorId must be an element id, as text/],
        ["create_floor_openings", "an outline that crosses itself", goodOpening, { ...goodOpening, boundaryMm: bowtie }, /Revit does not take boundaryMm as an outline/],
        ["create_floor_openings", "two points", goodOpening, { ...goodOpening, boundaryMm: outline.slice(0, 2) }, /boundaryMm must be a list of at least 3 points/],
        ["create_ground", "a floor type for ground", goodGround, { ...goodGround, typeId: w.floorType.id }, /typeId .* is not a type of toposolid/],
        ["create_ground", "no top offset", goodGround, noTop, /topOffsetMm must be a number\./],
        ["create_ground", "a top offset in text", goodGround, { ...goodGround, topOffsetMm: "-400" }, /topOffsetMm must be a number, not "-400"/],
        ["create_ground", "a level that is a type", goodGround, { ...goodGround, levelId: w.meadow.id }, /levelId .* is not a level/],
        ["create_ground", "an outline that crosses itself", goodGround, { ...goodGround, boundaryMm: bowtie }, /Revit does not take boundaryMm as an outline/],
      ];

      for (const [method, what, good, bad, message] of requests) {
        const refused = await refusal(client, method, { items: [good, bad] });
        console.log(`# ${method}, ${what}: ${refused.message.slice(0, 200)}`);
        assert.match(refused.message, message, `${method}, ${what}`);
        assert.match(refused.message, /item 1/, `${method}, ${what}: the refusal should name the item`);
      }

      for (const method of ["create_ceilings", "create_floor_openings", "create_ground"]) {
        await refusal(client, method, { items: [] });
        await refusal(client, method, {});
      }

      // The good item before each bad one was not made, and nothing is left to save.
      const after = await modelInfo(client);
      for (const category of ["OST_Ceilings", "OST_FloorOpening", "OST_Toposolid", "OST_Floors"]) {
        assert.equal(countOf(after, category), countOf(before, category), category);
      }
      assert.deepEqual([await listTypes(client, "ceilings"), await listTypes(client, "toposolid")], typesBefore);
      assert.equal(await isModified(client), false, "a refused call changes nothing");
    });
  });

  it("one call is one Undo step, for ceilings, openings and ground", { timeout: 450_000 }, async (t) => {
    await withClient(async (client) => {
      const w = ready();
      const y = scene();
      const floorRect: Rect = { x0: 0, y0: y, x1: 8000, y1: y + 5000 };
      const hole: Rect = { x0: 2000, y0: y + 1000, x1: 4000, y1: y + 3000 };
      const floor = await makeFloor(client, floorRect, w.floorType.id);

      const [ceiling] = created(await ceilings(client, [{ boundaryMm: rectangle({ x0: 0, y0: y, x1: 4000, y1: y + 3000 }), typeId: w.basicCeiling.id, levelId: w.ground.id, heightOffsetMm: 2350 }]));
      const [opening] = created(await openings(client, [{ floorId: floor.id, boundaryMm: rectangle(hole) }]));
      const [meadow] = created(
        await grounds(client, [{ boundaryMm: rectangle({ x0: -9000, y0: y - 9000, x1: 17000, y1: y + 14000 }), levelId: w.ground.id, topOffsetMm: -400, typeId: w.meadow.id }]),
      );
      assert.ok(ceiling && opening && meadow);

      const ground = await undoWithOneRetry(t, client);
      console.log(`# undo of create_ground: ${JSON.stringify(ground)}`);
      assert.equal(ground.state, "undone", JSON.stringify(ground));
      assert.equal(ground.transactionName, "MCP: create_ground");
      assert.ok(ground.createdIds.includes(meadow.id), `${meadow.id} should be among the created ids of the undo`);
      assert.deepEqual((await elementsOf(client, [meadow.id])).notFound, [meadow.id]);

      // The opening comes off alone, and the floor is whole again: an opening cut next starts from the full area.
      const cut = await undoWithOneRetry(t, client);
      assert.equal(cut.transactionName, "MCP: create_floor_openings");
      assert.ok(cut.createdIds.includes(opening.id), `${opening.id} should be among the created ids of the undo`);
      assert.deepEqual((await elementsOf(client, [opening.id])).notFound, [opening.id]);
      const [again] = created(await openings(client, [{ floorId: floor.id, boundaryMm: rectangle(hole) }]));
      assert.ok(again);
      assertNear(again.actual.areaBeforeM2, areaOf(floorRect), "the floor is whole after the undo", NEAR_M2);

      // Undoing that last opening is the next step, and the ceiling is the one after.
      const last = await undoWithOneRetry(t, client);
      assert.equal(last.transactionName, "MCP: create_floor_openings");
      const hung = await undoWithOneRetry(t, client);
      assert.equal(hung.transactionName, "MCP: create_ceilings");
      assert.ok(hung.createdIds.includes(ceiling.id), `${ceiling.id} should be among the created ids of the undo`);
      assert.deepEqual((await elementsOf(client, [ceiling.id])).notFound, [ceiling.id]);
      assert.equal((await elementsOf(client, [floor.id])).notFound.length, 0, "the floor made before is still there");
    });
  });

  it("leaves Revit in a state the close rule accepts", async () => {
    await withClient(async (client) => {
      await client.call("save_project", {});
      assert.deepEqual(checkCanClose((await modelInfo(client)).openDocuments), { ok: true, reasons: [] });
    });
  });
});
