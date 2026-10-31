import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { checkCanClose } from "../../src/cli/closeRule.ts";
import { BridgeClient } from "../../src/client.ts";
import { defaultConnectionPath } from "../../src/connection.ts";
import { BridgeRpcError } from "../../src/errors.ts";

// These tests need a running Revit with the RevitMCP plugin loaded. Each run creates one new project in the test
// folder and leaves it open and saved. Walls stand far apart, so Revit joins none of them, and the only warnings are the
// ones a test makes on purpose.

interface Level {
  id: string;
  name: string;
  elevationMm: number;
}

interface ModelInfo {
  activeDocument: { title: string; isModified: boolean } | null;
  openDocuments: Array<{ title: string; path: string; isModified: boolean }>;
  levels: Level[];
}

interface TypeRow {
  id: string;
  family: string;
  name: string;
}

interface Material {
  id: string;
  name: string;
  materialClass: string;
  color: { r: number; g: number; b: number } | null;
  transparency: number;
}

interface Warning {
  definitionId: string;
  text: string;
  elementIds: string[];
  additionalElementIds: string[];
}

interface ElementRow {
  id: string;
  category: string | null;
  typeName: string | null;
  levelId: string | null;
  boundingBoxMm: unknown;
  topMm?: number;
}

interface Elements {
  elements: ElementRow[];
  notFound: string[];
  truncated: boolean;
}

interface Batch {
  committed: boolean;
  items: Array<{ index: number; status: string; elementId: string | null }>;
  warnings: string[];
  errors: string[];
  dialogs: unknown[];
}

const INVALID_PARAMS = -32602;
const MAX_ELEMENTS = 1000;
const WALL_HEIGHT_MM = 2500;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CATEGORIES = ["walls", "floors", "roofs", "ceilings", "doors", "windows", "furniture", "plumbing", "stairs", "railings"];
// A batch of 500 walls takes Revit well over the 60 s a call gets by default.
const BIG_BATCH_TIMEOUT_MS = 170_000;

const stamp = new Date().toTimeString().slice(0, 8).replaceAll(":", "");
const name = `проверка-этап3-чтение-${stamp}`;

/** The walls this run made, by level, so that a category read can be compared with exactly what exists. */
const made = { ground: [] as string[], upper: [] as string[] };

async function withClient<T>(body: (client: BridgeClient) => Promise<T>): Promise<T> {
  const client = new BridgeClient(defaultConnectionPath());
  try {
    return await body(client);
  } finally {
    client.close();
  }
}

const modelInfo = (client: BridgeClient): Promise<ModelInfo> => client.call("get_model_info", {}) as Promise<ModelInfo>;

const elements = (client: BridgeClient, params: object): Promise<Elements> => client.call("get_elements", params) as Promise<Elements>;

const warnings = (client: BridgeClient): Promise<Warning[]> => client.call("get_warnings", {}) as Promise<Warning[]>;

/** Calls a method that must refuse, and returns the refusal. */
async function refusal(client: BridgeClient, method: string, params: object): Promise<BridgeRpcError> {
  const error = await client.call(method, params).then(
    (result) => assert.fail(`${method} ${JSON.stringify(params)} should be refused, and returned ${JSON.stringify(result)}`),
    (reason: unknown) => reason,
  );

  assert.ok(error instanceof BridgeRpcError, `${method}: expected a plugin error, got ${String(error)}`);
  return error;
}

async function createBatch(client: BridgeClient, method: string, items: unknown[]): Promise<Batch> {
  const batch = (await client.call(method, { items }, { timeoutMs: BIG_BATCH_TIMEOUT_MS })) as Batch;
  assert.equal(batch.committed, true, JSON.stringify(batch).slice(0, 2000));
  assert.deepEqual(batch.errors, []);
  assert.deepEqual(batch.dialogs, []);
  return batch;
}

async function context(client: BridgeClient): Promise<{ wallType: TypeRow; ground: Level; upper: Level }> {
  const levels = [...(await modelInfo(client)).levels].sort((a, b) => a.elevationMm - b.elevationMm);
  const [wallType] = (await client.call("list_types", { category: "walls" })) as TypeRow[];
  const [ground, upper] = levels;
  assert.ok(ground && upper && wallType);

  return { wallType, ground, upper };
}

const wallAt = (typeId: string, levelId: string, x: number, y: number, lengthMm = 4000) => ({
  startMm: { x, y },
  endMm: { x: x + lengthMm, y },
  typeId,
  levelId,
  heightMm: WALL_HEIGHT_MM,
});

const byId = (a: string, b: string): number => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0);

const ids = (rows: ElementRow[]): string[] => rows.map((row) => row.id);

describe("stage 3 live checks: reading materials, warnings and elements by category", { timeout: 600_000 }, () => {
  it("creates a project for this run, and a new project holds no warning", async () => {
    await withClient(async (client) => {
      await client.call("create_project", { name });

      assert.equal((await modelInfo(client)).activeDocument?.title, name);
      assert.deepEqual(await warnings(client), []);
    });
  });

  it("materials arrive with Cyrillic names", async () => {
    await withClient(async (client) => {
      const materials = (await client.call("list_materials", {})) as Material[];
      const noColour = materials.filter((material) => material.color === null);
      console.log(`# list_materials: ${materials.length} materials, ${noColour.length} without a colour, for example ${JSON.stringify(materials.slice(0, 3))}`);

      assert.ok(materials.length > 0);
      assert.ok(materials.some((material) => /[а-яё]/i.test(material.name)), "material names should be Cyrillic");
      assert.ok(materials.every((material) => !material.name.includes("�")), "no name may carry a replacement character");
      assert.ok(materials.every((material) => /^\d+$/.test(material.id) && material.name.length > 0 && typeof material.materialClass === "string"));
      assert.ok(materials.every((material) => Number.isInteger(material.transparency) && material.transparency >= 0 && material.transparency <= 100));
      for (const { color } of materials) {
        assert.ok(color === null || [color.r, color.g, color.b].every((channel) => Number.isInteger(channel) && channel >= 0 && channel <= 255), JSON.stringify(color));
      }

      // The ordinal order of the names, then the ids: the default comparison of strings in JavaScript is the same ordinal one.
      const expected = [...materials].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : byId(a.id, b.id)));
      assert.deepEqual(materials, expected);
      assert.deepEqual(await client.call("list_materials", {}), materials);
    });
  });

  it("overlapping walls appear in get_warnings with their ids", async () => {
    await withClient(async (client) => {
      const { wallType, ground } = await context(client);
      const wall = wallAt(wallType.id, ground.id, 0, 20000);

      const batch = await createBatch(client, "create_walls", [wall, wall]);
      const [first, second] = batch.items.map((item) => item.elementId);
      assert.ok(first && second);
      made.ground.push(first, second);
      console.log(`# overlap: walls ${first} and ${second}, the batch said ${JSON.stringify(batch.warnings)}`);
      assert.ok(batch.warnings.length > 0, "Revit should warn about walls that overlap");

      const listed = await warnings(client);
      console.log(`# get_warnings: ${JSON.stringify(listed)}`);
      const overlap = listed.filter((warning) => [first, second].every((id) => warning.elementIds.includes(id)));

      assert.ok(overlap.length > 0, `no warning names both walls: ${JSON.stringify(listed)}`);
      for (const warning of listed) {
        assert.match(warning.definitionId, GUID);
        assert.ok(warning.text.length > 0);
        assert.ok(Array.isArray(warning.elementIds) && Array.isArray(warning.additionalElementIds));
        assert.deepEqual(warning.elementIds, [...warning.elementIds].sort(byId));
      }
      assert.ok(overlap.every((warning) => batch.warnings.includes(warning.text)), "the batch and get_warnings should speak the same words");
      assert.deepEqual(await warnings(client), listed);

      // The warning belongs to the walls: with one of them gone it goes too.
      const deleted = (await client.call("delete_elements", { ids: [second], dryRun: false })) as { committed: boolean };
      assert.equal(deleted.committed, true);
      made.ground.pop();
      const after = await warnings(client);
      console.log(`# get_warnings after the delete: ${JSON.stringify(after)}`);
      assert.ok(after.every((warning) => ![first, second].some((id) => warning.elementIds.includes(id) || warning.additionalElementIds.includes(id))), JSON.stringify(after));
    });
  });

  it("elements by category and level", async () => {
    await withClient(async (client) => {
      const { wallType, ground, upper } = await context(client);

      const onGround = await createBatch(client, "create_walls", [wallAt(wallType.id, ground.id, 0, 0), wallAt(wallType.id, ground.id, 0, 3000)]);
      const onUpper = await createBatch(client, "create_walls", [wallAt(wallType.id, upper.id, 0, 6000)]);
      made.ground.push(...onGround.items.map((item) => item.elementId!));
      made.upper.push(...onUpper.items.map((item) => item.elementId!));
      const levels = await createBatch(client, "create_levels", [{ name: `Этаж без стен ${stamp}`, elevationMm: 40000, createPlan: false }]);
      const emptyLevelId = levels.items[0]?.elementId;
      assert.ok(emptyLevelId);

      const everything = await elements(client, { category: "walls" });
      console.log(`# walls by category: ${everything.elements.length} elements, first ${JSON.stringify(everything.elements[0])}`);
      const allIds = [...made.ground, ...made.upper];

      assert.equal(everything.truncated, false);
      assert.deepEqual(everything.notFound, []);
      assert.deepEqual(ids(everything.elements), [...allIds].sort(byId), "all the walls of the model, by id");
      for (const row of everything.elements) {
        assert.equal(row.category, "walls");
        assert.equal(row.typeName, wallType.name);
        assert.equal(typeof row.topMm, "number");
        assert.notEqual(row.boundingBoxMm, null);
        assert.ok(row.levelId === ground.id || row.levelId === upper.id, `${row.id} stands on level ${String(row.levelId)}`);
      }

      const atGround = await elements(client, { category: "walls", levelId: ground.id });
      const atUpper = await elements(client, { category: "walls", levelId: upper.id });
      assert.deepEqual(ids(atGround.elements), [...made.ground].sort(byId));
      assert.deepEqual(ids(atUpper.elements), [...made.upper].sort(byId));
      assert.ok(atGround.elements.every((row) => row.levelId === ground.id));
      assert.ok(atUpper.elements.every((row) => row.levelId === upper.id));
      assert.equal(atGround.truncated || atUpper.truncated, false);

      // A level with nothing on it, and categories with nothing in the model, are empty answers and no failures.
      assert.deepEqual(await elements(client, { category: "walls", levelId: emptyLevelId }), { elements: [], notFound: [], truncated: false });
      for (const category of CATEGORIES.filter((word) => word !== "walls")) {
        assert.deepEqual(await elements(client, { category }), { elements: [], notFound: [], truncated: false }, category);
      }

      // The same wall reads the same by category and by id, and ids keep their answer with truncated added.
      const [one, two] = everything.elements;
      assert.ok(one && two);
      const byIds = await elements(client, { ids: [one.id, "999999999", two.id] });
      assert.deepEqual(byIds, { elements: [one, two], notFound: ["999999999"], truncated: false });

      // A client that sends every field with null for what it does not use gets the answer of the field it uses.
      assert.deepEqual(await elements(client, { ids: [one.id], category: null, levelId: null }), { elements: [one], notFound: [], truncated: false });
      assert.deepEqual(await elements(client, { category: "walls", levelId: null, ids: null }), everything);
    });
  });

  it("both ids and category are refused", async () => {
    await withClient(async (client) => {
      const info = await modelInfo(client);
      const level = info.levels[0];
      const [wall] = made.ground;
      assert.ok(level && wall);

      const both = await refusal(client, "get_elements", { ids: [wall], category: "walls" });
      assert.equal(both.code, INVALID_PARAMS);
      assert.match(both.message, /exactly one of ids and category/);

      const neither = await refusal(client, "get_elements", {});
      assert.equal(neither.code, INVALID_PARAMS);
      assert.match(neither.message, /exactly one of ids and category/);

      assert.equal((await refusal(client, "get_elements", { levelId: level.id })).code, INVALID_PARAMS);
      assert.match((await refusal(client, "get_elements", { ids: [wall], levelId: level.id })).message, /only with category/);

      // A level id that names no level is refused with the levels there are. The wall is an element and no level.
      for (const levelId of [wall, "999999999", "abc", "", " 5", level.id + "0000000000000"]) {
        const refused = await refusal(client, "get_elements", { category: "walls", levelId });
        assert.equal(refused.code, INVALID_PARAMS, JSON.stringify(levelId));
      }
      const noLevel = await refusal(client, "get_elements", { category: "walls", levelId: wall });
      for (const known of info.levels) {
        assert.ok(noLevel.message.includes(known.id), `${known.id} is missing from: ${noLevel.message}`);
      }
      assert.equal((await refusal(client, "get_elements", { category: "walls", levelId: Number(level.id) })).code, INVALID_PARAMS);

      for (const category of ["стены", "view_templates", "", "WALLS", 5, ["walls"]]) {
        const refused = await refusal(client, "get_elements", { category });
        assert.equal(refused.code, INVALID_PARAMS, JSON.stringify(category));
        for (const word of CATEGORIES) {
          assert.ok(refused.message.includes(word), `${word} is missing from: ${refused.message}`);
        }
      }

      // Every refusal above came before Revit read anything, and the right call still works afterwards.
      assert.equal((await elements(client, { ids: [wall] })).elements.length, 1);
    });
  });

  it("get_elements by category stops at 1000, and says so", async () => {
    await withClient(async (client) => {
      const { wallType, ground } = await context(client);
      const levels = await createBatch(client, "create_levels", [{ name: `Массовый этаж ${stamp}`, elevationMm: 20000, createPlan: false }]);
      const crowded = levels.items[0]?.elementId;
      assert.ok(crowded);

      // 1001 walls of 1 m, 2 m apart in rows of 50, far from every other wall of the run.
      const walls = Array.from({ length: MAX_ELEMENTS + 1 }, (_, index) => wallAt(wallType.id, crowded, (index % 50) * 2000, 100_000 + Math.floor(index / 50) * 2000, 1000));
      const created: string[] = [];
      const started = performance.now();
      for (let from = 0; from < walls.length; from += 500) {
        const batch = await createBatch(client, "create_walls", walls.slice(from, from + 500));
        created.push(...batch.items.map((item) => item.elementId!));
      }
      console.log(`# ${created.length} walls took ${((performance.now() - started) / 1000).toFixed(1)} s`);
      assert.equal(created.length, MAX_ELEMENTS + 1);

      const read = performance.now();
      const everything = await elements(client, { category: "walls" });
      const onLevel = await elements(client, { category: "walls", levelId: crowded });
      const elsewhere = await elements(client, { category: "walls", levelId: ground.id });
      console.log(`# two reads of 1000 walls took ${((performance.now() - read) / 1000).toFixed(1)} s`);

      assert.equal(everything.elements.length, MAX_ELEMENTS);
      assert.equal(everything.truncated, true);
      assert.deepEqual(ids(everything.elements), ids(everything.elements).sort(byId));
      assert.equal(onLevel.elements.length, MAX_ELEMENTS);
      assert.equal(onLevel.truncated, true);

      // What is cut is the end of the order: the newest wall is not there, and the lowest id is.
      const newest = created.reduce((a, b) => (byId(a, b) > 0 ? a : b));
      assert.ok(!ids(onLevel.elements).includes(newest));
      assert.equal(ids(onLevel.elements)[0], created.reduce((a, b) => (byId(a, b) < 0 ? a : b)));
      assert.equal(elsewhere.truncated, false);

      // Exactly 1000 is no truncation. One wall less on the level gives exactly that.
      const deleted = (await client.call("delete_elements", { ids: [newest], dryRun: false })) as { committed: boolean };
      assert.equal(deleted.committed, true);
      const exact = await elements(client, { category: "walls", levelId: crowded });
      assert.equal(exact.elements.length, MAX_ELEMENTS);
      assert.equal(exact.truncated, false);
    });
  });

  it("the new read tools leave a saved project saved, so they left no change to undo", async () => {
    await withClient(async (client) => {
      await client.call("save_project", {});
      assert.equal((await modelInfo(client)).activeDocument?.isModified, false);
      const level = (await modelInfo(client)).levels[0];
      assert.ok(level);

      await client.call("list_materials", {});
      await warnings(client);
      await elements(client, { category: "walls", levelId: level.id });
      await elements(client, { category: "doors" });

      assert.equal((await modelInfo(client)).activeDocument?.isModified, false);
    });
  });

  it("leaves Revit in a state the close rule accepts", async () => {
    await withClient(async (client) => {
      await client.call("save_project", {});
      assert.deepEqual(checkCanClose((await modelInfo(client)).openDocuments), { ok: true, reasons: [] });
    });
  });
});
