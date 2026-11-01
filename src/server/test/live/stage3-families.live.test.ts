import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

import { checkCanClose } from "../../src/cli/closeRule.ts";
import { BridgeClient } from "../../src/client.ts";
import { defaultConnectionPath } from "../../src/connection.ts";
import { BridgeRpcError } from "../../src/errors.ts";
import { undoWithOneRetry } from "../undoRetry.ts";

// These tests need a running Revit with the RevitMCP plugin loaded. Each run creates one new project in the test folder and
// leaves it open and saved. They load real families from the library of this machine and place instances of them. What a
// catalog says is read from its .txt here, because the plugin does not read it, and what the model says is read back from Revit.

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

interface InstanceActual {
  typeId: string;
  pointMm: Point;
  elevationMm: number | null;
  rotationDeg: number;
  levelId: string | null;
  hostWallId: string | null;
  facingFlipped: boolean;
}

interface ElementRow {
  id: string;
  category: string | null;
  levelId: string | null;
  boundingBoxMm: Box | null;
}

interface ElementsAnswer {
  elements: ElementRow[];
  notFound: string[];
}

const INVALID_PARAMS = -32602;
const NEAR_MM = 0.01;
/** A written size reads back as the same number, within the noise of feet. */
const SIZE_NEAR_MM = 0.01;
const UPPER_LEVEL_MM = 4000;

/** The library of this machine, the same folder as LibraryFolder.Root in the plugin. */
const LIBRARY = path.win32.join(process.env["ProgramData"] ?? "C:\\ProgramData", "Autodesk", "RVT 2027", "Libraries", "Russian");

const BED = "Russia\\Мебель\\Кровати\\Кровать-Стандарт.rfa";
const TABLE = "Russia\\Мебель\\Столы\\Стол-Обеденный.rfa";
const DOOR = "Russia\\Двери\\Дверь-Одинарная-Панель.rfa";
const SLIDING_DOOR = "Russia\\Двери\\Дверь-Двойная-Раздвижная.rfa";
const WINDOW = "Russia\\Окна\\Окно-закрепленное.rfa";
const GOST_DOOR = "Russia\\Двери\\Для России\\ГОСТ 14624-84\\Внутренняя дверь 1-Навесная - 14624-84.rfa";
/** A file name with Cyrillic, spaces, a dot inside the name and digits and dashes, in a folder with spaces. */
const GOST_WINDOW = "Russia\\Окна\\Для России\\ГОСТ 30674-99\\Окно 1-Распашное - Один. переплет с несколькими оконными стеклами - ГОСТ 30674-99.rfa";
const WC = "Russia\\Сантехника\\Архитектурные\\Приборы\\Унитазы\\Туалет-Домашний-3D.rfa";
const SINK = "Russia\\Сантехника\\Архитектурные\\Приборы\\Раковины\\Раковина-Одиночная-2D.rfa";
const BATH = "Russia\\Сантехника\\Архитектурные\\Приборы\\Ванны\\Ванна-Прямоугольная-3D.rfa";
const COLUMN = "Russia\\Колонны\\Колонна из деревянного бруса.rfa";
/** A recessed ceiling light: a hosted family whose host is a ceiling, and not a wall. */
const CEILING_LIGHT = "Russia\\Освещение\\Архитектурные\\Внутренний\\Локальный светильник - Встроенный накаливания.rfa";
/** The same family in two versions of a steel library: two files with one name, whose catalogs hold some rows of their own. */
const STEEL_FRAME_A = "Russia\\Каркас несущий\\Сталь\\AISC 14.1\\HSS Квадратный.rfa";
const STEEL_FRAME_B = "Russia\\Каркас несущий\\Сталь\\AISC 15.0\\HSS Квадратный.rfa";
/** Two different files of the library with one name, in two folders. */
const STEEL_COLUMN_BELARUS = "Belarus\\Несущие конструкции\\Колонны\\Сталь\\Специально для Беларуси\\I-образная колонна.rfa";
const STEEL_COLUMN_UKRAINE = "Ukraine\\Несущие конструкции\\Колонны\\Сталь\\Специально для Украины\\I-образная колонна.rfa";

const stamp = new Date().toTimeString().slice(0, 8).replaceAll(":", "");
const name = `проверка-этап3-семейства-${stamp}`;

/** What the tests share: the levels, the walls things hang on, and the type ids that later tests place. */
interface World {
  ground: Level;
  upper: Level;
  wallType: TypeRow;
  /** Along +X on the ground level, from x 0 to 6000 at y 0, 3000 high. */
  wallA: string;
  /** Along +Y on the ground level, from y 0 to 5000 at x 6000, 3000 high. */
  wallB: string;
  /** The same line as wallA, on the upper level. */
  wallUpper: string;
  bed?: TypeActual;
  wc?: TypeActual;
  sink?: TypeActual;
  bath?: TypeActual;
}

let world: World | undefined;

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

const place = (client: BridgeClient, items: unknown[]): Promise<Batch<InstanceActual>> => client.call("place_instances", { items }) as Promise<Batch<InstanceActual>>;

function ready(): World {
  assert.ok(world, "the first test creates the project");
  return world;
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
}

/** Everything landed with the status asked for, and the items are returned. */
function landed<A>(batch: Batch<A>, status: string): Array<Item<A> & { elementId: string; actual: A }> {
  assertLanded(batch);

  return batch.items.map((item) => {
    assert.equal(item.status, status, JSON.stringify(item));
    assert.ok(item.elementId && item.actual, JSON.stringify(item));
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

/** The names of the rows of the type catalog beside a family file: the first column, after the header. The plugin does not read it. */
async function catalogRows(family: string): Promise<string[]> {
  const text = (await readFile(path.win32.join(LIBRARY, family.replace(/\.rfa$/i, ".txt")), "utf16le")).replace(/^\uFEFF/, "");
  const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
  // The header starts with an empty cell, so its first character is the separator: a comma, or in some catalogs a semicolon.
  const separator = lines[0]?.[0] ?? ",";

  return lines.slice(1).map((line) => line.split(separator)[0] ?? "");
}

/** The 8.3 short form of a path, as Windows gives it to cmd: the names that Windows makes of long ones, such as DAA6~1. */
function shortForm(longPath: string): string {
  const command = `for %I in ("${longPath}") do @echo %~sI`;

  return spawnSync("cmd.exe", ["/d", "/s", "/c", `"${command}"`], { encoding: "latin1", windowsVerbatimArguments: true }).stdout.trim();
}

/** The type of a family a call loaded, by name. */
function typeNamed(actual: FamilyActual, typeName: string): TypeActual {
  const found = actual.typeIds.find((type) => type.name === typeName);
  assert.ok(found, `no type '${typeName}' in ${JSON.stringify(actual.typeIds.map((type) => type.name))}`);
  return found;
}

/** The size of the box of a placed door or window, from the model: width along x, depth along y and height. */
async function boxSize(client: BridgeClient, id: string): Promise<{ x: number; y: number; z: number }> {
  const [row] = (await elementsOf(client, [id])).elements;
  assert.ok(row?.boundingBoxMm, `element ${id} has a box`);
  const { min, max } = row.boundingBoxMm;

  return { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z };
}

describe("stage 3 live checks: families and instances", { timeout: 900_000 }, () => {
  it("creates a project for this run, with the walls things hang on", async () => {
    await withClient(async (client) => {
      await client.call("create_project", { name });

      const info = await modelInfo(client);
      assert.equal(info.activeDocument?.title, name);
      const ground = info.levels.find((level) => level.elevationMm === 0);
      assert.ok(ground, `no level at the origin in ${JSON.stringify(info.levels)}`);
      const upper = info.levels.find((level) => level.elevationMm === UPPER_LEVEL_MM);
      assert.ok(upper, `no level at ${UPPER_LEVEL_MM} in ${JSON.stringify(info.levels)}`);

      const walls = await listTypes(client, "walls");
      const wallType = walls.find((row) => /^Наружный - Стена из бруса толщиной 180 мм/.test(row.name));
      assert.ok(wallType, `no wall type to build with in ${JSON.stringify(walls.map((row) => row.name))}`);

      const built = (await client.call("create_walls", {
        items: [
          { startMm: { x: 0, y: 0 }, endMm: { x: 6000, y: 0 }, typeId: wallType.id, levelId: ground.id, heightMm: 3000 },
          { startMm: { x: 6000, y: 0 }, endMm: { x: 6000, y: 5000 }, typeId: wallType.id, levelId: ground.id, heightMm: 3000 },
          { startMm: { x: 0, y: 0 }, endMm: { x: 6000, y: 0 }, typeId: wallType.id, levelId: upper.id, heightMm: 3000 },
        ],
      })) as Batch<unknown>;
      const [wallA, wallB, wallUpper] = landed(built, "created").map((item) => item.elementId);
      assert.ok(wallA && wallB && wallUpper);

      world = { ground, upper, wallType, wallA, wallB, wallUpper };
    });
  });

  it("family loads and lists its types", async () => {
    await withClient(async (client) => {
      const w = ready();
      const request = { path: BED };

      const batch = await loadFamily(client, [request]);
      const [bed] = landed(batch, "created");
      assert.ok(bed);

      // The element of a whole-family item is the family, and the types are the ones the family has.
      assert.equal(bed.elementId, bed.actual.familyId);
      assert.deepEqual(bed.requested, request, "the path with Cyrillic comes back as it was sent");
      assert.deepEqual(bed.actual.typeIds.map((type) => type.name).sort(), [
        "0965 x 1905мм - Односпальная",
        "1372 x 1905мм - Двуспальная",
        "1525 x 2007мм - Queen Size",
        "1981 x 2032мм - King size",
      ]);
      assert.deepEqual(bed.warnings, []);
      assert.deepEqual(batch.warnings, [], "a family with no catalog gives Revit nothing to warn about");
      for (const type of bed.actual.typeIds) {
        assert.equal(type.widthMm, null, "a bed has no Width that Revit names as such");
        assert.equal(type.heightMm, null);
      }

      // The model agrees: every type is in the list of furniture, under the family it came with.
      const furniture = await listTypes(client, "furniture");
      for (const type of bed.actual.typeIds) {
        assert.ok(furniture.some((row) => row.id === type.id && row.name === type.name && row.family === "Кровать-Стандарт"), `type ${type.name} is in list_types`);
      }
      w.bed = bed.actual.typeIds.find((type) => type.name.startsWith("0965"));
      assert.ok(w.bed);
    });
  });

  it("catalog type loads by name", async () => {
    await withClient(async (client) => {
      const rows = await catalogRows(DOOR);
      assert.ok(rows.includes("800 x 2100 мм"), `the catalog rows: ${JSON.stringify(rows)}`);
      assert.ok(rows.length > 2, "the family has more rows than the one that is loaded");
      const before = await listTypes(client, "doors");

      const batch = await loadFamily(client, [{ path: DOOR, typeName: "800 x 2100 мм" }]);
      const [row] = landed(batch, "created");
      assert.ok(row);

      // Only that row: the element is the type, and the family holds no other row.
      assert.equal(row.actual.typeIds.length, 1);
      const type = typeNamed(row.actual, "800 x 2100 мм");
      assert.equal(row.elementId, type.id);
      const after = await listTypes(client, "doors");
      assert.deepEqual(after.filter((entry) => entry.family === "Дверь-Одинарная-Панель").map((entry) => entry.id), [type.id]);
      assert.equal(after.length, before.length + 1);

      // Revit ignores the sizes of the catalog: the row called 800 x 2100 is the size of the family itself (observed in the probe: 850 x 2000).
      assertNear(type.widthMm, 850, "the width of a row loaded with no size", SIZE_NEAR_MM);
      assertNear(type.heightMm, 2000, "the height of a row loaded with no size", SIZE_NEAR_MM);
      assert.equal(row.warnings.length, 1, JSON.stringify(row.warnings));
      assert.match(row.warnings[0] ?? "", /850 x 2000 mm/);
      assert.match(row.warnings[0] ?? "", /widthMm and heightMm/);
      assert.ok(batch.warnings.length > 0, "Revit itself reports the columns of the catalog that it ignores");
    });
  });

  it("typeName with Cyrillic and мм is looked up exactly", async () => {
    await withClient(async (client) => {
      const exact = "800 x 2100 мм";
      const before = await listTypes(client, "doors");

      // The name as it is: found in the document, and no call to Revit.
      const [same] = landed(await loadFamily(client, [{ path: DOOR, typeName: exact }]), "already_existed");
      assert.ok(same);
      assert.equal(typeNamed(same.actual, exact).id, same.elementId);

      // Names that look alike are other names. Revit says it loaded nothing, or finds the type that the project holds and the plugin refuses to reload it: either way the item fails and nothing changes.
      const lookalikes = [
        ["a Cyrillic х for the Latin x", "800 х 2100 мм"],
        ["a Latin m for the Cyrillic м", "800 x 2100 mm"],
        ["another case", "800 X 2100 ММ"],
        ["a space at the end", `${exact} `],
        ["a double space", "800  x 2100 мм"],
      ] as const;
      for (const [what, typeName] of lookalikes) {
        const batch = await loadFamily(client, [{ path: DOOR, typeName }]);
        console.log(`# typeName ${what}: ${batch.items[0]?.status}, ${batch.items[0]?.error?.slice(0, 160)}`);
        assert.equal(batch.committed, false, what);
        assert.equal(batch.items[0]?.status, "failed", what);
        assert.match(batch.items[0]?.error ?? "", /Revit loaded nothing|holds already/, what);
      }

      assert.deepEqual(await listTypes(client, "doors"), before, "no type was added by a name that is not exact");
      const [again] = landed(await loadFamily(client, [{ path: DOOR, typeName: exact }]), "already_existed");
      assertNear(typeNamed(again!.actual, exact).widthMm, 850, "the width of the row is as it was", SIZE_NEAR_MM);
    });
  });

  it("unknown catalog type fails", async () => {
    await withClient(async (client) => {
      const tablesBefore = await listTypes(client, "furniture");
      const doorsBefore = await listTypes(client, "doors");
      const countsBefore = await modelInfo(client);

      // A family that is not loaded yet, and a row that the catalog does not have. The item before it loaded and is rolled back with it.
      const batch = await loadFamily(client, [{ path: TABLE }, { path: SLIDING_DOOR, typeName: "999 x 999 мм" }]);

      assert.equal(batch.committed, false);
      assert.equal(batch.items[0]?.status, "rolled_back");
      assert.equal(batch.items[0]?.elementId, null);
      assert.equal(batch.items[1]?.status, "failed");
      assert.equal(batch.items[1]?.actual, null);
      assert.match(batch.items[1]?.error ?? "", /999 x 999 мм/);
      assert.match(batch.items[1]?.error ?? "", /type catalog/);
      assert.match(batch.errors.join("\n"), /Item 1 failed, so nothing landed/);

      assert.deepEqual(await listTypes(client, "furniture"), tablesBefore, "the table that loaded before the bad item is gone");
      assert.deepEqual(await listTypes(client, "doors"), doorsBefore, "the sliding door was not loaded");
      const countsAfter = await modelInfo(client);
      assert.equal(countOf(countsAfter, "OST_Furniture"), countOf(countsBefore, "OST_Furniture"));

      // A row that is not there in a family that is loaded fails the same way, and the rows that are there stay as they were.
      const unknownRow = await loadFamily(client, [{ path: DOOR, typeName: "999 x 999 мм" }]);
      assert.equal(unknownRow.committed, false);
      assert.equal(unknownRow.items[0]?.status, "failed");
      assert.deepEqual(await listTypes(client, "doors"), doorsBefore);
    });
  });

  it("reload returns already_existed", async () => {
    await withClient(async (client) => {
      const w = ready();
      await saved(client);

      // The whole family again: every type it holds, and the id of the family.
      const family = await loadFamily(client, [{ path: BED }]);
      const [bed] = landed(family, "already_existed");
      assert.ok(bed);
      assert.equal(bed.elementId, bed.actual.familyId);
      assert.equal(bed.actual.typeIds.length, 4);
      assert.equal(bed.actual.typeIds.find((type) => type.name.startsWith("0965"))?.id, w.bed?.id);

      // A row again, and a row of a catalog that is loaded in part, with a size that is not the one it has: reported, never changed.
      const row = await loadFamily(client, [{ path: DOOR, typeName: "800 x 2100 мм", widthMm: 800, heightMm: 2100 }]);
      const [door] = landed(row, "already_existed");
      assert.ok(door);
      assert.equal(door.warnings.length, 2, JSON.stringify(door.warnings));
      assert.match(door.warnings.join("\n"), /width of 850 mm, not the 800 mm asked for\. It was not changed/);
      assert.match(door.warnings.join("\n"), /height of 2000 mm, not the 2100 mm asked for\. It was not changed/);
      assertNear(typeNamed(door.actual, "800 x 2100 мм").widthMm, 850, "the width stays", SIZE_NEAR_MM);

      // A type that has no width at all cannot be given one, and is told so.
      const [bedRow] = landed(await loadFamily(client, [{ path: BED, typeName: w.bed!.name, widthMm: 900 }]), "already_existed");
      assert.match(bedRow!.warnings.join("\n"), /has no width/);

      // A family that has a catalog and is only in part loaded: the warning says that the other rows are not there.
      const part = landed(await loadFamily(client, [{ path: DOOR }]), "already_existed")[0];
      assert.equal(part!.actual.typeIds.length, 1);
      assert.match(part!.warnings.join("\n"), /name it in typeName/);

      assert.equal(await isModified(client), false, "nothing was loaded again, so there is no Undo step and the project is as saved");
    });
  });

  it("catalog row gets the requested size", async () => {
    await withClient(async (client) => {
      const w = ready();

      // The window row called 600 x 1200 is 600 x 900 when loaded as it is, and 600 x 1200 when the size is given.
      const [plain] = landed(await loadFamily(client, [{ path: WINDOW, typeName: "600 x 1050 мм" }]), "created");
      assertNear(typeNamed(plain!.actual, "600 x 1050 мм").widthMm, 600, "the plain width", SIZE_NEAR_MM);
      assertNear(typeNamed(plain!.actual, "600 x 1050 мм").heightMm, 900, "the plain height, not the 1050 of its name", SIZE_NEAR_MM);

      const request = { path: WINDOW, typeName: "600 x 1200 мм", widthMm: 600, heightMm: 1200 };
      const [window] = landed(await loadFamily(client, [request]), "created");
      assert.ok(window);
      assert.deepEqual(window.warnings, [], "a row that is given its size has nothing to warn about");
      const sized = typeNamed(window.actual, "600 x 1200 мм");
      assertNear(sized.widthMm, 600, "window width", SIZE_NEAR_MM);
      assertNear(sized.heightMm, 1200, "window height", SIZE_NEAR_MM);

      // A door row with both sizes different from the family's, and with one size only.
      const [door] = landed(await loadFamily(client, [{ path: DOOR, typeName: "750 x 2100 мм", widthMm: 750, heightMm: 2100 }]), "created");
      const sizedDoor = typeNamed(door!.actual, "750 x 2100 мм");
      assertNear(sizedDoor.widthMm, 750, "door width", SIZE_NEAR_MM);
      assertNear(sizedDoor.heightMm, 2100, "door height", SIZE_NEAR_MM);
      const [narrow] = landed(await loadFamily(client, [{ path: DOOR, typeName: "850 x 2100 мм", widthMm: 900.5 }]), "created");
      const narrowType = typeNamed(narrow!.actual, "850 x 2100 мм");
      assertNear(narrowType.widthMm, 900.5, "a size with decimals", SIZE_NEAR_MM);
      assertNear(narrowType.heightMm, 2000, "the height that was not given stays the family's", SIZE_NEAR_MM);
      assert.equal(narrow!.warnings.length, 1, "a row given one size only is still warned about the other");

      // A second read after the commit: the model holds the sizes, so a later call sees them.
      const [reread] = landed(await loadFamily(client, [{ path: WINDOW, typeName: "600 x 1200 мм" }]), "already_existed");
      assertNear(typeNamed(reread!.actual, "600 x 1200 мм").heightMm, 1200, "the height a later call reads", SIZE_NEAR_MM);

      // And the size is the size of the thing: a door given 2100 stands 100 mm higher than one of the family's 2000, and is 100 mm narrower than 850.
      const y = 20000;
      const [wall] = landed(
        (await client.call("create_walls", {
          items: [{ startMm: { x: 0, y }, endMm: { x: 10000, y }, typeId: w.wallType.id, levelId: w.ground.id, heightMm: 3000 }],
        })) as Batch<unknown>,
        "created",
      );
      const defaultDoor = typeNamed((await loadFamily(client, [{ path: DOOR, typeName: "800 x 2100 мм" }])).items[0]!.actual!, "800 x 2100 мм");
      // place_instances refuses doors and windows, so they go through place_hosted, which also confirms that each one cuts its wall.
      const doors = landed(
        (await client.call("place_hosted", {
          items: [
            { typeId: defaultDoor.id, wallId: wall!.elementId, offsetAlongWallMm: 2000 },
            { typeId: sizedDoor.id, wallId: wall!.elementId, offsetAlongWallMm: 5000 },
          ],
        })) as Batch<{ cutsWall: boolean }>,
        "created",
      );
      assert.ok(doors.every((door) => door.actual.cutsWall));
      const defaultBox = await boxSize(client, doors[0]!.elementId);
      const sizedBox = await boxSize(client, doors[1]!.elementId);
      console.log(`# door boxes: family size 850 x 2000 -> ${JSON.stringify(defaultBox)}, written 750 x 2100 -> ${JSON.stringify(sizedBox)}`);
      assertNear(sizedBox.z - defaultBox.z, 100, "the written height raises the door by 100 mm", 2);
      assertNear(sizedBox.x - defaultBox.x, -100, "the written width narrows the door by 100 mm", 2);
    });
  });

  it("loading a second row keeps the first row size", async () => {
    await withClient(async (client) => {
      // The window rows of the last test: 600 x 1200 is given its size. Two more rows are loaded, one with a size of its own and one without.
      landed(await loadFamily(client, [{ path: WINDOW, typeName: "600 x 1500 мм" }]), "created");
      landed(await loadFamily(client, [{ path: WINDOW, typeName: "900 x 1200 мм", widthMm: 900, heightMm: 1300 }]), "created");

      const [family] = landed(await loadFamily(client, [{ path: WINDOW }]), "already_existed");
      assert.ok(family);
      const first = typeNamed(family.actual, "600 x 1200 мм");
      assertNear(first.widthMm, 600, "the first row keeps its width", SIZE_NEAR_MM);
      assertNear(first.heightMm, 1200, "the first row keeps its height", SIZE_NEAR_MM);
      const second = typeNamed(family.actual, "600 x 1500 мм");
      assertNear(second.heightMm, 900, "the row loaded with no size has the family's", SIZE_NEAR_MM);
      const third = typeNamed(family.actual, "900 x 1200 мм");
      assertNear(third.widthMm, 900, "the third row has the size it was given", SIZE_NEAR_MM);
      assertNear(third.heightMm, 1300, "the third row has the height it was given, not that of its name", SIZE_NEAR_MM);

      // Two rows of one family in one call, which is not a repeat: both land, and the first call's rows are as they were.
      const batch = await loadFamily(client, [
        { path: WINDOW, typeName: "600 x 1350 мм", widthMm: 600, heightMm: 1350 },
        { path: WINDOW, typeName: "600 x 1650 мм", widthMm: 600, heightMm: 1650 },
      ]);
      const pair = landed(batch, "created");
      assert.equal(pair[0]?.actual.familyId, family.actual.familyId, "both rows are in the one family");
      assert.equal(pair[1]?.actual.familyId, family.actual.familyId);

      // The read-back of a call comes after the whole call, so the first row is read after the second was loaded. The second load leaves it alone.
      const firstOfPair = typeNamed(pair[0]!.actual, "600 x 1350 мм");
      const secondOfPair = typeNamed(pair[1]!.actual, "600 x 1650 мм");
      assertNear(firstOfPair.widthMm, 600, "the first row of the pair, width", SIZE_NEAR_MM);
      assertNear(firstOfPair.heightMm, 1350, "the first row of the pair, height, read after the second row was loaded", SIZE_NEAR_MM);
      assertNear(secondOfPair.widthMm, 600, "the second row of the pair, width", SIZE_NEAR_MM);
      assertNear(secondOfPair.heightMm, 1650, "the second row of the pair, height", SIZE_NEAR_MM);
      assert.deepEqual(pair[0]?.warnings, []);
      assert.deepEqual(pair[1]?.warnings, []);

      const [all] = landed(await loadFamily(client, [{ path: WINDOW }]), "already_existed");
      assert.equal(all!.actual.typeIds.length, 6, "the three rows of this test, the plain row of the last one, and the two of this call");
      assertNear(typeNamed(all!.actual, "600 x 1200 мм").heightMm, 1200, "still the first row's height", SIZE_NEAR_MM);
      assertNear(typeNamed(all!.actual, "600 x 1350 мм").heightMm, 1350, "the first row of the pair, read again", SIZE_NEAR_MM);
      assertNear(typeNamed(all!.actual, "600 x 1650 мм").heightMm, 1650, "the second row of the pair, read again", SIZE_NEAR_MM);
    });
  });

  it("the same file in lower case or with short names is the family that is loaded", async () => {
    await withClient(async (client) => {
      await saved(client);
      const [home] = landed(await loadFamily(client, [{ path: DOOR }]), "already_existed");
      assert.ok(home);
      const sized = typeNamed(home.actual, "750 x 2100 мм");
      assertNear(sized.widthMm, 750, "the sized row, width", SIZE_NEAR_MM);
      assertNear(sized.heightMm, 2100, "the sized row, height", SIZE_NEAR_MM);
      const familiesBefore = (await listTypes(client, "doors")).filter((row) => row.family.toLowerCase() === "дверь-одинарная-панель");
      assert.deepEqual([...new Set(familiesBefore.map((row) => row.family))], ["Дверь-Одинарная-Панель"]);

      // The sized row of the door, then the same file spelled other ways. Windows takes them all for one file, and so does the tool:
      // the row is found, nothing is loaded again, and the size written on it is still there.
      const longLibrary = LIBRARY;
      const shortFile = shortForm(path.win32.join(LIBRARY, DOOR));
      const shortLibrary = shortForm(longLibrary);
      assert.ok(shortFile.startsWith(shortLibrary + "\\"), `${shortFile} should lie below ${shortLibrary}`);
      const shortRelative = shortFile.slice(shortLibrary.length + 1);
      assert.match(shortRelative, /~/, "this volume makes 8.3 names, and the file has one");
      assert.notEqual(shortRelative.toLowerCase(), DOOR.toLowerCase());
      console.log(`# 8.3 spelling of the door: ${shortRelative}`);

      const spellings: Array<[string, string]> = [
        ["lower case", DOOR.toLowerCase()],
        ["upper case", DOOR.toUpperCase()],
        ["mixed case", DOOR.replace("Двери", "дВЕРИ").replace(".rfa", ".RFA")],
        ["8.3 short names", shortRelative],
        ["8.3 short names in lower case", shortRelative.toLowerCase()],
        ["slashes and lower case", DOOR.toLowerCase().replaceAll("\\", "/")],
      ];
      for (const [what, spelled] of spellings) {
        const [row] = landed(await loadFamily(client, [{ path: spelled, typeName: "750 x 2100 мм", widthMm: 750, heightMm: 2100 }]), "already_existed");
        assert.ok(row, what);
        assert.equal(row.elementId, sized.id, `${what}: the same type`);
        assert.equal(row.actual.familyId, home.actual.familyId, `${what}: the same family`);
        assert.deepEqual(row.warnings, [], `${what}: the sizes asked for are the ones it has`);
        assertNear(typeNamed(row.actual, "750 x 2100 мм").widthMm, 750, `${what}: the width stays`, SIZE_NEAR_MM);
        assertNear(typeNamed(row.actual, "750 x 2100 мм").heightMm, 2100, `${what}: the height stays`, SIZE_NEAR_MM);

        const [whole] = landed(await loadFamily(client, [{ path: spelled }]), "already_existed");
        assert.equal(whole!.elementId, home.actual.familyId, `${what}: the whole family`);
      }
      assert.equal(await isModified(client), false, "nothing was loaded again, so the project is as saved");

      // Two spellings of one file in a list are one file, and a repeat.
      const repeated = await refusal(client, "load_family", { items: [{ path: DOOR, typeName: "900 x 2000 мм" }, { path: shortRelative, typeName: "900 x 2000 мм" }] });
      assert.match(repeated.message, /both load type '900 x 2000 мм'/);

      // A row that is not there yet, asked for by the lower-case spelling, lands in the family that is there, and does not make a second family.
      const [fresh] = landed(await loadFamily(client, [{ path: DOOR.toLowerCase(), typeName: "900 x 2000 мм" }]), "created");
      assert.equal(fresh!.actual.familyId, home.actual.familyId, "the new row is in the family that was there");
      const doors = (await listTypes(client, "doors")).filter((row) => row.family.toLowerCase() === "дверь-одинарная-панель");
      assert.deepEqual([...new Set(doors.map((row) => row.family))], ["Дверь-Одинарная-Панель"], "no second family, in another case");
      assert.equal(doors.length, familiesBefore.length + 1);
      const [after] = landed(await loadFamily(client, [{ path: DOOR, typeName: "750 x 2100 мм" }]), "already_existed");
      assertNear(typeNamed(after!.actual, "750 x 2100 мм").heightMm, 2100, "the sized row after a load through another spelling", SIZE_NEAR_MM);
    });
  });

  it("read-only size fails", async () => {
    await withClient(async (client) => {
      const rows = await catalogRows(GOST_DOOR);
      const row = rows[0];
      assert.ok(row, "the catalog has a row");
      const furnitureBefore = await listTypes(client, "furniture");
      const doorsBefore = await listTypes(client, "doors");
      await saved(client);

      // The doors of the GOST folders compute their size, so it cannot be written. The load rolls back: the table before it, and the door itself.
      const batch = await loadFamily(client, [{ path: TABLE }, { path: GOST_DOOR, typeName: row, widthMm: 910, heightMm: 1870 }]);

      assert.equal(batch.committed, false);
      assert.equal(batch.items[0]?.status, "rolled_back");
      assert.equal(batch.items[1]?.status, "failed");
      assert.equal(batch.items[1]?.elementId, null);
      assert.match(batch.items[1]?.error ?? "", /read-only/);
      assert.match(batch.items[1]?.error ?? "", /Nothing was loaded/);
      assert.deepEqual(await listTypes(client, "doors"), doorsBefore, "the GOST door is not in the project");
      assert.deepEqual(await listTypes(client, "furniture"), furnitureBefore, "nor is the table");

      // Height alone is refused the same way, and the same door loads when no size is asked of it.
      const heightOnly = await loadFamily(client, [{ path: GOST_DOOR, typeName: row, heightMm: 1870 }]);
      assert.equal(heightOnly.items[0]?.status, "failed");
      assert.deepEqual(await listTypes(client, "doors"), doorsBefore);
      assert.equal(await isModified(client), false, "a load that failed and rolled back leaves the project as it was saved");

      const [plain] = landed(await loadFamily(client, [{ path: GOST_DOOR, typeName: row }]), "created");
      assert.ok(plain);
      const type = typeNamed(plain.actual, row);
      assertNear(type.widthMm, 970, "the size the family computes for the width", SIZE_NEAR_MM);
      assertNear(type.heightMm, 2070, "the size the family computes for the height", SIZE_NEAR_MM);
      assert.match(plain.warnings.join("\n"), /970 x 2070 mm/, "the warning says what the type really is");

      // A size on a type that was loaded and is read-only is reported and not touched.
      const [again] = landed(await loadFamily(client, [{ path: GOST_DOOR, typeName: row, widthMm: 910 }]), "already_existed");
      assert.match(again!.warnings.join("\n"), /970 mm, not the 910 mm asked for/);

      // A new row with a size that cannot be written, on a family that is in the project now: the item fails, the row is not loaded, and the family is as it was.
      const second = rows[1];
      assert.ok(second && second !== row, "the catalog has a second row");
      const doorsWithOneRow = await listTypes(client, "doors");
      await saved(client);
      const bad = await loadFamily(client, [{ path: GOST_DOOR, typeName: second, widthMm: 910 }]);
      assert.equal(bad.committed, false);
      assert.equal(bad.items[0]?.status, "failed");
      assert.match(bad.items[0]?.error ?? "", /read-only/);
      assert.deepEqual(await listTypes(client, "doors"), doorsWithOneRow, "the second row is not in the family");
      assert.equal(await isModified(client), false, "the failed load changed nothing");
      const [kept] = landed(await loadFamily(client, [{ path: GOST_DOOR }]), "already_existed");
      assert.deepEqual(kept!.actual.typeIds.map((type) => type.name), [row], "the family holds the one row it held");
      assertNear(typeNamed(kept!.actual, row).widthMm, 970, "the row that was there is as it was", SIZE_NEAR_MM);

      // The same row, asked for with no size, lands in the family that is there, and its warning does not advise a size that cannot be set.
      const [next] = landed(await loadFamily(client, [{ path: GOST_DOOR, typeName: second }]), "created");
      assert.equal(next!.actual.familyId, kept!.actual.familyId);
      assert.equal(next!.warnings.length, 1);
      assert.match(next!.warnings[0] ?? "", /970 x 2070 mm/);
      assert.match(next!.warnings[0] ?? "", /computes this size itself, so it cannot be set/);
      assert.doesNotMatch(next!.warnings[0] ?? "", /Give widthMm/);
    });
  });

  it("a path with Cyrillic and spaces survives the whole pipeline", async () => {
    await withClient(async (client) => {
      const rows = await catalogRows(GOST_WINDOW);
      const row = rows[0];
      assert.ok(row?.includes("  "), `the row name keeps its double spaces: ${JSON.stringify(row)}`);
      assert.ok(row);

      const request = { path: GOST_WINDOW, typeName: row, widthMm: 900, heightMm: 1200 };
      const batch = await loadFamily(client, [request]);
      const [window] = landed(batch, "created");
      assert.ok(window);

      assert.deepEqual(window.requested, request, "the path and the type name come back exactly as sent");
      const type = typeNamed(window.actual, row);
      assert.equal(window.elementId, type.id);
      assertNear(type.widthMm, 900, "width", SIZE_NEAR_MM);
      assertNear(type.heightMm, 1200, "height", SIZE_NEAR_MM);
      const windows = await listTypes(client, "windows");
      assert.ok(windows.some((entry) => entry.id === type.id && entry.name === row), "list_types gives the Russian family and the type back as they are");
      assert.ok(windows.some((entry) => entry.family === "Окно 1-Распашное - Один. переплет с несколькими оконными стеклами - ГОСТ 30674-99"));

      // The same file spelled another way is the same file: a slash for the backslash and the extension in capitals.
      const respelled = GOST_WINDOW.replaceAll("\\", "/").replace(/\.rfa$/, ".RFA");
      const [same] = landed(await loadFamily(client, [{ path: respelled, typeName: row }]), "already_existed");
      assert.equal(same!.elementId, type.id);
    });
  });

  it("the same family twice in one list is refused", async () => {
    await withClient(async (client) => {
      const before = await listTypes(client, "furniture");
      await saved(client);

      const cases: Array<[string, unknown[], RegExp]> = [
        ["the whole family twice", [{ path: TABLE }, { path: TABLE }], /items 0 and 1 both load the whole family/],
        ["the same file in another spelling", [{ path: TABLE }, { path: TABLE.replaceAll("\\", "/").replace(/\.rfa$/, ".RFA") }], /items 0 and 1 both load the whole family/],
        ["two files of one name", [{ path: STEEL_COLUMN_BELARUS }, { path: STEEL_COLUMN_UKRAINE }], /different files that are all called 'I-образная колонна'/],
        ["the same type twice", [{ path: DOOR, typeName: "850 x 2000 мм" }, { path: DOOR, typeName: "850 x 2000 мм" }], /both load type '850 x 2000 мм'/],
        ["the whole family and a type of it", [{ path: TABLE }, { path: BED, typeName: "x" }, { path: SLIDING_DOOR }, { path: SLIDING_DOOR, typeName: "x" }], /loads the whole family .*name a type of it/],
      ];
      for (const [what, items, message] of cases) {
        const refused = await refusal(client, "load_family", { items });
        console.log(`# ${what}: ${refused.message.slice(0, 200)}`);
        assert.match(refused.message, message, what);
      }

      assert.deepEqual(await listTypes(client, "furniture"), before);
      assert.equal(await isModified(client), false, "a refused list changes nothing");

      // Two types of one family are not a repeat. Both land, in one call, as one family.
      const batch = await loadFamily(client, [{ path: DOOR, typeName: "750 x 2000 мм" }, { path: DOOR, typeName: "850 x 2000 мм" }]);
      const rows = landed(batch, "created");
      assert.equal(rows[0]?.actual.familyId, rows[1]?.actual.familyId);
      assert.notEqual(rows[0]?.elementId, rows[1]?.elementId);
    });
  });

  it("a type of another file with the name of a family in the project is not added, and the answer says why", async () => {
    await withClient(async (client) => {
      const rowsA = await catalogRows(STEEL_FRAME_A);
      const rowsB = await catalogRows(STEEL_FRAME_B);
      const [first, second] = rowsA;
      const onlyInB = rowsB.find((row) => !rowsA.includes(row));
      const inBoth = rowsB.find((row) => rowsA.includes(row) && row !== first && row !== second);
      assert.ok(first && second && onlyInB && inBoth, "the two catalogs share rows and each has its own");

      // Row of file A: the family is in the project. Rows of file B, one of them in both catalogs, are not added to it.
      const [a] = landed(await loadFamily(client, [{ path: STEEL_FRAME_A, typeName: first }]), "created");
      assert.ok(a);
      await saved(client);
      for (const [what, typeName] of [["a row only file B has", onlyInB], ["a row both files have", inBoth]] as const) {
        const batch = await loadFamily(client, [{ path: STEEL_FRAME_B, typeName }]);
        console.log(`# ${what}: ${batch.items[0]?.status}, ${batch.items[0]?.error?.slice(0, 260)}`);
        assert.equal(batch.committed, false, what);
        assert.equal(batch.items[0]?.status, "failed", what);
        assert.match(batch.items[0]?.error ?? "", /another library file of the same name/, what);
        assert.doesNotMatch(batch.items[0]?.error ?? "", /neither a type stored in the family/, `${what}: that would be false, the row is in the catalog`);
      }
      assert.equal(await isModified(client), false, "nothing changed");

      // The family is as it was, and the whole family of file B is the family that is there, reported as such.
      const [whole] = landed(await loadFamily(client, [{ path: STEEL_FRAME_B }]), "already_existed");
      assert.equal(whole!.actual.familyId, a.actual.familyId);
      assert.deepEqual(whole!.actual.typeIds.map((type) => type.name), [first], "the types of the family that is there, which came from file A");
      assert.equal(await isModified(client), false);

      // A row of file A, the file the family came from, does land: it is the file that decides, not the family.
      const [more] = landed(await loadFamily(client, [{ path: STEEL_FRAME_A, typeName: second }]), "created");
      assert.equal(more!.actual.familyId, a.actual.familyId);
      const [both] = landed(await loadFamily(client, [{ path: STEEL_FRAME_A }]), "already_existed");
      assert.deepEqual(both!.actual.typeIds.map((type) => type.name).sort(), [first, second].sort());
    });
  });

  it("path outside the library is refused and nothing loads", async () => {
    await withClient(async (client) => {
      const before = [await listTypes(client, "furniture"), await listTypes(client, "doors"), await listTypes(client, "windows")];
      await saved(client);

      const cases: Array<[string, string, RegExp]> = [
        ["parent folder", "..\\Templates\\Russian\\DefaultRUSRUS.rfa", /'\.\.'/],
        ["parent folder, deeper", "Russia\\..\\..\\..\\Autodesk\\x.rfa", /'\.\.'/],
        ["parent folder, staying inside", "Russia\\Мебель\\..\\Мебель\\Кровати\\Кровать-Стандарт.rfa", /'\.\.'/],
        ["absolute path", "C:\\Windows\\System32\\x.rfa", /relative/],
        ["absolute path to the library itself", path.win32.join(LIBRARY, BED), /relative/],
        ["share", "\\\\server\\share\\x.rfa", /relative/],
        ["a template", "..\\..\\Templates\\Russian\\DefaultRUSRUS.rte", /'\.\.'/],
        ["the catalog, not the family", BED.replace(/\.rfa$/, ".txt"), /\.rfa/],
        ["a project", "Russia\\Мебель\\x.rvt", /\.rfa/],
        ["a stream", `${BED}:stream`, /forbids/],
        ["a file that is not there", "Russia\\Мебель\\Кровати\\Нет-такой-кровати.rfa", /no such file/],
        ["a folder", "Russia\\Мебель\\Кровати", /\.rfa/],
        ["empty", "", /empty/],
      ];
      for (const [what, bad, message] of cases) {
        // A good item first, so that a refusal that came after the first item had been loaded would show.
        const refused = await refusal(client, "load_family", { items: [{ path: TABLE }, { path: bad }] });
        console.log(`# ${what}: ${refused.message.slice(0, 220)}`);
        assert.match(refused.message, message, what);
        assert.match(refused.message, /load_family item 1/, `${what}: the refusal should name the item`);
      }

      assert.deepEqual([await listTypes(client, "furniture"), await listTypes(client, "doors"), await listTypes(client, "windows")], before);
      assert.equal(await isModified(client), false, "nothing was loaded, not even the good item before the bad one");
    });
  });

  it("furniture stands at the requested point and rotation", async () => {
    await withClient(async (client) => {
      const w = ready();
      const bed = w.bed;
      assert.ok(bed);
      const y = 40000;

      const batch = await place(client, [
        { typeId: bed.id, pointMm: { x: 1000, y }, levelId: w.ground.id },
        { typeId: bed.id, pointMm: { x: 4000.5, y: y + 2000.25 }, levelId: w.ground.id, rotationDeg: 90 },
        { typeId: bed.id, pointMm: { x: -3000, y: y - 1500 }, levelId: w.ground.id, rotationDeg: -90 },
        { typeId: bed.id, pointMm: { x: 8000, y }, levelId: w.ground.id, rotationDeg: 450 },
        { typeId: bed.id, pointMm: { x: 1000, y: y + 6000 }, levelId: w.upper.id, rotationDeg: 30 },
      ]);
      const placed = landed(batch, "created");
      assert.deepEqual(batch.warnings, []);
      for (const item of placed) {
        assert.deepEqual(item.warnings, []);
        assert.equal(item.actual.typeId, bed.id);
        assert.equal(item.actual.hostWallId, null);
        assert.equal(item.actual.facingFlipped, false);
        assertNear(item.actual.elevationMm, 0, "a bed stands on its level");
      }

      const [flat, quarter, back, full, up] = placed;
      assertNear(flat!.actual.pointMm.x, 1000, "x");
      assertNear(flat!.actual.pointMm.y, y, "y");
      assertNear(flat!.actual.rotationDeg, 0, "no rotation", 1e-6);
      assertNear(quarter!.actual.pointMm.x, 4000.5, "x with decimals");
      assertNear(quarter!.actual.pointMm.y, y + 2000.25, "y with decimals");
      assertNear(quarter!.actual.rotationDeg, 90, "a quarter turn", 1e-6);
      assertNear(back!.actual.rotationDeg, 270, "-90 is 270", 1e-6);
      assertNear(full!.actual.rotationDeg, 90, "450 is 90", 1e-6);
      assertNear(up!.actual.rotationDeg, 30, "30", 1e-6);
      assert.equal(flat!.actual.levelId, w.ground.id);
      assert.equal(up!.actual.levelId, w.upper.id, "the level is the one asked for");

      // The model agrees with actual: boxes from get_elements. A bed turned a quarter is as wide as the other is deep, and the upper one stands on the upper level.
      const boxes = (await elementsOf(client, placed.map((item) => item.elementId))).elements;
      const size = (index: number): { x: number; y: number } => {
        const box = boxes[index]?.boundingBoxMm;
        assert.ok(box);
        return { x: box.max.x - box.min.x, y: box.max.y - box.min.y };
      };
      assertNear(size(1).x, size(0).y, "a bed turned by 90 swaps its sides", 1);
      assertNear(size(1).y, size(0).x, "a bed turned by 90 swaps its sides", 1);
      assertNear(size(2).x, size(0).y, "-90 swaps them too", 1);
      assertNear(size(3).x, size(1).x, "450 is 90", 1);
      assert.equal(boxes[4]?.levelId, w.upper.id);
      assertNear(boxes[4]?.boundingBoxMm?.min.z, UPPER_LEVEL_MM, "the foot of the bed on the upper level", 1);
      assertNear(boxes[0]?.boundingBoxMm?.min.z, 0, "the foot of the bed on the ground level", 1);

      // A height the family keeps is not given another: the item fails, says where Revit put the bed, and the batch rolls back.
      const before = countOf(await modelInfo(client), "OST_Furniture");
      const raised = await place(client, [
        { typeId: bed.id, pointMm: { x: 1000, y: y + 9000 }, levelId: w.ground.id },
        { typeId: bed.id, pointMm: { x: 2000, y: y + 9000 }, levelId: w.ground.id, elevationMm: 100 },
      ]);
      assert.equal(raised.committed, false);
      assert.equal(raised.items[0]?.status, "rolled_back");
      assert.equal(raised.items[1]?.status, "failed");
      assert.match(raised.items[1]?.error ?? "", /0 mm above level/);
      assert.match(raised.items[1]?.error ?? "", /not the 100 mm asked for in elevationMm/);
      assert.equal(countOf(await modelInfo(client), "OST_Furniture"), before, "the first bed is gone with the second");
    });
  });

  it("WC and sink are placed by the way the probe found", async () => {
    await withClient(async (client) => {
      const w = ready();

      const loaded = landed(await loadFamily(client, [{ path: WC }, { path: SINK }, { path: BATH }]), "created");
      assert.deepEqual(loaded.map((item) => item.actual.typeIds.length), [1, 1, 1]);
      const [wc, sink, bath] = loaded.map((item) => item.actual.typeIds[0]);
      assert.ok(wc && sink && bath);
      w.wc = wc;
      w.sink = sink;
      w.bath = bath;
      const y = 60000;

      // The toilet of the probe stands on the level and has no wall. Any height is taken, and the angle too.
      const free = landed(
        await place(client, [
          { typeId: wc.id, pointMm: { x: 1000, y }, levelId: w.ground.id },
          { typeId: wc.id, pointMm: { x: 2000, y }, levelId: w.ground.id, elevationMm: 500, rotationDeg: 180 },
          { typeId: wc.id, pointMm: { x: 3000, y }, levelId: w.upper.id },
          { typeId: wc.id, pointMm: { x: 4000, y }, levelId: w.upper.id, elevationMm: 100 },
          { typeId: wc.id, pointMm: { x: 5000, y }, levelId: w.ground.id, rotationDeg: 90 },
        ]),
        "created",
      );
      assertNear(free[1]?.actual.elevationMm, 500, "the toilet on a stand of 500");
      assertNear(free[1]?.actual.rotationDeg, 180, "turned round", 1e-6);
      assertNear(free[2]?.actual.elevationMm, 0, "on the upper level the height is above that level");
      assert.equal(free[2]?.actual.levelId, w.upper.id);
      assertNear(free[3]?.actual.elevationMm, 100, "100 above the upper level");
      const boxes = (await elementsOf(client, free.map((item) => item.elementId))).elements;
      assertNear(boxes[0]?.boundingBoxMm?.min.z, 0, "the foot of the first toilet", 1);
      assertNear(boxes[1]?.boundingBoxMm?.min.z, 500, "the foot of the raised toilet", 1);
      assertNear(boxes[2]?.boundingBoxMm?.min.z, UPPER_LEVEL_MM, "the foot of the toilet on the upper level", 1);
      assertNear(boxes[3]?.boundingBoxMm?.min.z, UPPER_LEVEL_MM + 100, "the foot of the raised toilet on the upper level", 1);

      // Which way a positive angle turns: the offset of the middle of the box from the point is turned by the same angle, counter-clockwise seen from above.
      const middle = (index: number): { x: number; y: number } => {
        const box = boxes[index]?.boundingBoxMm;
        const item = free[index];
        assert.ok(box && item);
        return { x: (box.min.x + box.max.x) / 2 - item.actual.pointMm.x, y: (box.min.y + box.max.y) / 2 - item.actual.pointMm.y };
      };
      const offset0 = middle(0);
      const offset90 = middle(4);
      const offset180 = middle(1);
      console.log(`# offset of the box middle from the point: at 0 ${JSON.stringify(offset0)}, at 90 ${JSON.stringify(offset90)}, at 180 ${JSON.stringify(offset180)}`);
      assert.ok(Math.hypot(offset0.x, offset0.y) > 20, "the origin of the toilet is not the middle of its box, or this check proves nothing");
      assertNear(offset90.x, -offset0.y, "a quarter turn counter-clockwise takes (x, y) to (-y, x)", 2);
      assertNear(offset90.y, offset0.x, "a quarter turn counter-clockwise takes (x, y) to (-y, x)", 2);
      assertNear(offset180.x, -offset0.x, "a half turn takes (x, y) to (-x, -y)", 2);
      assertNear(offset180.y, -offset0.y, "a half turn takes (x, y) to (-x, -y)", 2);

      // The sink and the bath hang on a wall. The point goes onto the axis of the wall, and the item says so.
      const hosted = await place(client, [
        { typeId: sink.id, pointMm: { x: 3000, y: 300 }, levelId: w.ground.id, hostWallId: w.wallA },
        { typeId: sink.id, pointMm: { x: 5000, y: 0 }, levelId: w.ground.id, hostWallId: w.wallA, flipFacing: true },
        { typeId: bath.id, pointMm: { x: 6000, y: 2500 }, levelId: w.ground.id, hostWallId: w.wallB },
        { typeId: bath.id, pointMm: { x: 6000, y: 4000 }, levelId: w.ground.id, hostWallId: w.wallB, flipFacing: true },
        { typeId: sink.id, pointMm: { x: 2000, y: 100 }, levelId: w.upper.id, hostWallId: w.wallUpper },
      ]);
      const [near, flipped, bathA, bathB, up] = landed(hosted, "created");
      assert.ok(near && flipped && bathA && bathB && up);

      assertNear(near.actual.pointMm.x, 3000, "along the wall");
      assertNear(near.actual.pointMm.y, 0, "on the axis, 300 mm from the point");
      assert.equal(near.actual.hostWallId, w.wallA);
      assertNear(near.actual.elevationMm, 0, "the sink stands at the level");
      assert.equal(near.actual.facingFlipped, false);
      assert.equal(near.warnings.length, 1);
      assert.match(near.warnings[0] ?? "", /300 mm from pointMm/);

      assert.deepEqual(flipped.warnings, [], "a point on the axis is not moved");
      assert.equal(flipped.actual.facingFlipped, true, "flipFacing was done");
      assert.equal(flipped.actual.hostWallId, w.wallA);

      // A wall that runs along +Y turns its fixtures a quarter, and the flip only changes the side.
      assertNear(bathA.actual.rotationDeg, 90, "the bath follows the wall that runs along y", 1e-6);
      assertNear(bathA.actual.pointMm.x, 6000, "bath x");
      assertNear(bathA.actual.pointMm.y, 2500, "bath y");
      assert.equal(bathA.actual.hostWallId, w.wallB);
      assert.equal(bathA.actual.facingFlipped, false);
      assert.equal(bathB.actual.facingFlipped, true);

      // The upper wall: the height asked for is the level of the wall.
      assert.equal(up.actual.hostWallId, w.wallUpper);
      assert.equal(up.actual.levelId, w.upper.id);
      assertNear(up.actual.pointMm.y, 0, "on the axis of the upper wall");
      const hung = (await elementsOf(client, [near.elementId, up.elementId])).elements;
      assertNear(hung[1]?.boundingBoxMm?.min.z, UPPER_LEVEL_MM, "the sink on the upper wall stands on the upper level", 1);
      assertNear(hung[0]?.boundingBoxMm?.min.z, 0, "the sink on the ground wall stands on the ground level", 1);
      assert.ok((hung[0]?.boundingBoxMm?.max.z ?? 0) < 3000, "a sink fits under the wall top");
    });
  });

  it("hosted family without a wall is refused before any change", async () => {
    await withClient(async (client) => {
      const w = ready();
      const { bed, wc, sink, bath } = w;
      assert.ok(bed && wc && sink && bath);
      const before = await modelInfo(client);
      const point = { x: 30000, y: 30000 };
      await saved(client);

      // A good item first, so that a refusal that came after it was placed would show. The refusal names the item and says what to give.
      const refusals: Array<[string, object, RegExp]> = [
        ["a sink with no wall", { typeId: sink.id, pointMm: point, levelId: w.ground.id }, /needs the wall it hangs on in hostWallId/],
        ["a bath with no wall", { typeId: bath.id, pointMm: point, levelId: w.ground.id }, /wrong place with no geometry/],
        ["a sink with a wall, turned", { typeId: sink.id, pointMm: point, levelId: w.ground.id, hostWallId: w.wallA, rotationDeg: 90 }, /takes its direction from the wall/],
        ["a toilet on a level, with a wall", { typeId: wc.id, pointMm: point, levelId: w.ground.id, hostWallId: w.wallA }, /stands on a level and has no host/],
        ["a toilet on a level, flipped", { typeId: wc.id, pointMm: point, levelId: w.ground.id, flipFacing: true }, /Turn it with rotationDeg/],
        ["a sink on a wall that is no wall", { typeId: sink.id, pointMm: point, levelId: w.ground.id, hostWallId: w.ground.id }, /is not one of the walls of this model/],
      ];
      for (const [what, bad, message] of refusals) {
        const refused = await refusal(client, "place_instances", { items: [{ typeId: bed.id, pointMm: point, levelId: w.ground.id }, bad] });
        console.log(`# ${what}: ${refused.message.slice(0, 220)}`);
        assert.match(refused.message, message, what);
        assert.match(refused.message, /place_instances item 1/, `${what}: the refusal should name the item`);
      }

      // A family of a placement type that this tool does not handle is refused by name, not guessed.
      const [column] = landed(await loadFamily(client, [{ path: COLUMN }]), "created");
      assert.ok(column);
      await saved(client);
      const columnType = column.actual.typeIds[0];
      assert.ok(columnType);
      const refusedColumn = await refusal(client, "place_instances", { items: [{ typeId: columnType.id, pointMm: point, levelId: w.ground.id }] });
      assert.match(refusedColumn.message, /placement type TwoLevelsBased/);
      assert.match(refusedColumn.message, /OneLevelBased and OneLevelBasedHosted/);

      // A family hosted by a ceiling is hosted, and the wall that is given cannot host it. Its family says so in its Host parameter, so it is refused by name before anything changes.
      const [light] = landed(await loadFamily(client, [{ path: CEILING_LIGHT }]), "created");
      assert.ok(light);
      await saved(client);
      const lightType = light.actual.typeIds[0];
      assert.ok(lightType);
      const lights: Array<[string, object]> = [
        ["a ceiling light with no wall", { typeId: lightType.id, pointMm: point, levelId: w.ground.id }],
        ["a ceiling light on the axis of a wall", { typeId: lightType.id, pointMm: { x: 3000, y: 0 }, levelId: w.ground.id, hostWallId: w.wallA, elevationMm: 2400 }],
        ["a ceiling light beside a wall", { typeId: lightType.id, pointMm: { x: 3000, y: 200 }, levelId: w.ground.id, hostWallId: w.wallA, elevationMm: 2400 }],
      ];
      for (const [what, bad] of lights) {
        const refused = await refusal(client, "place_instances", { items: [{ typeId: bed.id, pointMm: point, levelId: w.ground.id }, bad] });
        console.log(`# ${what}: ${refused.message.slice(0, 240)}`);
        assert.match(refused.message, /hangs on a ceiling, as its family says, and not on a wall/, what);
        assert.match(refused.message, /place_instances item 1/, `${what}: the refusal should name the item`);
      }
      assert.equal(await isModified(client), false, "nothing was placed, not even the bed before the light");

      const after = await modelInfo(client);
      for (const category of ["OST_Furniture", "OST_PlumbingFixtures", "OST_Columns", "OST_StructuralColumns", "OST_LightingFixtures"]) {
        assert.equal(countOf(after, category), countOf(before, category), category);
      }
      assert.equal(await isModified(client), false, "a refused call changes nothing");
    });
  });

  it("a point on the wrong level or a level id that is not a level is refused before any change", async () => {
    await withClient(async (client) => {
      const w = ready();
      const { bed, sink } = w;
      assert.ok(bed && sink);
      const before = await modelInfo(client);
      const point = { x: 30000, y: 30000 };
      await saved(client);

      const refusals: Array<[string, object, RegExp]> = [
        ["the ground wall on the upper level", { typeId: sink.id, pointMm: { x: 3000, y: 0 }, levelId: w.upper.id, hostWallId: w.wallA }, /runs from .* to 3000 mm, so it does not reach that height/],
        ["the upper wall on the ground level", { typeId: sink.id, pointMm: { x: 3000, y: 0 }, levelId: w.ground.id, hostWallId: w.wallUpper }, /runs from 4000 mm to 7000 mm/],
        ["a wall above its top", { typeId: sink.id, pointMm: { x: 3000, y: 0 }, levelId: w.ground.id, hostWallId: w.wallA, elevationMm: 3500 }, /levelId may name the wrong level/],
        ["a wall id for the level", { typeId: bed.id, pointMm: point, levelId: w.wallA }, /is not a level\. The levels of this project/],
        ["a type id for the level", { typeId: bed.id, pointMm: point, levelId: bed.id }, /is not a level/],
        ["a number for the level", { typeId: bed.id, pointMm: point, levelId: 311 }, /levelId must be an element id, as text/],
        ["no level", { typeId: bed.id, pointMm: point }, /levelId must be an element id/],
        ["a level for the type", { typeId: w.ground.id, pointMm: point, levelId: w.ground.id }, /is not a type of a loaded family/],
        ["a wall type for the type", { typeId: w.wallType.id, pointMm: point, levelId: w.ground.id }, /is not a type of a loaded family/],
        ["an id that is nothing", { typeId: "999999999", pointMm: point, levelId: w.ground.id }, /is not a type of a loaded family/],
      ];
      for (const [what, bad, message] of refusals) {
        const refused = await refusal(client, "place_instances", { items: [{ typeId: bed.id, pointMm: point, levelId: w.ground.id }, bad] });
        console.log(`# ${what}: ${refused.message.slice(0, 220)}`);
        assert.match(refused.message, message, what);
        assert.match(refused.message, /place_instances item 1/, `${what}: the refusal should name the item`);
      }

      const after = await modelInfo(client);
      for (const category of ["OST_Furniture", "OST_PlumbingFixtures"]) {
        assert.equal(countOf(after, category), countOf(before, category), category);
      }
      assert.equal(await isModified(client), false, "a refused call changes nothing");
    });
  });

  it("place_instances refuses doors and windows before any change, and points to place_hosted", async () => {
    await withClient(async (client) => {
      const w = ready();
      const { bed } = w;
      assert.ok(bed);

      // The rows may be in the project from the tests above or not, so either status will do: the types are what is wanted.
      const doorBatch = await loadFamily(client, [{ path: DOOR, typeName: "800 x 2100 мм" }]);
      const windowBatch = await loadFamily(client, [{ path: WINDOW, typeName: "600 x 1200 мм" }]);
      assertLanded(doorBatch);
      assertLanded(windowBatch);
      const door = doorBatch.items[0]?.actual?.typeIds[0];
      const window = windowBatch.items[0]?.actual?.typeIds[0];
      assert.ok(door && window);

      await saved(client);
      const before = await modelInfo(client);

      // The wall is the right one and the point is on it: nothing but the kind of the type is wrong. place_instances put a door there
      // and said nothing of whether it cut the wall, so it does not place one.
      for (const [what, type] of [["a door", door], ["a window", window]] as const) {
        const refused = await refusal(client, "place_instances", {
          items: [
            { typeId: bed.id, pointMm: { x: 3000, y: 90000 }, levelId: w.ground.id },
            { typeId: type.id, pointMm: { x: 3000, y: 0 }, levelId: w.ground.id, hostWallId: w.wallA },
          ],
        });
        assert.match(refused.message, /place_instances item 1/, `${what}: the refusal should name the item`);
        assert.match(refused.message, /is a door or window type, and this tool does not place those/, what);
        assert.match(refused.message, /Use place_hosted/, what);
        assert.ok(refused.message.includes(type.id), `${what}: the message names the type ${type.id}`);
      }

      const after = await modelInfo(client);
      for (const category of ["OST_Furniture", "OST_Doors", "OST_Windows"]) {
        assert.equal(countOf(after, category), countOf(before, category), category);
      }
      assert.equal(await isModified(client), false, "a refused call changes nothing");
    });
  });

  it("a size written on a bare opening is refused and nothing stays loaded", async () => {
    await withClient(async (client) => {
      await saved(client);
      const doorsBefore = await listTypes(client, "doors");

      // The width and height of a bare opening read 0, and Revit takes any value for them and reads it back, as it does for a door panel.
      // The opening is cut at its rough size all the same, so such a write is a size that changes nothing, and the item fails.
      const refused = await loadFamily(client, [{ path: "Russia\\Двери\\Дверь-Проем.rfa", typeName: "0762 x 2032 мм", widthMm: 1200, heightMm: 2400 }]);
      assert.equal(refused.committed, false, JSON.stringify(refused).slice(0, 600));
      assert.equal(refused.items[0]?.status, "failed");
      assert.match(refused.items[0]?.error ?? "", /nothing else in the type moved/);
      assert.match(refused.items[0]?.error ?? "", /widthMm 1200 and heightMm 2400 for type '0762 x 2032 мм' of family 'Дверь-Проем'/);
      assert.match(refused.items[0]?.error ?? "", /Rough Width and Rough Height/);
      assert.deepEqual(await listTypes(client, "doors"), doorsBefore, "the row is not in the project");
      assert.equal(await isModified(client), false);

      // The same row with no size loads, and its Width and Height read 0.
      const [row] = landed(await loadFamily(client, [{ path: "Russia\\Двери\\Дверь-Проем.rfa", typeName: "0762 x 2032 мм" }]), "created");
      assert.equal(row?.actual.typeIds[0]?.widthMm, 0);
      assert.equal(row?.actual.typeIds[0]?.heightMm, 0);
    });
  });

  it("a batch of placements is one Undo step, and so is a batch of loads", { timeout: 450_000 }, async (t) => {
    await withClient(async (client) => {
      const w = ready();
      const { bed, wc, sink } = w;
      assert.ok(bed && wc && sink);
      const y = 80000;

      const furnitureBefore = countOf(await modelInfo(client), "OST_Furniture");
      const plumbingBefore = countOf(await modelInfo(client), "OST_PlumbingFixtures");
      const batch = await place(client, [
        { typeId: bed.id, pointMm: { x: 1000, y }, levelId: w.ground.id },
        { typeId: bed.id, pointMm: { x: 3000, y }, levelId: w.ground.id, rotationDeg: 45 },
        { typeId: wc.id, pointMm: { x: 5000, y }, levelId: w.ground.id },
        { typeId: sink.id, pointMm: { x: 2000, y: 0 }, levelId: w.ground.id, hostWallId: w.wallA },
      ]);
      const placed = landed(batch, "created");
      const info = await modelInfo(client);
      assert.equal(countOf(info, "OST_Furniture"), furnitureBefore + 2);
      assert.equal(countOf(info, "OST_PlumbingFixtures"), plumbingBefore + 2);

      const undone = await undoWithOneRetry(t, client);
      console.log(`# undo of place_instances: ${JSON.stringify(undone)}`);
      assert.equal(undone.state, "undone", JSON.stringify(undone));
      assert.equal(undone.transactionName, "MCP: place_instances");
      for (const item of placed) {
        assert.ok(undone.createdIds.includes(item.elementId), `${item.elementId} should be among the created ids of the undo`);
      }
      assert.deepEqual((await elementsOf(client, placed.map((item) => item.elementId))).notFound.sort(), placed.map((item) => item.elementId).sort());
      const back = await modelInfo(client);
      assert.equal(countOf(back, "OST_Furniture"), furnitureBefore);
      assert.equal(countOf(back, "OST_PlumbingFixtures"), plumbingBefore);

      // Loading is one step too: two families and a row of a third come off together, and the families are not in the project any more.
      const doorsBefore = await listTypes(client, "doors");
      const furnitureTypesBefore = await listTypes(client, "furniture");

      const loads = landed(await loadFamily(client, [{ path: TABLE }, { path: SLIDING_DOOR }, { path: DOOR, typeName: "900 x 2100 мм" }]), "created");
      assert.equal(loads.length, 3);
      // A whole family with a catalog brings every row of it, and the warning says that Revit ignored the sizes of those rows.
      assert.equal(loads[1]?.actual.typeIds.length, (await catalogRows(SLIDING_DOOR)).length, "every row of the catalog is a type");
      assert.match(loads[1]?.warnings.join("\n") ?? "", /type catalog/);
      assert.equal(loads[1]?.elementId, loads[1]?.actual.familyId);
      assert.deepEqual(loads[0]?.warnings, [], "a family with no catalog has nothing to warn about");
      assert.ok((await listTypes(client, "furniture")).length > furnitureTypesBefore.length);
      assert.ok((await listTypes(client, "doors")).length > doorsBefore.length + 1);

      const unloaded = await undoWithOneRetry(t, client);
      console.log(`# undo of load_family: ${JSON.stringify(unloaded)}`);
      assert.equal(unloaded.state, "undone", JSON.stringify(unloaded));
      assert.equal(unloaded.transactionName, "MCP: load_family");
      assert.deepEqual(await listTypes(client, "furniture"), furnitureTypesBefore, "the table is gone");
      assert.deepEqual(await listTypes(client, "doors"), doorsBefore, "the sliding door and the row are gone");
      assert.ok(unloaded.createdIds.length > 0, "the families and types the load made are listed");
    });
  });

  it("leaves Revit in a state the close rule accepts", async () => {
    await withClient(async (client) => {
      await client.call("save_project", {});
      assert.deepEqual(checkCanClose((await modelInfo(client)).openDocuments), { ok: true, reasons: [] });
    });
  });
});
