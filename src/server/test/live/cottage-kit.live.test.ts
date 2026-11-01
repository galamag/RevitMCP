import assert from "node:assert/strict";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";

import { checkCanClose } from "../../src/cli/closeRule.ts";
import { BridgeClient } from "../../src/client.ts";
import { defaultConnectionPath } from "../../src/connection.ts";
import { boundsOfBand, decodePng, meanColour, reportColours, reportHues, type Region } from "../pngPixels.ts";
import { undoWithOneRetry } from "../undoRetry.ts";

// The acceptance of stage 3: every tool of the cottage kit used on one small two-storey house, in the order the cottage will be built in.
// It needs a running Revit with the RevitMCP plugin loaded. Each run creates one new project in the test folder and leaves it open and
// saved, so the house can be looked at afterwards. The house is 8 x 7 m between the axes of its walls. The ground floor is one space
// that a room separator divides into a living room and a kitchen, with a U-shaped staircase in the living room. The upper floor has a
// bedroom, which holds the stairwell, and a bathroom behind a partition with a door.
//
// What it cannot do: no tool switches the view that Revit has open, so a room separator drawn while a 3D view is the active one is checked by hand.
//
//   y 7000  +--------------------------------+
//           |                  .             |
//           |    living room   .   kitchen   |        ground floor, the dotted line is the room separator at x 5000
//           |                  .             |
//   y 1500  |  stairs          .             |
//   y 0     +------------+---door------------+
//           x 0                              x 8000
//
//   y 7000  +--------------------------------+
//           |   bedroom                      |
//   y 3500  |                +---------------+
//           |   stairwell    |   bathroom    |        upper floor, partitions at x 5500 and y 3500
//   y 0     +----------------+---------------+

interface Point {
  x: number;
  y: number;
}

interface Point3 extends Point {
  z: number;
}

interface Box {
  min: Point3;
  max: Point3;
}

interface Level {
  id: string;
  name: string;
  elevationMm: number;
}

interface OpenDocument {
  title: string;
  path: string;
  isModified: boolean;
}

interface ModelInfo {
  activeDocument: OpenDocument | null;
  openDocuments: OpenDocument[];
  levels: Level[];
  views: Array<{ id: string; name: string; viewType: string }>;
  categoryCounts: Array<{ category: string | null; count: number }>;
}

interface TypeRow {
  id: string;
  family: string;
  name: string;
}

interface ElementRow {
  id: string;
  category: string | null;
  typeName: string | null;
  levelId: string | null;
  boundingBoxMm: Box | null;
  topMm?: number | null;
  name?: string;
  number?: string;
  areaM2?: number;
}

interface ElementsAnswer {
  elements: ElementRow[];
  notFound: string[];
  truncated: boolean;
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

interface WallActual {
  startMm: Point;
  endMm: Point;
  lengthMm: number;
  heightMm: number;
  widthMm: number;
  baseOffsetMm: number;
  typeId: string;
  levelId: string;
  topLevelId: string | null;
}

interface AreaActual {
  areaM2: number;
  heightOffsetMm: number;
  typeId: string;
  levelId: string;
  boundingBoxMm: Box | null;
}

interface StairsActual {
  risers: number;
  riserHeightMm: number;
  treadDepthMm: number;
  topElevationMm: number;
  footprintMm: Point[];
  railingIds: string[];
}

interface OpeningActual {
  floorId: string;
  areaBeforeM2: number;
  areaAfterM2: number;
  cutM2: number;
  floorAreaAfterCallM2: number;
}

interface RailingActual {
  hostId: string | null;
  railings: Array<{ id: string; typeId: string; typeName: string }>;
  pathMm: Point[] | null;
  elevationMm: number | null;
}

interface RoofEdge {
  definesSlope: boolean;
  slopeDeg: number | null;
}

interface FamilyActual {
  familyId: string;
  typeIds: Array<{ id: string; name: string; widthMm: number | null; heightMm: number | null }>;
}

interface HostedActual {
  hostId: string | null;
  offsetAlongWallMm: number;
  sillHeightMm: number | null;
  fromRoomId: string | null;
  toRoomId: string | null;
  cutsWall: boolean;
}

interface InstanceActual {
  typeId: string;
  pointMm: Point;
  elevationMm: number;
  rotationDeg: number;
  levelId: string;
  hostWallId: string | null;
  facingFlipped: boolean;
}

interface RoomActual {
  name: string;
  number: string;
  areaM2: number;
  perimeterMm: number;
}

interface UpdateActual {
  pointMm: Point3 | null;
  parameters: unknown[];
}

interface Warning {
  definitionId: string;
  text: string;
  elementIds: string[];
  additionalElementIds: string[];
}

/** A warning the test lets through, with the reason. Anything that matches none of them fails the test. */
interface Allowance {
  pattern: RegExp;
  why: string;
}

interface Opening {
  what: string;
  kind: "door" | "window";
  wallId: string;
  item: Landed<HostedActual>;
}

// The library of this machine, the same folder as LibraryFolder.Root in the plugin.
const DOOR = "Russia\\Двери\\Дверь-Одинарная-Панель.rfa";
const WINDOW = "Russia\\Окна\\Окно-закрепленное.rfa";
const SOFA = "Russia\\Мебель\\Сиденье\\Диван.rfa";
const DINING_TABLE = "Russia\\Мебель\\Столы\\Стол-Обеденный.rfa";
const BED = "Russia\\Мебель\\Кровати\\Кровать-Стандарт.rfa";
const WC = "Russia\\Сантехника\\Архитектурные\\Приборы\\Унитазы\\Туалет-Домашний-3D.rfa";
const SINK = "Russia\\Сантехника\\Архитектурные\\Приборы\\Раковины\\Раковина-Одиночная-2D.rfa";
const BATH = "Russia\\Сантехника\\Архитектурные\\Приборы\\Ванны\\Ванна-Прямоугольная-3D.rfa";

/** The rows of the type catalogs, which the library fixes. The sizes are written on the types by load_family, because Revit ignores the catalog columns. */
const ENTRANCE_DOOR = { typeName: "900 x 2100 мм", widthMm: 900, heightMm: 2100 };
const INNER_DOOR = { typeName: "800 x 2100 мм", widthMm: 800, heightMm: 2100 };
const BIG_WINDOW = { typeName: "900 x 1200 мм", widthMm: 900, heightMm: 1200 };
const SMALL_WINDOW = { typeName: "600 x 900 мм", widthMm: 600, heightMm: 900 };

const NEAR_MM = 0.01;
/** Areas come back in square metres with the noise of feet: far above it, far below any real difference. */
const NEAR_M2 = 0.001;
/** How close a height read from a wall that follows a roof should be, as roofs round to Revit's own tolerance. */
const ROOF_NEAR_MM = 2;
const SLOPE_NEAR_DEG = 0.001;

/** The house, in millimetres. The outline runs along the axes of the exterior walls. */
const WIDTH_MM = 8000;
const DEPTH_MM = 7000;
const SECOND_FLOOR_MM = 3000;
const EAVES_MM = 5700;
const EXTERIOR_MM = 200;
const PARTITION_MM = 100;
const FLOOR_MM = 300;
/** The land lies this far below the first floor, and the walls reach down to it. Past the thickness of the floor, or Revit warns that two floors overlap. */
const PLINTH_MM = 400;
const LAND_MARGIN_MM = 40000;
const SLOPE_DEG = 30;
/** Wider than half an exterior wall, so the whole thickness of the walls lies under the roof and they can follow it. */
const OVERHANG_MM = 600;

/** The separator runs from the axis of the south wall to the axis of the north wall, and divides the ground floor. */
const SEPARATOR_X_MM = 5000;
/** The bathroom of the upper floor is the corner x from 5500 and y up to 3500, walled by two partitions. */
const BATH_X_MM = 5500;
const BATH_Y_MM = 3500;

/** The U-shaped stairs: the axis of the first run, where it starts, and the other numbers of the default type. */
const STAIRS_X_MM = 600;
const STAIRS_Y_MM = 1500;
const STAIRS_WIDTH_MM = 1000;
const RISERS = 16;
const TREAD_MM = 250;
const RUN_PITCH_MM = STAIRS_WIDTH_MM + 100;
const FIRST_RUN_MM = (RISERS / 2 - 1) * TREAD_MM;

const CEILING_GROUND_MM = 2650;
const CEILING_UPPER_MM = 2500;

/** The hues of the meadow in the picture, in degrees: it measured 77 to 87, and the shadows on it stay in that range. */
const MEADOW_HUE = { from: 60, to: 110 };
const SNAPSHOT_WIDTH_PX = 1600;
const VIEW_NAME = "Малый дом с юго-востока";
const EYE_MM = { x: 16000, y: -12000, z: 7500 };
const TARGET_MM = { x: 4000, y: 3500, z: 3300 };

/**
 * The one warning of a call that this house allows. A row of a type catalog has Russian column names, Revit does not find them in the family
 * and says so for each one. The text of load_family says that Revit reports the ignored columns at the top and that this is expected for a catalog,
 * and the plan, task 6, says the same: the catalog ignores Width and Height, so the sizes are written by the caller.
 */
const CATALOG_COLUMNS: Allowance = {
  pattern: /^The parameter .+ doesn't exist in the Family\. It will be ignored\.$/,
  why: "load_family: Revit ignores the size columns of a type catalog, as the tool text and the plan say",
};

const stamp = new Date().toTimeString().slice(0, 8).replaceAll(":", "");
const name = `малый-дом-приёмка-${stamp}`;
const snapshotFolder = path.join(homedir(), "Documents", "RevitMCP", "task13-acceptance");

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

function assertNear(actual: unknown, expected: number, what: string, within = NEAR_MM): void {
  assert.equal(typeof actual, "number", what);
  assert.ok(Math.abs((actual as number) - expected) < within, `${what}: ${String(actual)}, expected ${expected}`);
}

/**
 * Everything landed with the status asked for, and the items are returned. A warning of Revit, at the top or on an item, fails the call
 * unless one of the allowances names it: this house should give Revit nothing to warn about, and the allowances say why where it does.
 */
function landed<A>(batch: Batch<A>, status: string, allowed: Allowance[] = []): Array<Landed<A>> {
  assert.equal(batch.committed, true, JSON.stringify(batch).slice(0, 1800));
  assert.deepEqual(batch.errors, []);
  assert.deepEqual(batch.dialogs, []);

  const unnamed = (warnings: string[]): string[] => warnings.filter((warning) => !allowed.some((allowance) => allowance.pattern.test(warning)));
  const letThrough = (warnings: string[]): void => {
    for (const warning of warnings) {
      const allowance = allowed.find((candidate) => candidate.pattern.test(warning));
      if (allowance) {
        console.log(`# warning let through (${allowance.why}): ${warning}`);
      }
    }
  };
  letThrough(batch.warnings);
  assert.deepEqual(unnamed(batch.warnings), [], "Revit warned about something that no allowance names");

  return batch.items.map((item) => {
    assert.equal(item.status, status, JSON.stringify(item).slice(0, 1200));
    assert.ok(item.elementId && item.actual, JSON.stringify(item).slice(0, 1200));
    letThrough(item.warnings);
    assert.deepEqual(unnamed(item.warnings), [], `item ${item.index}: Revit warned about something that no allowance names`);
    return item as Landed<A>;
  });
}

/** The one item of a call that made one. */
function only<A>(items: Array<Landed<A>>): Landed<A> {
  assert.equal(items.length, 1);
  return items[0]!;
}

async function typeNamed(client: BridgeClient, category: string, pattern: RegExp): Promise<TypeRow> {
  const found = (await listTypes(client, category)).find((type) => pattern.test(type.name));
  assert.ok(found, `no ${category} type matches ${String(pattern)}`);

  return found;
}

const rectangle = (x0: number, y0: number, x1: number, y1: number): Point[] => [
  { x: x0, y: y0 },
  { x: x1, y: y0 },
  { x: x1, y: y1 },
  { x: x0, y: y1 },
];

/** The area inside a polygon in square metres, by the shoelace sum. */
function areaM2(points: Point[]): number {
  let twice = 0;
  for (const [index, from] of points.entries()) {
    const to = points[(index + 1) % points.length]!;
    twice += from.x * to.y - to.x * from.y;
  }

  return Math.abs(twice) / 2 / 1_000_000;
}

function boxAround(points: Point[]): { minX: number; maxX: number; minY: number; maxY: number } {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);

  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

const tan = (degrees: number): number => Math.tan((degrees * Math.PI) / 180);

const countOf = (info: ModelInfo, category: string): number => info.categoryCounts.find((entry) => entry.category === category)?.count ?? 0;

/** What the model holds in each category the tools make, as get_elements lists it. */
const CATEGORIES = {
  walls: "OST_Walls",
  floors: "OST_Floors",
  roofs: "OST_Roofs",
  ceilings: "OST_Ceilings",
  doors: "OST_Doors",
  windows: "OST_Windows",
  furniture: "OST_Furniture",
  plumbing: "OST_PlumbingFixtures",
  stairs: "OST_Stairs",
  railings: "OST_StairsRailing",
  toposolid: "OST_Toposolid",
  rooms: "OST_Rooms",
} as const;

type State = Record<keyof typeof CATEGORIES, ElementRow[]>;

async function houseState(client: BridgeClient): Promise<State> {
  const state = {} as State;
  for (const category of Object.keys(CATEGORIES) as Array<keyof typeof CATEGORIES>) {
    const answer = await elementsOf(client, { category });
    assert.equal(answer.truncated, false, category);
    assert.deepEqual(answer.notFound, [], category);
    state[category] = answer.elements;
  }

  return state;
}

async function loadFamilies(client: BridgeClient, items: object[]): Promise<Array<Landed<FamilyActual>>> {
  return landed(await call<FamilyActual>(client, "load_family", items), "created", [CATALOG_COLUMNS]);
}

/** The type of a loaded family by the exact name that the library fixes. */
function typeOfFamily(loaded: Landed<FamilyActual>, typeName: string): string {
  const found = loaded.actual.typeIds.find((type) => type.name === typeName);
  assert.ok(found, `no type '${typeName}' in ${JSON.stringify(loaded.actual.typeIds)}`);

  return found.id;
}

/**
 * The warnings that the finished house may leave in the model, by the id of their kind (the text is Revit's own words in the language of Revit),
 * each with the reason, checked against the plan text. None: nothing in the plan or in the tool texts says that a house built in this order keeps a
 * warning. Ground at -400 under floors 300 thick, stairs against the inner face of a wall, a railing round an opening and a room separator from wall to wall
 * all leave the list empty. A warning that shows up later is a finding, and it joins this list only with the sentence of the plan that expects it.
 */
const ALLOWED_MODEL_WARNINGS: Record<string, string> = {};

async function modelWarnings(client: BridgeClient, t: TestContext, when: string): Promise<Warning[]> {
  const warnings = (await client.call("get_warnings", {})) as Warning[];
  console.log(`# warnings ${when}: ${warnings.length}`);
  for (const warning of warnings) {
    const line = `warning ${when}: ${warning.definitionId} | ${warning.text} | elements ${warning.elementIds.join(",")} | related ${warning.additionalElementIds.join(",")}`;
    console.log(`# ${line}`);
    t.diagnostic(line);
  }

  return warnings;
}

function assertOnlyNamedWarnings(warnings: Warning[]): void {
  const unnamed = warnings.filter((warning) => !(warning.definitionId in ALLOWED_MODEL_WARNINGS));
  assert.deepEqual(
    unnamed.map((warning) => `${warning.definitionId}: ${warning.text}`),
    [],
    "the model holds a warning that the test does not name",
  );
}

describe("stage 3 acceptance: a small two-storey house", { timeout: 180_000 }, () => {
  it("builds a small two-storey house", async (t) => {
    const started = Date.now();

    await withClient(async (client) => {
      // The project, and its two levels at the origin.
      const created = (await client.call("create_project", { name })) as { path: string; dialogs: unknown[] };
      console.log(`# project: ${created.path}`);
      assert.equal(path.win32.basename(created.path), `${name}.rvt`);
      assert.deepEqual(created.dialogs, []);

      const start = await modelInfo(client);
      assert.equal(start.activeDocument?.title, name);
      const ground = start.levels.find((level) => level.elevationMm === 0);
      assert.ok(ground, `no level at the origin in ${JSON.stringify(start.levels)}`);

      // LEVELS: the floor of the upper storey, and the level at the top of the walls, which needs no plan.
      const levels = landed(
        await call<{ name: string; elevationMm: number; planViewId: string | null }>(client, "create_levels", [
          { name: "Второй этаж", elevationMm: SECOND_FLOOR_MM },
          { name: "Верх стен", elevationMm: EAVES_MM, createPlan: false },
        ]),
        "created",
      );
      console.log(`# levels: ${JSON.stringify(levels.map((level) => level.actual))}`);
      assert.deepEqual(levels.map((level) => level.actual.name), ["Второй этаж", "Верх стен"]);
      assertNear(levels[0]!.actual.elevationMm, SECOND_FLOOR_MM, "elevation of the upper floor");
      assertNear(levels[1]!.actual.elevationMm, EAVES_MM, "elevation of the top of the walls");
      assert.ok(levels[0]!.actual.planViewId, "the upper floor has a plan");
      assert.equal(levels[1]!.actual.planViewId, null, "the top of the walls has none");
      const second: Level = { id: levels[0]!.elementId, name: "Второй этаж", elevationMm: SECOND_FLOOR_MM };
      const eaves: Level = { id: levels[1]!.elementId, name: "Верх стен", elevationMm: EAVES_MM };
      const levelRows = (await modelInfo(client)).levels;
      assert.deepEqual(
        [second, eaves].map((level) => levelRows.find((row) => row.name === level.name)?.id),
        [second.id, eaves.id],
        "get_model_info lists the new levels by the ids that create_levels gave",
      );

      // MATERIALS AND TYPES: an exterior wall, a partition and a floor of our own. Their colours show in the picture.
      const wallBase = await typeNamed(client, "walls", /^Наружный - Стена из бруса толщиной 180 мм/);
      const floorBase = await typeNamed(client, "floors", /^Типовой 300мм$/);
      const roofType = await typeNamed(client, "roofs", /^Теплая крыша - Деревянный брус$/);
      const ceilingType = await typeNamed(client, "ceilings", /^Типовой$/);
      const landType = await typeNamed(client, "toposolid", /^Луг/);
      const stairsType = (await listTypes(client, "stairs")).find((type) => type.name.includes("190") && type.name.includes("250"));
      const railingType = await typeNamed(client, "railings", /^1100 мм$/);
      assert.ok(stairsType, "the template has the default type of stairs");
      console.log(`# types: ${JSON.stringify([wallBase, floorBase, roofType, ceilingType, landType, stairsType, railingType])}`);

      const colours = {
        wall: { r: 190, g: 70, b: 50 },
        partition: { r: 235, g: 230, b: 215 },
        parquet: { r: 150, g: 100, b: 60 },
        concrete: { r: 150, g: 150, b: 150 },
      };
      const materials = landed(
        await call<{ name: string; colorRgb: unknown; appearanceColorRgb: unknown }>(client, "create_materials", [
          { name: "Приёмка стена", colorRgb: colours.wall },
          { name: "Приёмка перегородка", colorRgb: colours.partition },
          { name: "Приёмка паркет", colorRgb: colours.parquet },
          { name: "Приёмка бетон", colorRgb: colours.concrete },
        ]),
        "created",
      );
      for (const [index, colour] of Object.values(colours).entries()) {
        assert.deepEqual(materials[index]?.actual.colorRgb, colour, "the colour of Shading");
        assert.deepEqual(materials[index]?.actual.appearanceColorRgb, colour, "the colour of Realistic");
      }
      const [wallMaterial, partitionMaterial, parquetMaterial, concreteMaterial] = materials.map((material) => material.elementId) as [string, string, string, string];
      assert.equal((await client.call("list_materials", {}) as Array<{ id: string; name: string }>).filter((material) => materials.some((made) => made.elementId === material.id)).length, 4);

      const types = landed(
        await call<{ category: string; name: string; widthMm: number | null; layers: Array<{ thicknessMm: number; materialId: string | null; function: string }> }>(client, "create_type", [
          { category: "walls", baseTypeId: wallBase.id, name: "Приёмка наружная стена 200", layers: [{ thicknessMm: EXTERIOR_MM, materialId: wallMaterial, function: "structure" }] },
          { category: "walls", baseTypeId: wallBase.id, name: "Приёмка перегородка 100", layers: [{ thicknessMm: PARTITION_MM, materialId: partitionMaterial, function: "structure" }] },
          {
            category: "floors",
            baseTypeId: floorBase.id,
            name: "Приёмка перекрытие 300",
            layers: [
              { thicknessMm: 20, materialId: parquetMaterial, function: "finish1" },
              { thicknessMm: FLOOR_MM - 20, materialId: concreteMaterial, function: "structure" },
            ],
          },
        ]),
        "created",
      );
      assertNear(types[0]!.actual.widthMm, EXTERIOR_MM, "total thickness of the exterior wall type");
      assertNear(types[1]!.actual.widthMm, PARTITION_MM, "total thickness of the partition type");
      assertNear(types[2]!.actual.widthMm, FLOOR_MM, "total thickness of the floor type");
      assert.deepEqual(types[2]!.actual.layers.map((layer) => [layer.materialId, layer.function]), [[parquetMaterial, "finish1"], [concreteMaterial, "structure"]]);
      const [exteriorType, partitionType, floorType] = types.map((type) => type.elementId) as [string, string, string];
      for (const [category, id, typeName] of [["walls", exteriorType, "Приёмка наружная стена 200"], ["walls", partitionType, "Приёмка перегородка 100"], ["floors", floorType, "Приёмка перекрытие 300"]] as const) {
        assert.deepEqual((await listTypes(client, category)).filter((type) => type.name === typeName).map((type) => type.id), [id], `list_types lists ${typeName} once, by the id that create_type gave`);
      }

      // GROUND: a meadow below the first floor, and the walls will reach down to it.
      const land = only(
        landed(
          await call<{ topOffsetMm: number; boundingBoxMm: Box | null }>(client, "create_ground", [
            { boundaryMm: rectangle(-LAND_MARGIN_MM, -LAND_MARGIN_MM, WIDTH_MM + LAND_MARGIN_MM, DEPTH_MM + LAND_MARGIN_MM), levelId: ground.id, topOffsetMm: -PLINTH_MM, typeId: landType.id },
          ]),
          "created",
        ),
      );
      assertNear(land.actual.topOffsetMm, -PLINTH_MM, "top of the ground");
      assertNear(land.actual.boundingBoxMm?.max.z, -PLINTH_MM, "top of the ground in its box");

      // WALLS: four exterior walls for each storey, going round counter-clockwise, and two partitions on the upper floor.
      const outline = rectangle(0, 0, WIDTH_MM, DEPTH_MM);
      const roundHouse = (typeId: string, levelId: string, topLevelId: string, baseOffsetMm: number) =>
        outline.map((startMm, index) => ({ startMm, endMm: outline[(index + 1) % outline.length], typeId, levelId, topLevelId, baseOffsetMm }));
      const groundWalls = landed(await call<WallActual>(client, "create_walls", roundHouse(exteriorType, ground.id, second.id, -PLINTH_MM)), "created");
      const upperWalls = landed(await call<WallActual>(client, "create_walls", roundHouse(exteriorType, second.id, eaves.id, 0)), "created");
      const partitions = landed(
        await call<WallActual>(client, "create_walls", [
          { startMm: { x: BATH_X_MM, y: 0 }, endMm: { x: BATH_X_MM, y: BATH_Y_MM }, typeId: partitionType, levelId: second.id, topLevelId: eaves.id },
          { startMm: { x: WIDTH_MM, y: BATH_Y_MM }, endMm: { x: BATH_X_MM, y: BATH_Y_MM }, typeId: partitionType, levelId: second.id, topLevelId: eaves.id },
        ]),
        "created",
      );
      assert.equal(groundWalls.length, 4);
      assert.equal(upperWalls.length, 4);
      for (const wall of [...groundWalls, ...upperWalls]) {
        assertNear(wall.actual.widthMm, EXTERIOR_MM, "width of an exterior wall");
      }
      for (const wall of partitions) {
        assertNear(wall.actual.widthMm, PARTITION_MM, "width of a partition");
      }
      for (const [index, wall] of groundWalls.entries()) {
        assertNear(wall.actual.heightMm, SECOND_FLOOR_MM + PLINTH_MM, `height of ground wall ${index}, from its foot`);
        assert.equal(wall.actual.topLevelId, second.id);
      }
      for (const [index, wall] of [...upperWalls, ...partitions].entries()) {
        assertNear(wall.actual.heightMm, EAVES_MM - SECOND_FLOOR_MM, `height of upper wall ${index}`);
        assert.equal(wall.actual.topLevelId, eaves.id);
      }

      // FLOORS: one on each storey, along the axes of the walls, of the type made above.
      const floors = landed(
        await call<AreaActual>(client, "create_floors", [
          { boundaryMm: outline, typeId: floorType, levelId: ground.id },
          { boundaryMm: outline, typeId: floorType, levelId: second.id },
        ]),
        "created",
      );
      const houseArea = (WIDTH_MM * DEPTH_MM) / 1_000_000;
      assertNear(floors[0]!.actual.areaM2, houseArea, "area of the ground floor", NEAR_M2);
      assertNear(floors[1]!.actual.areaM2, houseArea, "area of the upper floor", NEAR_M2);
      const upperFloorId = floors[1]!.elementId;

      // STAIRS: U-shaped, from the ground floor to the upper one. The first run goes north, the second comes back beside it.
      const stairs = only(
        landed(
          await call<StairsActual>(client, "create_stairs", [
            {
              baseLevelId: ground.id,
              topLevelId: second.id,
              typeId: stairsType.id,
              runsMm: [
                { startMm: { x: STAIRS_X_MM, y: STAIRS_Y_MM }, endMm: { x: STAIRS_X_MM, y: STAIRS_Y_MM + FIRST_RUN_MM } },
                { startMm: { x: STAIRS_X_MM + RUN_PITCH_MM, y: STAIRS_Y_MM + FIRST_RUN_MM }, endMm: { x: STAIRS_X_MM + RUN_PITCH_MM, y: STAIRS_Y_MM } },
              ],
              widthMm: STAIRS_WIDTH_MM,
              desiredRisers: RISERS,
            },
          ]),
          "created",
        ),
      );
      console.log(`# stairs: ${JSON.stringify(stairs.actual)}`);
      assert.equal(stairs.actual.risers, RISERS);
      assertNear(stairs.actual.treadDepthMm, TREAD_MM, "tread of the stairs");
      assertNear(stairs.actual.riserHeightMm, SECOND_FLOOR_MM / RISERS, "riser of the stairs");
      assertNear(stairs.actual.topElevationMm, second.elevationMm, "the stairs end at the upper floor");
      const footprint = boxAround(stairs.actual.footprintMm);
      assertNear(footprint.minX, STAIRS_X_MM - STAIRS_WIDTH_MM / 2, "west side of the stairs");
      assertNear(footprint.maxX, STAIRS_X_MM + RUN_PITCH_MM + STAIRS_WIDTH_MM / 2, "east side of the stairs");
      assertNear(footprint.minY, STAIRS_Y_MM, "foot of the stairs");
      assertNear(footprint.maxY, STAIRS_Y_MM + FIRST_RUN_MM + STAIRS_WIDTH_MM, "back of the landing");
      assert.equal(stairs.actual.railingIds.length, 2, "Revit puts a railing on each side of the stairs by itself");

      // FLOOR OPENING: cut in the floor of the upper level along the footprint that the stairs reported.
      const opening = only(landed(await call<OpeningActual>(client, "create_floor_openings", [{ floorId: upperFloorId, boundaryMm: stairs.actual.footprintMm }]), "created"));
      const stairwellM2 = areaM2(stairs.actual.footprintMm);
      assert.equal(opening.actual.floorId, upperFloorId);
      assertNear(opening.actual.areaBeforeM2, houseArea, "the floor before the opening", NEAR_M2);
      assertNear(opening.actual.cutM2, stairwellM2, "what the opening took off the floor", NEAR_M2);
      assertNear(opening.actual.floorAreaAfterCallM2, houseArea - stairwellM2, "the floor after the opening", NEAR_M2);

      // RAILING along the opening on the upper floor: three sides, and the fourth stays open where the stairs arrive, at the south edge.
      const railingPath = [
        { x: footprint.minX, y: footprint.minY },
        { x: footprint.minX, y: footprint.maxY },
        { x: footprint.maxX, y: footprint.maxY },
        { x: footprint.maxX, y: footprint.minY },
      ];
      const guard = only(landed(await call<RailingActual>(client, "create_railings", [{ pathMm: railingPath, typeId: railingType.id, levelId: second.id }]), "created"));
      assert.equal(guard.actual.hostId, null);
      assert.equal(guard.actual.railings.length, 1);
      assert.equal(guard.actual.railings[0]?.typeId, railingType.id);
      assertNear(guard.actual.elevationMm, second.elevationMm, "the railing stands on the upper floor", 0.1);

      // ROOF AND ATTACH: a gable roof on the level at the top of the walls with the ridge running east to west, and the upper walls follow it.
      const roof = only(
        landed(
          await call<{ edges: RoofEdge[]; boundingBoxMm: Box | null }>(client, "create_roof", [
            { outlineMm: outline, levelId: eaves.id, typeId: roofType.id, overhangMm: OVERHANG_MM, edgeSlopesDeg: [SLOPE_DEG, null, SLOPE_DEG, null] },
          ]),
          "created",
        ),
      );
      assert.deepEqual(roof.actual.edges.map((edge) => edge.definesSlope), [true, false, true, false]);
      assertNear(roof.actual.edges[0]?.slopeDeg, SLOPE_DEG, "slope of the south edge", SLOPE_NEAR_DEG);
      assertNear(roof.actual.edges[2]?.slopeDeg, SLOPE_DEG, "slope of the north edge", SLOPE_NEAR_DEG);

      const roofed = [...upperWalls, ...partitions];
      const attached = landed(
        await call<{ attachedToIds: string[]; topMm: number }>(client, "attach_walls", roofed.map((wall) => ({ wallId: wall.elementId, roofId: roof.elementId }))),
        "created",
      );
      for (const item of attached) {
        assert.deepEqual(item.actual.attachedToIds, [roof.elementId]);
      }
      // The walls under the slopes (south, north) top out at their inner face, half a wall inside the axis. The gable walls (east, west) and the partitions reach the ridge.
      const ridgeMm = EAVES_MM + (DEPTH_MM / 2) * tan(SLOPE_DEG);
      const eaveWallMm = EAVES_MM + (EXTERIOR_MM / 2) * tan(SLOPE_DEG);
      const upperTops = [eaveWallMm, ridgeMm, eaveWallMm, ridgeMm, ridgeMm, ridgeMm];
      for (const [index, item] of attached.entries()) {
        assertNear(item.actual.topMm, upperTops[index]!, `top of upper wall ${index} under the roof`, ROOF_NEAR_MM);
      }

      // DOORS AND WINDOWS: their families come from the library with the sizes written on the types, and the sizes of the rows are Russian-named.
      const [entranceFamily, innerFamily, bigFamily, smallFamily] = await loadFamilies(client, [
        { path: DOOR, ...ENTRANCE_DOOR },
        { path: DOOR, ...INNER_DOOR },
        { path: WINDOW, ...BIG_WINDOW },
        { path: WINDOW, ...SMALL_WINDOW },
      ]) as [Landed<FamilyActual>, Landed<FamilyActual>, Landed<FamilyActual>, Landed<FamilyActual>];
      for (const [family, size] of [[entranceFamily, ENTRANCE_DOOR], [innerFamily, INNER_DOOR], [bigFamily, BIG_WINDOW], [smallFamily, SMALL_WINDOW]] as const) {
        const row = family.actual.typeIds.find((type) => type.name === size.typeName);
        assertNear(row?.widthMm, size.widthMm, `${size.typeName}: width`);
        assertNear(row?.heightMm, size.heightMm, `${size.typeName}: height`);
      }
      const entranceType = typeOfFamily(entranceFamily, ENTRANCE_DOOR.typeName);
      const innerType = typeOfFamily(innerFamily, INNER_DOOR.typeName);
      const bigWindow = typeOfFamily(bigFamily, BIG_WINDOW.typeName);
      const smallWindow = typeOfFamily(smallFamily, SMALL_WINDOW.typeName);

      const [south, east, north, west] = groundWalls.map((wall) => wall.elementId) as [string, string, string, string];
      const [upperSouth, upperEast, upperNorth, upperWest] = upperWalls.map((wall) => wall.elementId) as [string, string, string, string];
      const openings: Opening[] = [];

      // The walls run counter-clockwise, so the opening faces the inside. A distance counts from the start of the wall: east to west on the north wall.
      const placeOpenings = async (label: string, kind: "door" | "window", specs: Array<{ what: string; typeId: string; wallId: string; offsetAlongWallMm: number; sillHeightMm?: number }>): Promise<void> => {
        const items = landed(await call<HostedActual>(client, "place_hosted", specs.map(({ what: _what, ...spec }) => spec)), "created");
        console.log(`# ${label}: ${JSON.stringify(items.map((item) => item.actual))}`);
        for (const [index, item] of items.entries()) {
          openings.push({ what: specs[index]!.what, kind, wallId: specs[index]!.wallId, item });
        }
      };

      await placeOpenings("entrance door", "door", [{ what: "the entrance door in the south wall of the living room", typeId: entranceType, wallId: south, offsetAlongWallMm: 3600 }]);
      await placeOpenings("ground windows", "window", [
        { what: "living room, south", typeId: bigWindow, wallId: south, offsetAlongWallMm: 1800, sillHeightMm: 900 },
        { what: "kitchen, south", typeId: bigWindow, wallId: south, offsetAlongWallMm: 6500, sillHeightMm: 900 },
        { what: "kitchen, east", typeId: bigWindow, wallId: east, offsetAlongWallMm: 5200, sillHeightMm: 900 },
        { what: "kitchen, north", typeId: bigWindow, wallId: north, offsetAlongWallMm: 1500, sillHeightMm: 900 },
        { what: "living room, north", typeId: bigWindow, wallId: north, offsetAlongWallMm: 5500, sillHeightMm: 900 },
        { what: "living room, west", typeId: bigWindow, wallId: west, offsetAlongWallMm: 1500, sillHeightMm: 900 },
      ]);
      await placeOpenings("upper windows", "window", [
        { what: "bedroom, south", typeId: bigWindow, wallId: upperSouth, offsetAlongWallMm: 2500, sillHeightMm: 900 },
        { what: "bathroom, east", typeId: smallWindow, wallId: upperEast, offsetAlongWallMm: 1800, sillHeightMm: 1200 },
        { what: "bedroom, east", typeId: bigWindow, wallId: upperEast, offsetAlongWallMm: 5200, sillHeightMm: 900 },
        { what: "bedroom, north, east", typeId: bigWindow, wallId: upperNorth, offsetAlongWallMm: 2500, sillHeightMm: 900 },
        { what: "bedroom, north, west", typeId: bigWindow, wallId: upperNorth, offsetAlongWallMm: 5500, sillHeightMm: 900 },
        { what: "bedroom, west", typeId: bigWindow, wallId: upperWest, offsetAlongWallMm: 1800, sillHeightMm: 900 },
      ]);

      // CEILINGS: the ground one goes round the stairwell, which the stairs climb through, so its outline is a notch cut out of the room.
      const inner = { x0: EXTERIOR_MM / 2, y0: EXTERIOR_MM / 2, x1: WIDTH_MM - EXTERIOR_MM / 2, y1: DEPTH_MM - EXTERIOR_MM / 2 };
      assertNear(footprint.minX, inner.x0, "the stairs stand against the inner face of the west wall");
      const notched: Point[] = [
        { x: inner.x0, y: inner.y0 },
        { x: inner.x1, y: inner.y0 },
        { x: inner.x1, y: inner.y1 },
        { x: inner.x0, y: inner.y1 },
        { x: inner.x0, y: footprint.maxY },
        { x: footprint.maxX, y: footprint.maxY },
        { x: footprint.maxX, y: footprint.minY },
        { x: inner.x0, y: footprint.minY },
      ];
      const ceilings = landed(
        await call<AreaActual>(client, "create_ceilings", [
          { boundaryMm: notched, typeId: ceilingType.id, levelId: ground.id, heightOffsetMm: CEILING_GROUND_MM },
          { boundaryMm: rectangle(inner.x0, inner.y0, inner.x1, inner.y1), typeId: ceilingType.id, levelId: second.id, heightOffsetMm: CEILING_UPPER_MM },
        ]),
        "created",
      );
      const innerM2 = ((WIDTH_MM - EXTERIOR_MM) * (DEPTH_MM - EXTERIOR_MM)) / 1_000_000;
      assertNear(ceilings[0]!.actual.areaM2, innerM2 - stairwellM2, "area of the ground ceiling", NEAR_M2);
      assertNear(ceilings[1]!.actual.areaM2, innerM2, "area of the upper ceiling", NEAR_M2);
      assertNear(ceilings[0]!.actual.heightOffsetMm, CEILING_GROUND_MM, "height of the ground ceiling");
      assertNear(ceilings[1]!.actual.boundingBoxMm?.min.z, second.elevationMm + CEILING_UPPER_MM, "underside of the upper ceiling");

      // ROOMS: a separator divides the ground floor from wall to wall, then two rooms on each floor.
      const separator = only(
        landed(
          await call<{ levelId: string; startMm: Point; endMm: Point }>(client, "create_room_separators", [
            { levelId: ground.id, startMm: { x: SEPARATOR_X_MM, y: 0 }, endMm: { x: SEPARATOR_X_MM, y: DEPTH_MM } },
          ]),
          "created",
        ),
      );
      assert.equal(separator.actual.levelId, ground.id);
      assertNear(separator.actual.startMm.x, SEPARATOR_X_MM, "x of the separator");
      assertNear(separator.actual.endMm.y, DEPTH_MM, "the separator reaches the north wall");

      const rooms = landed(
        await call<RoomActual>(client, "create_rooms", [
          { levelId: ground.id, pointMm: { x: 3500, y: 5500 }, name: "Гостиная", number: "101" },
          { levelId: ground.id, pointMm: { x: 6500, y: 5000 }, name: "Кухня", number: "102" },
          { levelId: second.id, pointMm: { x: 3000, y: 5000 }, name: "Спальня", number: "201" },
          { levelId: second.id, pointMm: { x: 6700, y: 1800 }, name: "Санузел", number: "202" },
        ]),
        "created",
      );
      console.log(`# rooms: ${JSON.stringify(rooms.map((room) => room.actual))}`);
      const clearDepth = (DEPTH_MM - EXTERIOR_MM) / 1000;
      const bathM2 = ((WIDTH_MM - EXTERIOR_MM / 2 - (BATH_X_MM + PARTITION_MM / 2)) / 1000) * ((BATH_Y_MM - PARTITION_MM / 2 - EXTERIOR_MM / 2) / 1000);
      const expectedRooms = [
        ((SEPARATOR_X_MM - EXTERIOR_MM / 2) / 1000) * clearDepth,
        ((WIDTH_MM - EXTERIOR_MM / 2 - SEPARATOR_X_MM) / 1000) * clearDepth,
        innerM2 - ((WIDTH_MM - EXTERIOR_MM / 2 - (BATH_X_MM - PARTITION_MM / 2)) / 1000) * ((BATH_Y_MM + PARTITION_MM / 2 - EXTERIOR_MM / 2) / 1000),
        bathM2,
      ];
      for (const [index, room] of rooms.entries()) {
        assertNear(room.actual.areaM2, expectedRooms[index]!, `area of room ${room.actual.name}`, NEAR_M2);
      }
      assert.deepEqual(rooms.map((room) => [room.actual.name, room.actual.number]), [["Гостиная", "101"], ["Кухня", "102"], ["Спальня", "201"], ["Санузел", "202"]]);
      const [livingRoom, kitchen, bedroom, bathroom] = rooms as [Landed<RoomActual>, Landed<RoomActual>, Landed<RoomActual>, Landed<RoomActual>];
      assertNear(livingRoom.actual.areaM2 + kitchen.actual.areaM2, innerM2, "the two rooms of the ground floor fill the floor", NEAR_M2);

      // The inner door goes in after the rooms: fromRoomId and toRoomId are read from the model when place_hosted answers and no other tool reads them,
      // so a door placed before its rooms exist would say null on both sides for good.
      await placeOpenings("inner door", "door", [{ what: "the door between the bedroom and the bathroom", typeId: innerType, wallId: partitions[0]!.elementId, offsetAlongWallMm: 2000 }]);
      const innerDoor = openings.at(-1)!.item.actual;
      assert.ok(innerDoor.fromRoomId && innerDoor.toRoomId, `an inner door leads from one room to another: ${JSON.stringify(innerDoor)}`);
      assert.deepEqual([innerDoor.fromRoomId, innerDoor.toRoomId].sort(), [bedroom.elementId, bathroom.elementId].sort(), "the door joins the bedroom and the bathroom");
      assert.deepEqual([openings[0]!.item.actual.fromRoomId, openings[0]!.item.actual.toRoomId], [null, null], "the entrance door was placed before any room existed");

      // FURNITURE: a sofa and a table below, a bed above.
      const [sofaFamily, tableFamily, bedFamily] = await loadFamilies(client, [{ path: SOFA }, { path: DINING_TABLE }, { path: BED }]) as [Landed<FamilyActual>, Landed<FamilyActual>, Landed<FamilyActual>];
      const sofaType = typeOfFamily(sofaFamily, "1830 мм");
      const tableType = typeOfFamily(tableFamily, "0915 x 1830 мм");
      const bedType = typeOfFamily(bedFamily, "1372 x 1905мм - Двуспальная");
      const furniture = landed(
        await call<InstanceActual>(client, "place_instances", [
          { typeId: sofaType, pointMm: { x: 3900, y: 6300 }, levelId: ground.id },
          { typeId: tableType, pointMm: { x: 6500, y: 4000 }, levelId: ground.id },
          { typeId: bedType, pointMm: { x: 4000, y: 5800 }, levelId: second.id },
        ]),
        "created",
      );
      const bedId = furniture[2]!.elementId;

      // PLUMBING: a toilet that stands on the floor, a sink on the partition and a bath on the east wall, both of which hang on a wall.
      const [wcFamily, sinkFamily, bathFamily] = await loadFamilies(client, [{ path: WC }, { path: SINK }, { path: BATH }]) as [Landed<FamilyActual>, Landed<FamilyActual>, Landed<FamilyActual>];
      const fixtures = landed(
        await call<InstanceActual>(client, "place_instances", [
          { typeId: wcFamily.actual.typeIds[0]!.id, pointMm: { x: 6300, y: 700 }, levelId: second.id, rotationDeg: 180 },
          { typeId: sinkFamily.actual.typeIds[0]!.id, pointMm: { x: 6600, y: BATH_Y_MM }, levelId: second.id, hostWallId: partitions[1]!.elementId },
          { typeId: bathFamily.actual.typeIds[0]!.id, pointMm: { x: WIDTH_MM, y: 1500 }, levelId: second.id, hostWallId: upperEast },
        ]),
        "created",
      );

      // READ BACK 1: everything the tools made, by category, as get_elements lists it.
      const before = await houseState(client);
      const info = await modelInfo(client);
      const expectedCounts: Record<keyof typeof CATEGORIES, number> = {
        walls: 10,
        floors: 2,
        roofs: 1,
        ceilings: 2,
        doors: 2,
        windows: 12,
        furniture: 3,
        plumbing: 3,
        stairs: 1,
        railings: stairs.actual.railingIds.length + 1,
        toposolid: 1,
        rooms: 4,
      };
      for (const category of Object.keys(CATEGORIES) as Array<keyof typeof CATEGORIES>) {
        assert.equal(before[category].length, expectedCounts[category], `${category} listed by get_elements`);
        assert.equal(countOf(info, CATEGORIES[category]), expectedCounts[category], `${category} counted by get_model_info`);
      }
      console.log(`# counts: ${JSON.stringify(Object.fromEntries(Object.entries(before).map(([category, rows]) => [category, rows.length])))}`);

      // Walls: the ground ones end at the upper floor, the upper ones follow the roof, and each stands on the level it was made for.
      const wallAxes = new Map([...groundWalls, ...upperWalls, ...partitions].map((wall) => [wall.elementId, wall.actual]));
      const wallRow = (id: string): ElementRow => {
        const row = before.walls.find((candidate) => candidate.id === id);
        assert.ok(row, `wall ${id} is listed`);
        return row;
      };
      for (const wall of groundWalls) {
        assert.equal(wallRow(wall.elementId).levelId, ground.id);
        assertNear(wallRow(wall.elementId).topMm, SECOND_FLOOR_MM, "top of a ground wall");
        assertNear(wallRow(wall.elementId).boundingBoxMm?.min.z, -PLINTH_MM, "foot of a ground wall");
      }
      for (const [index, wall] of roofed.entries()) {
        assert.equal(wallRow(wall.elementId).levelId, second.id);
        assertNear(wallRow(wall.elementId).topMm, upperTops[index]!, `top of upper wall ${index} read back`, ROOF_NEAR_MM);
      }
      assert.equal((await elementsOf(client, { category: "walls", levelId: ground.id })).elements.length, 4);
      assert.equal((await elementsOf(client, { category: "walls", levelId: second.id })).elements.length, 6);
      const walls = boxAround(before.walls.flatMap((row) => [row.boundingBoxMm!.min, row.boundingBoxMm!.max]));
      assertNear(walls.minX, -EXTERIOR_MM / 2, "the west face of the house");
      assertNear(walls.maxX, WIDTH_MM + EXTERIOR_MM / 2, "the east face of the house");
      assertNear(walls.maxY, DEPTH_MM + EXTERIOR_MM / 2, "the north face of the house");

      // Floors, ceilings, roof and ground: sizes and heights.
      const floorRows = new Map(before.floors.map((row) => [row.id, row]));
      assertNear(floorRows.get(floors[0]!.elementId)?.boundingBoxMm?.max.z, 0, "top of the ground floor");
      assertNear(floorRows.get(floors[0]!.elementId)?.boundingBoxMm?.min.z, -FLOOR_MM, "underside of the ground floor");
      assertNear(floorRows.get(upperFloorId)?.boundingBoxMm?.max.z, SECOND_FLOOR_MM, "top of the upper floor");
      assertNear(floorRows.get(upperFloorId)?.boundingBoxMm?.max.x, WIDTH_MM, "east edge of the upper floor");
      assert.deepEqual(before.floors.map((row) => row.typeName), ["Приёмка перекрытие 300", "Приёмка перекрытие 300"]);
      const ceilingRows = new Map(before.ceilings.map((row) => [row.id, row]));
      assertNear(ceilingRows.get(ceilings[0]!.elementId)?.boundingBoxMm?.min.z, CEILING_GROUND_MM, "underside of the ground ceiling");
      assertNear(ceilingRows.get(ceilings[1]!.elementId)?.boundingBoxMm?.min.z, second.elevationMm + CEILING_UPPER_MM, "underside of the upper ceiling");
      assert.equal(before.roofs[0]?.levelId, eaves.id);
      assertNear(before.roofs[0]?.boundingBoxMm?.min.x, -OVERHANG_MM, "west eave", ROOF_NEAR_MM);
      assertNear(before.roofs[0]?.boundingBoxMm?.max.y, DEPTH_MM + OVERHANG_MM, "north eave", ROOF_NEAR_MM);
      assertNear(before.roofs[0]?.boundingBoxMm?.min.z, EAVES_MM - OVERHANG_MM * tan(SLOPE_DEG), "the eave falls with the slope", ROOF_NEAR_MM);
      assert.ok((before.roofs[0]?.boundingBoxMm?.max.z ?? 0) >= ridgeMm, "the ridge of the roof is above the walls it covers");
      assertNear(before.toposolid[0]?.boundingBoxMm?.max.z, -PLINTH_MM, "top of the ground");

      // Stairs: they end at the upper level, in the model as well as in the answer of the tool.
      assertNear(stairs.actual.topElevationMm, second.elevationMm, "topElevationMm of the stairs is the elevation of the upper level");
      assert.equal(before.stairs[0]?.id, stairs.elementId);
      assertNear(before.stairs[0]?.boundingBoxMm?.max.z, second.elevationMm, "the box of the stairs reaches the upper floor", 200);
      assert.deepEqual(before.railings.map((row) => row.id).sort(), [...stairs.actual.railingIds, guard.elementId].sort(), "the railings are the two of the stairs and the one round the opening");

      // Doors and windows: every one cuts its wall, sits in the wall it was given and on that wall's level.
      assert.equal(openings.filter((opening) => opening.kind === "door").length, 2);
      assert.equal(openings.filter((opening) => opening.kind === "window").length, 12);
      for (const opening of openings) {
        assert.equal(opening.item.actual.cutsWall, true, `${opening.what}: the wall lists it among its inserts`);
        assert.equal(opening.item.actual.hostId, opening.wallId, `${opening.what}: host`);
        const row = (opening.kind === "door" ? before.doors : before.windows).find((candidate) => candidate.id === opening.item.elementId);
        assert.ok(row?.boundingBoxMm, `${opening.what}: listed with a box`);
        const host = wallRow(opening.wallId);
        assert.equal(row.levelId, host.levelId, `${opening.what}: level`);

        // The box of a door or window holds its leaf or sash, which reach out of the wall, so it is the middle along the wall that is read: it is the offset asked for.
        const axis = wallAxes.get(opening.wallId);
        assert.ok(axis, `${opening.what}: the wall is one that was made`);
        const length = Math.hypot(axis.endMm.x - axis.startMm.x, axis.endMm.y - axis.startMm.y);
        const middle = { x: (row.boundingBoxMm.min.x + row.boundingBoxMm.max.x) / 2, y: (row.boundingBoxMm.min.y + row.boundingBoxMm.max.y) / 2 };
        const along = ((middle.x - axis.startMm.x) * (axis.endMm.x - axis.startMm.x) + (middle.y - axis.startMm.y) * (axis.endMm.y - axis.startMm.y)) / length;
        assertNear(along, opening.item.actual.offsetAlongWallMm, `${opening.what}: the middle of its box along the wall`, 1);
        const box = host.boundingBoxMm!;
        assert.ok(
          row.boundingBoxMm.max.x >= box.min.x && row.boundingBoxMm.min.x <= box.max.x && row.boundingBoxMm.max.y >= box.min.y && row.boundingBoxMm.min.y <= box.max.y,
          `${opening.what}: its box meets the box of the wall`,
        );
      }

      // Rooms: by name, number, level and area, as get_elements lists them.
      const roomRows = before.rooms.map((row) => [row.name, row.number, row.levelId, row.areaM2] as const);
      assert.deepEqual(roomRows.map((row) => row.slice(0, 3)), [
        ["Гостиная", "101", ground.id],
        ["Кухня", "102", ground.id],
        ["Спальня", "201", second.id],
        ["Санузел", "202", second.id],
      ]);
      for (const [index, row] of roomRows.entries()) {
        assertNear(row[3], rooms[index]!.actual.areaM2, `area of room ${String(row[0])} read back`, 1e-9);
        assert.ok(row[3]! > 0, `${String(row[0])} is a real room`);
      }
      assert.equal((await elementsOf(client, { category: "rooms", levelId: ground.id })).elements.length, 2);
      assert.equal((await elementsOf(client, { category: "rooms", levelId: second.id })).elements.length, 2);

      // Furniture and plumbing stand on the floor of their level and inside the room they belong to.
      const standing = [...before.furniture, ...before.plumbing];
      assert.equal(standing.length, 6);
      const placedRows = new Map(standing.map((row) => [row.id, row]));
      const insideRoom = (id: string, from: Point, to: Point, what: string, slack = 15): void => {
        const box = placedRows.get(id)?.boundingBoxMm;
        assert.ok(box, `${what} has a box`);
        assert.ok(box.min.x >= from.x - slack && box.max.x <= to.x + slack && box.min.y >= from.y - slack && box.max.y <= to.y + slack, `${what} stands inside its room: ${JSON.stringify(box)}`);
      };
      insideRoom(furniture[0]!.elementId, { x: inner.x0, y: inner.y0 }, { x: SEPARATOR_X_MM, y: inner.y1 }, "the sofa");
      insideRoom(furniture[1]!.elementId, { x: SEPARATOR_X_MM, y: inner.y0 }, { x: inner.x1, y: inner.y1 }, "the table");
      insideRoom(bedId, { x: inner.x0, y: inner.y0 }, { x: BATH_X_MM, y: inner.y1 }, "the bed");
      const bathBounds = [{ x: BATH_X_MM + PARTITION_MM / 2, y: inner.y0 }, { x: inner.x1, y: BATH_Y_MM - PARTITION_MM / 2 }] as const;
      insideRoom(fixtures[0]!.elementId, ...bathBounds, "the toilet");
      insideRoom(fixtures[1]!.elementId, ...bathBounds, "the sink");
      insideRoom(fixtures[2]!.elementId, ...bathBounds, "the bath");
      for (const id of [furniture[0]!.elementId, furniture[1]!.elementId]) {
        assertNear(placedRows.get(id)?.boundingBoxMm?.min.z, 0, "the foot of the ground floor furniture", 1);
      }
      for (const id of [bedId, ...fixtures.map((fixture) => fixture.elementId)]) {
        assertNear(placedRows.get(id)?.boundingBoxMm?.min.z, second.elevationMm, "the foot of the upper floor furniture", 1);
      }

      // WARNINGS: what Revit still holds for the house. They are printed, and any that the test does not name fails it.
      const leftover = await modelWarnings(client, t, "after the build");
      assertOnlyNamedWarnings(leftover);

      // UPDATE: the bed stands 147.5 mm short of the north wall, where its head belongs. The correction is read from the model and made by update_elements.
      const northFace = DEPTH_MM - EXTERIOR_MM / 2;
      const bedBefore = placedRows.get(bedId)?.boundingBoxMm;
      assert.ok(bedBefore);
      const gap = northFace - bedBefore.max.y;
      assert.ok(gap > 100, `the bed should start short of the wall, and its gap is ${gap}`);
      const correction = { id: bedId, moveMm: { x: 0, y: gap, z: 0 } };

      const fixed = only(landed(await call<UpdateActual>(client, "update_elements", [correction]), "updated"));
      assert.equal(fixed.elementId, bedId, "the bed keeps its id");
      const bedAfter = (await elementsOf(client, { ids: [bedId] })).elements[0]?.boundingBoxMm;
      assertNear(bedAfter?.max.y, northFace, "the head of the bed touches the north wall", 0.5);
      assertNear(bedAfter?.min.y, bedBefore.min.y + gap, "the whole bed moved", 0.5);
      assertNear(bedAfter?.min.x, bedBefore.min.x, "and not sideways", 0.5);
      const corrected = await houseState(client);
      assert.deepEqual({ ...corrected, furniture: [] }, { ...before, furniture: [] }, "nothing but the furniture changed");

      // UNDO: the last step is the correction. One undo takes it back, and the model reads as it did before it.
      const undone = await undoWithOneRetry(t, client);
      console.log(`# undo: ${JSON.stringify(undone)}`);
      assert.equal(undone.state, "undone");
      assert.equal(undone.transactionName, "MCP: update_elements");
      assert.equal(undone.documentTitle, name);
      assert.deepEqual(undone.createdIds, []);
      const afterUndo = await houseState(client);
      assert.deepEqual(afterUndo, before, "after the undo the model reads as before the correction");
      assertOnlyNamedWarnings(await modelWarnings(client, t, "after the undo"));

      // The correction again, and this time it stays.
      const again = only(landed(await call<UpdateActual>(client, "update_elements", [correction]), "updated"));
      assert.equal(again.elementId, bedId);
      assertNear((await elementsOf(client, { ids: [bedId] })).elements[0]?.boundingBoxMm?.max.y, northFace, "the head of the bed touches the north wall again", 0.5);
      assert.deepEqual({ ...(await houseState(client)), furniture: [] }, { ...before, furniture: [] });

      // VIEW AND SNAPSHOT: the presentation template brings the shadows, and the ground gives them something to fall on.
      const templates = await listTypes(client, "view_templates");
      const presentation = templates.find((template) => /презентац/i.test(template.name));
      assert.ok(presentation, `no presentation template in ${JSON.stringify(templates)}`);

      const view = (await client.call("create_3d_view", {
        name: VIEW_NAME,
        kind: "perspective",
        displayStyle: "realistic",
        eyeMm: EYE_MM,
        targetMm: TARGET_MM,
        viewTemplateId: presentation.id,
        sunAzimuthDeg: 135,
        sunAltitudeDeg: 45,
      })) as { committed: boolean; viewId: string; name: string; displayStyle: string; warnings: string[]; errors: string[]; dialogs: unknown[] };
      console.log(`# view: ${JSON.stringify(view)}`);
      assert.equal(view.committed, true, JSON.stringify(view));
      assert.equal(view.name, VIEW_NAME);
      assert.equal(view.displayStyle, "realistic");
      assert.deepEqual(view.errors, []);
      assert.deepEqual(view.dialogs, []);
      assert.ok((await modelInfo(client)).views.some((row) => row.id === view.viewId && row.name === VIEW_NAME));

      const shot = (await client.call("get_view_snapshot", { viewId: view.viewId, widthPx: SNAPSHOT_WIDTH_PX })) as { viewId: string; viewName: string; path: string; dialogs: unknown[] };
      assert.equal(shot.viewId, view.viewId);
      assert.equal(shot.viewName, VIEW_NAME);
      assert.deepEqual(shot.dialogs, []);
      await mkdir(snapshotFolder, { recursive: true });
      const kept = path.join(snapshotFolder, `малый-дом-${stamp}.png`);
      await copyFile(shot.path, kept);
      console.log(`# snapshot: ${kept}`);

      const pixels = decodePng(await readFile(kept));
      assert.equal(pixels.width, SNAPSHOT_WIDTH_PX);
      assert.ok(pixels.height > 300, `a picture of ${pixels.width} x ${pixels.height}`);

      // A blank picture fails here: the red walls fill the middle of it, the meadow lies on both sides of them and in front of them, and the sky above is blue.
      // The meadow is olive-green and dim, so it is counted by its hue, from yellow-green to green, and not by the pure green band.
      const all = reportColours(pixels);
      const redWalls = boundsOfBand(pixels, "red");
      const sky = meanColour(pixels, { left: 0, top: 0, right: 1, bottom: 0.1 });
      assert.ok(redWalls, "the red walls should show");
      const meadowAt = (region: Region) => reportHues(pixels, MEADOW_HUE.from, MEADOW_HUE.to, region);
      const westOfHouse = meadowAt({ left: 0, top: 0.5, right: redWalls.left / pixels.width, bottom: 1 });
      const eastOfHouse = meadowAt({ left: (redWalls.right + 1) / pixels.width, top: 0.5, right: 1, bottom: 1 });
      const inFrontOfHouse = meadowAt({ left: redWalls.left / pixels.width, top: (redWalls.bottom + 1) / pixels.height, right: (redWalls.right + 1) / pixels.width, bottom: 1 });
      console.log(`# picture: ${JSON.stringify({ width: pixels.width, height: pixels.height, coloured: all.coloured, red: all.bands.red, redWalls, sky, westOfHouse, eastOfHouse, inFrontOfHouse })}`);

      assert.ok(all.coloured > 0.1 * all.pixels, `a blank picture has no colour, and this one has ${all.coloured} of ${all.pixels} pixels`);
      assert.ok(redWalls.count > 0.1 * all.pixels, `the red walls should fill a tenth of the picture: ${JSON.stringify(redWalls)}`);
      assert.ok(Math.abs((redWalls.left + redWalls.right) / 2 - pixels.width / 2) < pixels.width / 6, `the house stands in the middle third: ${JSON.stringify(redWalls)}`);
      assert.ok(westOfHouse.inRange > 0.05 * westOfHouse.pixels, `meadow west of the house: ${JSON.stringify(westOfHouse)}`);
      assert.ok(eastOfHouse.inRange > 0.05 * eastOfHouse.pixels, `meadow east of the house: ${JSON.stringify(eastOfHouse)}`);
      assert.ok(redWalls.bottom + 1 >= pixels.height || inFrontOfHouse.inRange > 0.05 * inFrontOfHouse.pixels, `meadow in front of the house: ${JSON.stringify(inFrontOfHouse)}`);
      assert.ok(sky.b > sky.r + 15, `the sky is blue above the house: ${JSON.stringify(sky)}`);

      // The close rule asks for a saved project; the house stays open, saved.
      await client.call("save_project", { name });
      const last = await modelInfo(client);
      assert.equal(last.activeDocument?.title, name);
      assert.equal(last.activeDocument?.isModified, false);
      assertOnlyNamedWarnings(await modelWarnings(client, t, "at the end"));
    });

    t.diagnostic(`the house took ${Math.round((Date.now() - started) / 1000)} s`);
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
