import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { checkCanClose } from "../../src/cli/closeRule.ts";
import { BridgeClient } from "../../src/client.ts";
import { defaultConnectionPath } from "../../src/connection.ts";
import { BridgeRpcError } from "../../src/errors.ts";

// These tests need a running Revit with the RevitMCP plugin loaded. Each run creates one new project in the test
// folder and leaves it open and saved. Coordinates stay far apart between tests, so the walls of one do not join another's.

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
  views: Array<{ id: string; name: string; viewType: string }>;
  categoryCounts: Array<{ category: string | null; count: number }>;
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

interface ElementRow {
  id: string;
  category: string | null;
  typeName: string | null;
  levelId: string | null;
  boundingBoxMm: Box | null;
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
  ground: Level;
  upper: Level;
}

const INVALID_PARAMS = -32602;
const NEAR_MM = 0.01;
// More than the 30000 feet Revit allows, which the tool leaves to Revit, so this reaches the transaction.
const TOO_HIGH_MM = 10_000_000;

const stamp = new Date().toTimeString().slice(0, 8).replaceAll(":", "");
const name = `проверка-задача11-${stamp}`;

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
  const [ground, upper] = levels;
  const [wallType] = walls;
  const [floorType] = floors;
  assert.ok(ground && upper && wallType && floorType);

  return { wallType, floorType, ground, upper };
}

async function readElements(client: BridgeClient, ids: Array<string | null>): Promise<ElementRow[]> {
  const { elements, notFound } = (await client.call("get_elements", { ids })) as { elements: ElementRow[]; notFound: string[] };
  assert.deepEqual(notFound, []);
  return elements;
}

function assertNear(actual: unknown, expected: number, what: string): void {
  assert.equal(typeof actual, "number", what);
  assert.ok(Math.abs((actual as number) - expected) < NEAR_MM, `${what}: ${String(actual)}, expected ${expected}`);
}

function assertLanded(batch: Batch): void {
  assert.equal(batch.committed, true, JSON.stringify(batch));
  assert.deepEqual(batch.errors, []);
  assert.deepEqual(batch.dialogs, []);
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

describe("stage 2 live checks: levels, walls and floors", { timeout: 120_000 }, () => {
  it("creates a project for this run", async () => {
    await withClient(async (client) => {
      await client.call("create_project", { name });
      const info = await modelInfo(client);
      console.log(`# levels of the template: ${JSON.stringify(info.levels)}`);

      assert.equal(info.activeDocument?.title, name);
    });
  });

  it("creates levels with Cyrillic names", async () => {
    await withClient(async (client) => {
      const before = await modelInfo(client);

      const batch = await call(client, "create_levels", [
        { name: "Этаж проба 1", elevationMm: 6000 },
        { name: "Чердак без плана", elevationMm: 9150.5, createPlan: false },
      ]);
      console.log(`# create_levels: ${JSON.stringify(batch)}`);

      assertLanded(batch);
      assert.deepEqual(batch.items.map((item) => [item.index, item.status]), [[0, "created"], [1, "created"]]);

      const [first, second] = batch.items;
      assert.ok(first && second);
      assert.equal(first.actual?.["name"], "Этаж проба 1");
      assertNear(first.actual?.["elevationMm"], 6000, "elevation of the first");
      assert.equal(typeof first.actual?.["planViewId"], "string");
      assert.equal(second.actual?.["name"], "Чердак без плана");
      assertNear(second.actual?.["elevationMm"], 9150.5, "elevation of the second");
      assert.equal(second.actual?.["planViewId"], null);

      const after = await modelInfo(client);
      assert.equal(after.levels.length, before.levels.length + 2);
      assert.equal(after.levels.find((level) => level.id === first.elementId)?.name, "Этаж проба 1");

      const plan = after.views.find((view) => view.id === first.actual?.["planViewId"]);
      console.log(`# plan of the level: ${JSON.stringify(plan)}`);
      assert.equal(plan?.viewType, "FloorPlan");
      assert.equal(plan?.name, first.actual?.["planViewName"]);
      assert.equal(after.views.length, before.views.length + 1);
    });
  });

  it("existing level returns already_existed", async () => {
    await withClient(async (client) => {
      const info = await modelInfo(client);
      const existing = info.levels.find((level) => level.name === "Этаж проба 1");
      assert.ok(existing);

      const same = await call(client, "create_levels", [{ name: "Этаж проба 1", elevationMm: 6000 }]);
      console.log(`# same elevation: ${JSON.stringify(same)}`);

      assertLanded(same);
      assert.equal(same.items[0]?.status, "already_existed");
      assert.equal(same.items[0]?.elementId, existing.id);
      assert.deepEqual(same.items[0]?.warnings, []);

      const other = await call(client, "create_levels", [{ name: "Этаж проба 1", elevationMm: 6500 }]);
      console.log(`# other elevation: ${JSON.stringify(other)}`);

      assert.equal(other.items[0]?.status, "already_existed");
      assert.equal(other.items[0]?.elementId, existing.id);
      assertNear(other.items[0]?.actual?.["elevationMm"], 6000, "the real elevation");
      assert.equal(other.items[0]?.warnings.length, 1);
      assert.match(other.items[0]?.warnings[0] ?? "", /6000/);
      assert.match(other.items[0]?.warnings[0] ?? "", /6500/);

      const noPlan = await call(client, "create_levels", [{ name: "Чердак без плана", elevationMm: 9150.5, createPlan: true }]);
      console.log(`# no plan: ${JSON.stringify(noPlan)}`);

      assert.equal(noPlan.items[0]?.status, "already_existed");
      assert.equal(noPlan.items[0]?.actual?.["planViewId"], null);
      assert.equal(noPlan.items[0]?.warnings.length, 1);

      const after = await modelInfo(client);
      assert.equal(after.levels.length, info.levels.length);
      assert.equal(after.views.length, info.views.length);
    });
  });

  it("a name that differs by case only is another level, as Revit takes it", async () => {
    await withClient(async (client) => {
      const batch = await call(client, "create_levels", [{ name: "ЭТАЖ ПРОБА 1", elevationMm: 13000 }]);
      console.log(`# name that differs by case only: ${JSON.stringify(batch)}`);

      assertLanded(batch);
      assert.equal(batch.items[0]?.status, "created");
      assert.equal(batch.items[0]?.actual?.["name"], "ЭТАЖ ПРОБА 1");
    });
  });

  it("create_levels refuses a list it cannot honour and creates nothing", async () => {
    await withClient(async (client) => {
      const before = (await modelInfo(client)).levels.length;

      for (const params of [
        {},
        { items: [] },
        { items: "уровень" },
        { items: [1] },
        { items: [{ elevationMm: 1 }] },
        { items: [{ name: "Без отметки" }] },
        { items: [{ name: "Текст", elevationMm: "1" }] },
        { items: [{ name: "скобка{", elevationMm: 1 }] },
        { items: [{ name: " пробел", elevationMm: 1 }] },
        { items: [{ name: "Флаг", elevationMm: 1, createPlan: "да" }] },
        { items: [{ name: "Дважды", elevationMm: 1 }, { name: "Дважды", elevationMm: 2 }] },
        { items: Array.from({ length: 501 }, (_, index) => ({ name: `Л${index}`, elevationMm: index })) },
      ]) {
        const refused = await refusal(client, "create_levels", params);
        assert.equal(refused.code, INVALID_PARAMS, JSON.stringify(params).slice(0, 200));
      }

      assert.equal((await modelInfo(client)).levels.length, before);
    });
  });

  it("wall has requested length and height", async () => {
    await withClient(async (client) => {
      const { wallType, ground } = await context(client);

      const batch = await call(client, "create_walls", [
        { startMm: { x: 0, y: 0 }, endMm: { x: 6000, y: 0 }, typeId: wallType.id, levelId: ground.id, heightMm: 2750 },
      ]);
      console.log(`# create_walls: ${JSON.stringify(batch)}`);

      assertLanded(batch);
      const [item] = batch.items;
      assert.equal(item?.status, "created");
      assert.equal(typeof item?.elementId, "string");
      assertNear(item?.actual?.["lengthMm"], 6000, "length");
      assertNear(item?.actual?.["heightMm"], 2750, "height");
      assertNear(item?.actual?.["baseOffsetMm"], 0, "base offset");
      assert.equal(item?.actual?.["levelId"], ground.id);
      assert.equal(item?.actual?.["topLevelId"], null);
      assert.equal(item?.actual?.["typeId"], wallType.id);
      assert.deepEqual(item?.requested, { startMm: { x: 0, y: 0 }, endMm: { x: 6000, y: 0 }, typeId: wallType.id, levelId: ground.id, heightMm: 2750 });

      const [wall] = await readElements(client, [item?.elementId ?? null]);
      console.log(`# wall read back: ${JSON.stringify(wall)}`);

      assert.equal(wall?.category, "walls");
      assert.equal(wall?.levelId, ground.id);
      assert.ok(wall?.boundingBoxMm);
      assertNear(wall.boundingBoxMm.max.x - wall.boundingBoxMm.min.x, 6000, "length in the box");
      assertNear(wall.boundingBoxMm.max.z - wall.boundingBoxMm.min.z, 2750, "height in the box");
      assertNear(wall.boundingBoxMm.min.z, ground.elevationMm, "foot of the wall");
    });
  });

  it("a wall to a top level follows that level, and a base offset lifts its foot", async () => {
    await withClient(async (client) => {
      const { wallType, ground, upper } = await context(client);
      const storey = upper.elevationMm - ground.elevationMm;

      const batch = await call(client, "create_walls", [
        { startMm: { x: 20000, y: 0 }, endMm: { x: 24000, y: 0 }, typeId: wallType.id, levelId: ground.id, topLevelId: upper.id },
        { startMm: { x: 30000, y: 0 }, endMm: { x: 34000, y: 0 }, typeId: wallType.id, levelId: ground.id, topLevelId: upper.id, baseOffsetMm: 500 },
        { startMm: { x: 40000, y: 0 }, endMm: { x: 44000, y: 0 }, typeId: wallType.id, levelId: ground.id, heightMm: 3000, baseOffsetMm: -300 },
        { startMm: { x: 50000, y: 0 }, endMm: { x: 54000, y: 0 }, typeId: wallType.id, levelId: upper.id, heightMm: 2000 },
      ]);
      console.log(`# walls with constraints: ${JSON.stringify(batch)}`);

      assertLanded(batch);
      const [toTop, lifted, sunk, onUpper] = batch.items;
      assert.equal(toTop?.actual?.["topLevelId"], upper.id);
      assertNear(toTop?.actual?.["heightMm"], storey, "height to the level");
      assert.equal(lifted?.actual?.["topLevelId"], upper.id);
      assertNear(lifted?.actual?.["baseOffsetMm"], 500, "offset");
      assertNear(lifted?.actual?.["heightMm"], storey - 500, "height above the offset");
      assertNear(sunk?.actual?.["baseOffsetMm"], -300, "negative offset");
      assertNear(sunk?.actual?.["heightMm"], 3000, "height with a negative offset");

      const [, liftedWall, sunkWall, upperWall] = await readElements(client, batch.items.map((item) => item.elementId));
      assertNear(liftedWall?.boundingBoxMm?.min.z, ground.elevationMm + 500, "foot of the lifted wall");
      assertNear(liftedWall?.boundingBoxMm?.max.z, upper.elevationMm, "top of the lifted wall");
      assertNear(sunkWall?.boundingBoxMm?.min.z, ground.elevationMm - 300, "foot of the sunk wall");
      assertNear(upperWall?.boundingBoxMm?.min.z, upper.elevationMm, "foot of the wall on the upper level");
      assertNear(upperWall?.boundingBoxMm?.max.z, upper.elevationMm + 2000, "top of the wall on the upper level");
      assert.equal(onUpper?.actual?.["levelId"], upper.id);
    });
  });

  it("invalid typeId fails before any change and lists valid types", async () => {
    await withClient(async (client) => {
      const { wallType, floorType, ground, upper } = await context(client);
      const before = await modelInfo(client);
      const good = { startMm: { x: 60000, y: 0 }, endMm: { x: 64000, y: 0 }, typeId: wallType.id, levelId: ground.id, heightMm: 3000 };

      for (const typeId of ["999999999", "abc", floorType.id, ground.id]) {
        const refused = await refusal(client, "create_walls", { items: [good, { ...good, typeId }] });
        assert.equal(refused.code, INVALID_PARAMS);
        assert.ok(refused.message.includes(wallType.id), refused.message);
        assert.ok(refused.message.includes(wallType.name), refused.message);
        assert.match(refused.message, /item 1/);
      }
      console.log(`# refusal: ${(await refusal(client, "create_walls", { items: [{ ...good, typeId: "999999999" }] })).message.slice(0, 300)}`);

      const square = [{ x: 60000, y: 0 }, { x: 64000, y: 0 }, { x: 64000, y: 4000 }];
      for (const typeId of ["999999999", wallType.id]) {
        const refused = await refusal(client, "create_floors", { items: [{ boundaryMm: square, typeId, levelId: ground.id }] });
        assert.equal(refused.code, INVALID_PARAMS);
        assert.ok(refused.message.includes(floorType.id), refused.message);
      }

      for (const levelId of ["999999999", wallType.id, "abc"]) {
        const refused = await refusal(client, "create_walls", { items: [{ ...good, levelId }] });
        assert.equal(refused.code, INVALID_PARAMS);
        assert.ok(refused.message.includes(ground.id), refused.message);

        const floor = await refusal(client, "create_floors", { items: [{ boundaryMm: square, typeId: floorType.id, levelId }] });
        assert.equal(floor.code, INVALID_PARAMS);
        assert.ok(floor.message.includes(ground.id), floor.message);
      }

      const { heightMm: _height, ...noHeight } = good;
      for (const item of [
        noHeight,
        { ...good, topLevelId: upper.id },
        { ...noHeight, topLevelId: "999999999" },
        { ...noHeight, topLevelId: ground.id },
        { ...noHeight, topLevelId: upper.id, baseOffsetMm: upper.elevationMm - ground.elevationMm },
        { ...good, heightMm: 0 },
        { ...good, heightMm: -1 },
        { ...good, endMm: good.startMm },
        { ...good, endMm: { x: 60000.1, y: 0 } },
        { ...good, startMm: { x: 1 } },
        { ...good, baseOffsetMm: "0" },
      ]) {
        const refused = await refusal(client, "create_walls", { items: [good, item] });
        assert.equal(refused.code, INVALID_PARAMS, JSON.stringify(item));
      }

      for (const boundaryMm of [
        square.slice(0, 2),
        [square[0], square[0], square[1], square[2]],
        [...square, square[0]],
        [square[0], square[1], { x: 64000 }],
        "контур",
      ]) {
        const refused = await refusal(client, "create_floors", { items: [{ boundaryMm, typeId: floorType.id, levelId: ground.id }] });
        assert.equal(refused.code, INVALID_PARAMS, JSON.stringify(boundaryMm));
      }

      for (const method of ["create_walls", "create_floors"]) {
        assert.equal((await refusal(client, method, { items: [] })).code, INVALID_PARAMS);
        assert.equal((await refusal(client, method, {})).code, INVALID_PARAMS);
        assert.equal((await refusal(client, method, { items: Array.from({ length: 501 }, () => good) })).code, INVALID_PARAMS);
      }

      const after = await modelInfo(client);
      assert.equal(countOf(after, "OST_Walls"), countOf(before, "OST_Walls"));
      assert.equal(countOf(after, "OST_Floors"), countOf(before, "OST_Floors"));
    });
  });

  it("batch with one bad item leaves no elements", async () => {
    await withClient(async (client) => {
      const { wallType, ground } = await context(client);
      const before = countOf(await modelInfo(client), "OST_Walls");
      const wall = (x: number, heightMm: number) => ({ startMm: { x, y: 10000 }, endMm: { x: x + 3000, y: 10000 }, typeId: wallType.id, levelId: ground.id, heightMm });

      const batch = await call(client, "create_walls", [wall(0, 3000), wall(5000, 3000), wall(10000, TOO_HIGH_MM), wall(15000, 3000)]);
      console.log(`# one bad item: ${JSON.stringify(batch)}`);

      assert.equal(batch.committed, false);
      assert.deepEqual(batch.items.map((item) => [item.index, item.status]), [[0, "rolled_back"], [1, "rolled_back"], [2, "failed"], [3, "rolled_back"]]);
      assert.ok(batch.items.every((item) => item.elementId === null && item.actual === null));
      assert.equal(batch.items[0]?.error, null);
      assert.ok(batch.items[2]?.error);
      assert.match(batch.items[3]?.error ?? "", /not attempted/i);
      assert.ok(batch.errors.some((error) => error.includes(batch.items[2]?.error ?? "?")), JSON.stringify(batch.errors));

      assert.equal(countOf(await modelInfo(client), "OST_Walls"), before);
    });
  });

  it("a wall too low to build fails on its own item, where Revit gives no failure at commit", async () => {
    await withClient(async (client) => {
      const { wallType, ground, upper } = await context(client);
      const before = countOf(await modelInfo(client), "OST_Walls");
      const wall = (x: number, extra: object) => ({ startMm: { x, y: 12000 }, endMm: { x: x + 3000, y: 12000 }, typeId: wallType.id, levelId: ground.id, ...extra });
      const storey = upper.elevationMm - ground.elevationMm;

      for (const low of [{ heightMm: 5 }, { topLevelId: upper.id, baseOffsetMm: storey - 0.1 }]) {
        const batch = await call(client, "create_walls", [wall(0, { heightMm: 3000 }), wall(5000, low), wall(10000, { heightMm: 3000 })]);
        console.log(`# too low: ${JSON.stringify(batch)}`);

        assert.equal(batch.committed, false);
        assert.deepEqual(batch.items.map((item) => item.status), ["rolled_back", "failed", "rolled_back"]);
        assert.equal(batch.items[1]?.error, "Failed to regenerate.");
        assert.deepEqual(batch.dialogs, []);
      }

      assert.equal(countOf(await modelInfo(client), "OST_Walls"), before);
    });
  });

  it("what Revit refuses only at commit rolls every item back and gives Revit's own text", async () => {
    await withClient(async (client) => {
      const { wallType, ground } = await context(client);
      const before = countOf(await modelInfo(client), "OST_Walls");
      const good = { startMm: { x: 0, y: 14000 }, endMm: { x: 3000, y: 14000 }, typeId: wallType.id, levelId: ground.id, heightMm: 3000 };

      // Longer than the shortest line Revit can draw, so it passes the check, and too short for a wall.
      const batch = await call(client, "create_walls", [good, { ...good, startMm: { x: 5000, y: 14000 }, endMm: { x: 5001, y: 14000 } }]);
      console.log(`# refused at commit: ${JSON.stringify(batch)}`);

      assert.equal(batch.committed, false);
      assert.deepEqual(batch.items.map((item) => [item.status, item.error]), [["rolled_back", null], ["rolled_back", null]]);
      assert.deepEqual(batch.errors.map((error) => error.trim()), ["Can't make Wall."]);
      assert.deepEqual(batch.dialogs, []);
      assert.equal(countOf(await modelInfo(client), "OST_Walls"), before);
    });
  });

  it("a wall on top of another comes back with the warning of Revit, and it lands", async () => {
    await withClient(async (client) => {
      const { wallType, ground } = await context(client);
      const wall = { startMm: { x: 0, y: 20000 }, endMm: { x: 4000, y: 20000 }, typeId: wallType.id, levelId: ground.id, heightMm: 3000 };

      const batch = await call(client, "create_walls", [wall, wall]);
      console.log(`# overlap: ${JSON.stringify(batch)}`);

      assertLanded(batch);
      assert.ok(batch.warnings.length > 0, "Revit should warn about walls that overlap");
    });
  });

  it("create_floors closes the outline and the floor stands on its level", async () => {
    await withClient(async (client) => {
      const { floorType, ground, upper } = await context(client);
      const clockwise = [{ x: 0, y: 34000 }, { x: 6000, y: 34000 }, { x: 6000, y: 30000 }, { x: 0, y: 30000 }];

      const batch = await call(client, "create_floors", [
        { boundaryMm: [{ x: 0, y: 30000 }, { x: 6000, y: 30000 }, { x: 6000, y: 34000 }, { x: 0, y: 34000 }], typeId: floorType.id, levelId: ground.id },
        { boundaryMm: clockwise, typeId: floorType.id, levelId: upper.id },
        { boundaryMm: [{ x: 10000, y: 30000 }, { x: 14000, y: 30000 }, { x: 10000, y: 33000 }], typeId: floorType.id, levelId: ground.id },
      ]);
      console.log(`# create_floors: ${JSON.stringify(batch)}`);

      assertLanded(batch);
      assert.ok(batch.items.every((item) => item.status === "created" && item.actual?.["typeId"] === floorType.id));
      assertNear(batch.items[0]?.actual?.["areaM2"], 24, "area of the rectangle");
      assertNear(batch.items[1]?.actual?.["areaM2"], 24, "area of the clockwise rectangle");
      assertNear(batch.items[2]?.actual?.["areaM2"], 6, "area of the triangle");
      assert.equal(batch.items[0]?.actual?.["levelId"], ground.id);
      assert.equal(batch.items[1]?.actual?.["levelId"], upper.id);
      assertNear(batch.items[0]?.actual?.["heightOffsetMm"], 0, "offset from the level");

      const [floor, onUpper] = await readElements(client, batch.items.map((item) => item.elementId));
      console.log(`# floors read back: ${JSON.stringify([floor, onUpper])}`);

      assert.equal(floor?.category, "floors");
      assertNear(floor?.boundingBoxMm?.max.x, 6000, "east edge");
      assertNear(floor?.boundingBoxMm?.max.y, 34000, "north edge");
      assertNear(floor?.boundingBoxMm?.max.z, ground.elevationMm, "top of the floor");
      assertNear(onUpper?.boundingBoxMm?.max.z, upper.elevationMm, "top of the floor on the upper level");
    });
  });

  it("an outline that crosses itself, touches itself or encloses nothing is refused and leaves no floor", async () => {
    await withClient(async (client) => {
      const { floorType, ground } = await context(client);
      const before = countOf(await modelInfo(client), "OST_Floors");
      const floor = (boundaryMm: Array<{ x: number; y: number }>) => ({ boundaryMm, typeId: floorType.id, levelId: ground.id });
      const good = floor([{ x: 20000, y: 30000 }, { x: 24000, y: 30000 }, { x: 24000, y: 34000 }]);

      for (const outline of [
        [{ x: 30000, y: 30000 }, { x: 34000, y: 34000 }, { x: 34000, y: 30000 }, { x: 30000, y: 34000 }],
        [{ x: 30000, y: 30000 }, { x: 32000, y: 30000 }, { x: 31000, y: 31000 }, { x: 32000, y: 32000 }, { x: 30000, y: 32000 }, { x: 31000, y: 31000 }],
        [{ x: 30000, y: 30000 }, { x: 32000, y: 30000 }, { x: 34000, y: 30000 }],
      ]) {
        const refused = await refusal(client, "create_floors", { items: [good, floor(outline)] });
        console.log(`# bad outline: ${refused.message}`);

        assert.equal(refused.code, INVALID_PARAMS);
        assert.match(refused.message, /item 1/);
      }

      assert.equal(countOf(await modelInfo(client), "OST_Floors"), before);
    });
  });

  it("one batch is one Undo step", async () => {
    await withClient(async (client) => {
      const { wallType, floorType, ground } = await context(client);
      const journal = await journalPath();
      const wall = (x: number) => ({ startMm: { x, y: 40000 }, endMm: { x: x + 3000, y: 40000 }, typeId: wallType.id, levelId: ground.id, heightMm: 3000 });

      const walls = await committedInJournal(journal, "create_walls");
      assertLanded(await call(client, "create_walls", [wall(0), wall(5000), wall(10000), wall(15000), wall(20000)]));
      const wallsAfter = await journalCountAfter(journal, "create_walls", walls);
      console.log(`# ${journal}: create_walls transactions ${walls} -> ${wallsAfter} for a batch of 5`);
      assert.equal(wallsAfter, walls + 1);

      const floors = await committedInJournal(journal, "create_floors");
      const outline = [{ x: 0, y: 44000 }, { x: 3000, y: 44000 }, { x: 3000, y: 47000 }];
      assertLanded(
        await call(client, "create_floors", [
          { boundaryMm: outline, typeId: floorType.id, levelId: ground.id },
          { boundaryMm: outline.map(({ x, y }) => ({ x: x + 5000, y })), typeId: floorType.id, levelId: ground.id },
        ]),
      );
      assert.equal(await journalCountAfter(journal, "create_floors", floors), floors + 1);

      const levels = await committedInJournal(journal, "create_levels");
      assertLanded(
        await call(client, "create_levels", [
          { name: "Журнал 1", elevationMm: 20000 },
          { name: "Журнал 2", elevationMm: 23000 },
        ]),
      );
      assert.equal(await journalCountAfter(journal, "create_levels", levels), levels + 1);

      // Nothing to do, so no transaction, or Undo would step over an empty entry.
      const repeat = await call(client, "create_levels", [{ name: "Журнал 1", elevationMm: 20000 }]);
      assertLanded(repeat);
      assert.equal(repeat.items[0]?.status, "already_existed");
      await new Promise((resolve) => setTimeout(resolve, 1000));
      assert.equal(await committedInJournal(journal, "create_levels"), levels + 1);

      // A batch that fails commits nothing.
      const failed = await call(client, "create_walls", [wall(25000), { ...wall(30000), heightMm: TOO_HIGH_MM }]);
      assert.equal(failed.committed, false);
      await new Promise((resolve) => setTimeout(resolve, 1000));
      assert.equal(await committedInJournal(journal, "create_walls"), wallsAfter);
    });
  });

  it("a box of walls and a floor shows on a snapshot", async () => {
    await withClient(async (client) => {
      const { wallType, floorType, ground, upper } = await context(client);
      const corners = [{ x: 0, y: 60000 }, { x: 12000, y: 60000 }, { x: 12000, y: 68000 }, { x: 0, y: 68000 }];
      const walls = corners.map((startMm, index) => ({
        startMm,
        endMm: corners[(index + 1) % corners.length],
        typeId: wallType.id,
        levelId: ground.id,
        topLevelId: upper.id,
      }));

      const built = await call(client, "create_walls", walls);
      const floor = await call(client, "create_floors", [{ boundaryMm: corners, typeId: floorType.id, levelId: ground.id }]);
      console.log(`# box: ${JSON.stringify(built)} ${JSON.stringify(floor)}`);
      assertLanded(built);
      assertLanded(floor);

      const view = (await client.call("create_3d_view", {
        name: "Коробка",
        kind: "perspective",
        displayStyle: "shading",
        eyeMm: { x: 30000, y: 40000, z: 16000 },
        targetMm: { x: 6000, y: 64000, z: 1500 },
      })) as { committed: boolean; viewId: string };
      assert.equal(view.committed, true);

      const snapshot = (await client.call("get_view_snapshot", { viewId: view.viewId, widthPx: 1200 })) as { path: string };
      console.log(`# box snapshot: ${snapshot.path}`);
      assert.ok(snapshot.path.endsWith(".png"));
    });
  });

  it("leaves Revit in a state the close rule accepts", async () => {
    await withClient(async (client) => {
      await client.call("save_project", {});
      assert.deepEqual(checkCanClose((await modelInfo(client)).openDocuments), { ok: true, reasons: [] });
    });
  });
});
