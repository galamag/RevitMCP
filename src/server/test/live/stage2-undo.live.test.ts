import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { checkCanClose } from "../../src/cli/closeRule.ts";
import { BridgeClient } from "../../src/client.ts";
import { defaultConnectionPath } from "../../src/connection.ts";
import { BridgeRpcError } from "../../src/errors.ts";
import { undoLastOperation } from "../../src/undo.ts";
import type { UndoResult } from "../../src/undo.ts";

// These tests need a running Revit with the RevitMCP plugin loaded. Each run creates new projects in the test folder
// and leaves them open and saved. The tests run in order and share the undo history of the first project, so each one
// checks what its own steps did, not what the whole history holds.
// "undo refuses after a user change" is not here: it needs a person, see the report of task 13.

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

interface ModelView {
  id: string;
  name: string;
  viewType: string;
}

interface ModelInfo {
  activeDocument: OpenDocument | null;
  openDocuments: OpenDocument[];
  levels: Level[];
  views: ModelView[];
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
  topMm?: number | null;
}

interface Item {
  status: string;
  elementId: string | null;
}

interface Batch {
  committed: boolean;
  items: Item[];
  errors: string[];
  dialogs: unknown[];
}

interface Deletion {
  dryRun: boolean;
  committed: boolean;
  summary: string;
  requested: string[];
  allAffected: string[];
  dependents: string[];
  warnings: string[];
  errors: string[];
  dialogs: unknown[];
}

interface Context {
  wallType: TypeRow;
  floorType: TypeRow;
  roofType: TypeRow;
  ground: Level;
  upper: Level;
}

interface LastUndo {
  state: string;
  undoId: number | null;
  transactionName: string | null;
  createdIds: string[];
  restoredIds: string[];
  documentTitle: string | null;
}

const INVALID_PARAMS = -32602;
const NEAR_MM = 0.01;
const WALL_LENGTH_MM = 3000;
const WALL_HEIGHT_MM = 2500;
/** The sum of these must stay under the 120 s a test may take, twice over. */
const QUIET_PAUSES_MS = [5_000, 15_000, 30_000];

/** In a Revit that ran no other test this project is all there is, and otherwise earlier projects hold the last operation. */
const NOTHING_HERE = /nothing to undo|lies in/;

const stamp = new Date().toTimeString().slice(0, 8).replaceAll(":", "");
const name = `проверка-задача13-${stamp}`;
const testFolder = path.join(homedir(), "Documents", "RevitMCP");

let context: Context | undefined;

/** Every wall gets its own place, so that no two touch or overlap. */
let nextWallY = 0;

async function withClient<T>(body: (client: BridgeClient) => Promise<T>): Promise<T> {
  const client = new BridgeClient(defaultConnectionPath());
  try {
    return await body(client);
  } finally {
    client.close();
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const modelInfo = (client: BridgeClient): Promise<ModelInfo> => client.call("get_model_info", {}) as Promise<ModelInfo>;

const batch = (client: BridgeClient, method: string, items: unknown[]): Promise<Batch> => client.call(method, { items }) as Promise<Batch>;

const remove = (client: BridgeClient, params: object): Promise<Deletion> => client.call("delete_elements", params) as Promise<Deletion>;

function ctx(): Context {
  assert.ok(context, "the first test sets the context");
  return context;
}

async function readContext(client: BridgeClient): Promise<Context> {
  const levels = [...(await modelInfo(client)).levels].sort((a, b) => a.elevationMm - b.elevationMm);
  const walls = (await client.call("list_types", { category: "walls" })) as TypeRow[];
  const floors = (await client.call("list_types", { category: "floors" })) as TypeRow[];
  const roofs = (await client.call("list_types", { category: "roofs" })) as TypeRow[];
  const [ground, upper] = levels;
  const [wallType] = walls;
  const [floorType] = floors;
  const [roofType] = roofs;
  assert.ok(ground && upper && wallType && floorType && roofType);

  return { wallType, floorType, roofType, ground, upper };
}

function wallItem(levelId = ctx().ground.id): object {
  nextWallY += 1000;
  return {
    startMm: { x: 0, y: nextWallY },
    endMm: { x: WALL_LENGTH_MM, y: nextWallY },
    typeId: ctx().wallType.id,
    levelId,
    heightMm: WALL_HEIGHT_MM,
  };
}

/** Creates walls and returns their ids. */
async function createWalls(client: BridgeClient, count: number, levelId?: string): Promise<string[]> {
  const created = await batch(client, "create_walls", Array.from({ length: count }, () => wallItem(levelId)));
  assert.equal(created.committed, true, JSON.stringify(created));

  return created.items.map((item) => {
    assert.ok(item.elementId);
    return item.elementId;
  });
}

async function find(client: BridgeClient, ids: string[]): Promise<{ elements: ElementRow[]; notFound: string[] }> {
  return (await client.call("get_elements", { ids })) as { elements: ElementRow[]; notFound: string[] };
}

async function assertGone(client: BridgeClient, ids: string[]): Promise<void> {
  assert.deepEqual((await find(client, ids)).notFound.sort(), [...ids].sort());
}

async function assertThere(client: BridgeClient, ids: string[]): Promise<void> {
  assert.deepEqual((await find(client, ids)).notFound, []);
}

/** Runs the whole undo tool, both steps, and checks that it names the transaction Revit took off. */
async function undo(client: BridgeClient, method: string): Promise<UndoResult> {
  const result = await undoLastOperation(client);
  assert.equal(result.state, "undone", JSON.stringify(result));
  assert.equal(result.transactionName, `MCP: ${method}`, JSON.stringify(result));

  return result;
}

/** Calls the undo tool where it must refuse, and returns the refusal. */
async function undoRefusal(client: BridgeClient): Promise<BridgeRpcError> {
  const error = await undoLastOperation(client).then(
    (result) => assert.fail(`undo should be refused, and returned ${JSON.stringify(result)}`),
    (reason: unknown) => reason,
  );

  assert.ok(error instanceof BridgeRpcError, `expected a refusal from the plugin, got ${String(error)}`);
  assert.equal(error.code, INVALID_PARAMS);
  assert.match(error.message, /^undo_refused: /);
  return error;
}

async function refusal(client: BridgeClient, method: string, params: object): Promise<BridgeRpcError> {
  const error = await client.call(method, params).then(
    (result) => assert.fail(`${method} ${JSON.stringify(params)} should be refused, and returned ${JSON.stringify(result)}`),
    (reason: unknown) => reason,
  );

  assert.ok(error instanceof BridgeRpcError, `${method}: expected a plugin error, got ${String(error)}`);
  return error;
}

/** Saves every open document that has changes. Each must be made active first, which is all save_project can reach. */
async function saveEverything(client: BridgeClient): Promise<void> {
  for (const document of (await modelInfo(client)).openDocuments.filter((open) => open.isModified)) {
    await client.call("open_project", { name: path.win32.basename(document.path) });
    await client.call("save_project", {});
  }
}

/** The newest project of an earlier run that this Revit does not hold open, as a file to open fresh. */
async function closedProject(client: BridgeClient): Promise<string | null> {
  const open = new Set((await modelInfo(client)).openDocuments.map((document) => path.win32.basename(document.path)));
  const files = (await readdir(testFolder)).filter((file) => /^проверка-задача1\d-\d{6}\.rvt$/.test(file) && !open.has(file));

  return files.sort().at(-1) ?? null;
}

describe("stage 2 live checks: delete and undo", { timeout: 120_000 }, () => {
  it("creates a project for this run", async () => {
    await withClient(async (client) => {
      await client.call("create_project", { name });
      context = await readContext(client);
      console.log(`# levels: ${JSON.stringify(context.ground)}, ${JSON.stringify(context.upper)}`);
    });
  });

  it("a new project has nothing to undo, so undo refuses and Revit stays as it was", async () => {
    await withClient(async (client) => {
      const before = await modelInfo(client);

      const refused = await undoRefusal(client);

      console.log(`# refusal: ${refused.message}`);
      assert.match(refused.message, NOTHING_HERE);
      assert.deepEqual(await modelInfo(client), before);
    });
  });

  it("dryRun deletes nothing and lists dependents", async () => {
    await withClient(async (client) => {
      const level = await batch(client, "create_levels", [{ name: `Этаж ${stamp}`, elevationMm: 9000 }]);
      const levelId = level.items[0]?.elementId;
      assert.ok(levelId);
      const [wallId] = await createWalls(client, 1, levelId);
      assert.ok(wallId);
      await client.call("save_project", {});
      const before = await modelInfo(client);
      const rowsBefore = await find(client, [levelId, wallId]);
      assert.equal(before.activeDocument?.isModified, false);

      const result = await remove(client, { ids: [levelId], dryRun: true });

      console.log(`# dry run of a level with a wall: ${JSON.stringify(result)}`);
      assert.equal(result.dryRun, true);
      assert.equal(result.committed, false);
      assert.deepEqual(result.errors, []);
      assert.deepEqual(result.dialogs, []);
      assert.deepEqual(result.requested, [levelId]);
      assert.ok(result.allAffected.includes(levelId), "the level itself is affected");
      assert.ok(result.allAffected.includes(wallId), "the wall on the level is affected");
      assert.ok(result.dependents.includes(wallId), "the wall is listed as a dependent");
      assert.ok(!result.dependents.includes(levelId), "the level was asked for, so it is no dependent");

      assert.deepEqual(await find(client, [levelId, wallId]), rowsBefore);
      assert.deepEqual(await modelInfo(client), before);
    });
  });

  it("a dry run leaves no Undo step: undo takes the operation before it", async () => {
    await withClient(async (client) => {
      const [wallId] = await createWalls(client, 1);
      assert.ok(wallId);
      await remove(client, { ids: [wallId], dryRun: true });

      await undo(client, "create_walls");

      await assertGone(client, [wallId]);
    });
  });

  it("leaving out dryRun deletes nothing", async () => {
    await withClient(async (client) => {
      const [wallId] = await createWalls(client, 1);
      assert.ok(wallId);

      const result = await remove(client, { ids: [wallId] });

      assert.equal(result.dryRun, true);
      assert.equal(result.committed, false);
      assert.deepEqual(result.allAffected, [wallId]);
      await assertThere(client, [wallId]);
    });
  });

  it("delete removes elements", async () => {
    await withClient(async (client) => {
      const [first, second] = await createWalls(client, 2);
      assert.ok(first && second);

      const result = await remove(client, { ids: [first], dryRun: false });

      console.log(`# real delete: ${JSON.stringify(result)}`);
      assert.equal(result.dryRun, false);
      assert.equal(result.committed, true);
      assert.deepEqual(result.errors, []);
      assert.deepEqual(result.dialogs, []);
      assert.deepEqual(result.allAffected, [first]);
      assert.deepEqual(result.dependents, []);
      await assertGone(client, [first]);
      await assertThere(client, [second]);
      assert.equal((await modelInfo(client)).activeDocument?.isModified, true);
    });
  });

  it("delete refuses bad input and changes nothing", async () => {
    await withClient(async (client) => {
      const [wallId] = await createWalls(client, 1);
      assert.ok(wallId);
      const before = await modelInfo(client);

      for (const [params, message] of [
        [{ dryRun: false }, /needs a list of ids/],
        [{ ids: [], dryRun: false }, /needs a list of ids/],
        [{ ids: "1", dryRun: false }, /needs a list of ids/],
        [{ ids: [wallId, 5], dryRun: false }, /5 is not one/],
        [{ ids: [wallId, "12abc"], dryRun: false }, /'12abc' is not an element id/],
        [{ ids: [wallId, "999999999"], dryRun: false }, /999999999/],
        [{ ids: [wallId], dryRun: "нет" }, /dryRun must be true or false/],
        [{ ids: Array.from({ length: 1001 }, () => wallId), dryRun: false }, /at most 1000/],
      ] as const) {
        const refused = await refusal(client, "delete_elements", params);

        assert.equal(refused.code, INVALID_PARAMS);
        assert.match(refused.message, message);
      }

      await assertThere(client, [wallId]);
      assert.deepEqual(await modelInfo(client), before);
    });
  });

  it("delete refuses what Revit cannot delete, by id", async () => {
    await withClient(async (client) => {
      const { ground } = ctx();
      const before = await modelInfo(client);

      // In the template the ground plan is the view Revit opens with, and that makes its level impossible to delete too.
      const refused = await refusal(client, "delete_elements", { ids: [ground.id], dryRun: false });

      console.log(`# refusal: ${refused.message}`);
      assert.equal(refused.code, INVALID_PARAMS);
      assert.ok(refused.message.includes(ground.id));
      assert.match(refused.message, /nothing was deleted/);
      assert.deepEqual(await modelInfo(client), before);
    });
  });

  it("a list that passes the check and that Revit still refuses leaves nothing and says so", async () => {
    await withClient(async (client) => {
      const walls = await createWalls(client, 1);
      const before = await modelInfo(client);
      const types = (await client.call("list_types", { category: "walls" })) as TypeRow[];
      const ids = types.map((type) => type.id);

      const dry = await remove(client, { ids, dryRun: true });
      const real = await remove(client, { ids, dryRun: false });

      console.log(`# every wall type, for real: ${JSON.stringify(real)}`);
      for (const result of [dry, real]) {
        assert.equal(result.committed, false);
        assert.deepEqual(result.allAffected, []);
        assert.deepEqual(result.dependents, []);
        assert.ok(result.errors.length > 0, "the reason is in errors");
        assert.match(result.summary, /nothing was deleted/i);
      }
      assert.deepEqual(await modelInfo(client), before);
      assert.deepEqual(((await client.call("list_types", { category: "walls" })) as TypeRow[]).length, types.length);

      // A rollback is no Undo step.
      await undo(client, "create_walls");
      await assertGone(client, walls);
    });
  });

  it("undo reverts one batch", async () => {
    await withClient(async (client) => {
      const [kept] = await createWalls(client, 1);
      const walls = await createWalls(client, 3);
      assert.ok(kept);

      const result = await undo(client, "create_walls");

      console.log(`# undo: ${JSON.stringify(result)}`);
      await assertGone(client, walls);
      await assertThere(client, [kept]);
      for (const id of walls) {
        assert.ok(result.createdIds.includes(id), `${id} is named as created by what was undone`);
      }
    });
  });

  it("undo twice goes back over two operations, one at a time", async () => {
    await withClient(async (client) => {
      const first = await createWalls(client, 2);
      const second = await createWalls(client, 2);

      await undo(client, "create_walls");
      await assertGone(client, second);
      await assertThere(client, first);

      await undo(client, "create_walls");
      await assertGone(client, first);
    });
  });

  it("a delete then undo brings the element back with the same id", async () => {
    await withClient(async (client) => {
      const [wallId] = await createWalls(client, 1);
      assert.ok(wallId);
      const before = await find(client, [wallId]);
      await remove(client, { ids: [wallId], dryRun: false });
      await assertGone(client, [wallId]);

      const result = await undo(client, "delete_elements");

      assert.ok(result.restoredIds.includes(wallId), JSON.stringify(result));
      assert.deepEqual(await find(client, [wallId]), before);
    });
  });

  it("a delete of a level with a wall, then undo, brings both back", async () => {
    await withClient(async (client) => {
      const created = await batch(client, "create_levels", [{ name: `Вернётся ${stamp}`, elevationMm: 12000 }]);
      const levelId = created.items[0]?.elementId;
      assert.ok(levelId);
      const [wallId] = await createWalls(client, 1, levelId);
      assert.ok(wallId);

      const deleted = await remove(client, { ids: [levelId], dryRun: false });
      assert.equal(deleted.committed, true, JSON.stringify(deleted));
      assert.ok(deleted.dependents.includes(wallId));
      await assertGone(client, [levelId, wallId]);

      await undo(client, "delete_elements");

      await assertThere(client, [levelId, wallId]);
    });
  });

  it("create_3d_view is exactly one Undo step", async () => {
    await withClient(async (client) => {
      const walls = await createWalls(client, 1);
      const view = (await client.call("create_3d_view", { name: `Вид ${stamp}`, kind: "isometric", displayStyle: "shading" })) as { committed: boolean; viewId: string };
      assert.equal(view.committed, true, JSON.stringify(view));

      await undo(client, "create_3d_view");

      assert.ok(!(await modelInfo(client)).views.some((row) => row.id === view.viewId), "the view is gone");
      await assertThere(client, walls);

      await undo(client, "create_walls");
      await assertGone(client, walls);
    });
  });

  it("undo walks back every tool that changes the model, with no dialog", async () => {
    await withClient(async (client) => {
      const { ground, floorType, roofType, wallType } = ctx();
      const x = 100_000;
      const corners = [{ x, y: 0 }, { x: x + 6000, y: 0 }, { x: x + 6000, y: 4000 }, { x, y: 4000 }];
      const levels = await batch(client, "create_levels", [{ name: `Шаг ${stamp}`, elevationMm: 15000 }]);
      const walls = await batch(client, "create_walls", corners.map((startMm, index) => ({
        startMm,
        endMm: corners[(index + 1) % corners.length],
        typeId: wallType.id,
        levelId: ground.id,
        heightMm: 2000,
      })));
      const floors = await batch(client, "create_floors", [{ boundaryMm: corners, typeId: floorType.id, levelId: ground.id }]);
      const roofs = await batch(client, "create_roof", [{ outlineMm: corners, typeId: roofType.id, levelId: ground.id, edgeSlopesDeg: [30, null, 30, null], overhangMm: 0 }]);
      const wallId = walls.items[0]?.elementId;
      const roofId = roofs.items[0]?.elementId;
      assert.ok(wallId && roofId);
      for (const result of [levels, walls, floors, roofs]) {
        assert.equal(result.committed, true, JSON.stringify(result));
      }
      const topBefore = (await find(client, [wallId])).elements[0]?.topMm;
      assert.equal((await batch(client, "attach_walls", [{ wallId, roofId }])).committed, true);
      const topAttached = (await find(client, [wallId])).elements[0]?.topMm;
      assert.notEqual(topAttached, topBefore, "the attachment changes the wall, or undoing it proves nothing");

      const attachment = await undo(client, "attach_walls");
      assert.deepEqual(attachment.createdIds, [], "an attachment creates no element");
      assert.ok(Math.abs((((await find(client, [wallId])).elements[0]?.topMm) ?? NaN) - (topBefore ?? NaN)) < NEAR_MM);

      await undo(client, "create_roof");
      await assertGone(client, [roofId]);
      await undo(client, "create_floors");
      await assertGone(client, floors.items.map((item) => item.elementId ?? ""));
      await undo(client, "create_walls");
      await assertGone(client, walls.items.map((item) => item.elementId ?? ""));
      await undo(client, "create_levels");
      await assertGone(client, levels.items.map((item) => item.elementId ?? ""));
    });
  });

  it("isModified follows the undo, past the last save", async () => {
    await withClient(async (client) => {
      await createWalls(client, 1);
      await client.call("save_project", {});
      assert.equal((await modelInfo(client)).activeDocument?.isModified, false);

      await undo(client, "create_walls");

      assert.equal((await modelInfo(client)).activeDocument?.isModified, true);
    });
  });

  for (const pauseMs of QUIET_PAUSES_MS) {
    it(`undo after ${pauseMs / 1000} s of quiet is confirmed`, async () => {
      await withClient(async (client) => {
        const walls = await createWalls(client, 1);

        await sleep(pauseMs);
        await undo(client, "create_walls");

        await assertGone(client, walls);
      });
    });

    it(`a posted undo left alone for ${pauseMs / 1000} s is confirmed by the request that follows it`, async () => {
      await withClient(async (client) => {
        const walls = await createWalls(client, 1);
        await sleep(1000);

        const posted = (await client.call("undo_last_operation", {})) as { undoId: number; transactionName: string };
        await sleep(pauseMs);
        const started = Date.now();
        const confirmed = (await client.call("get_last_undo_result", {})) as LastUndo;
        console.log(`# posted, ${pauseMs / 1000} s of quiet, confirmed in ${Date.now() - started} ms: ${JSON.stringify(confirmed)}`);

        assert.equal(confirmed.state, "undone", JSON.stringify(confirmed));
        assert.equal(confirmed.undoId, posted.undoId);
        await assertGone(client, walls);
      });
    });
  }

  it("get_last_undo_result can be asked again and gives the same answer", async () => {
    await withClient(async (client) => {
      await createWalls(client, 1);
      const result = await undo(client, "create_walls");

      const again = (await client.call("get_last_undo_result", {})) as LastUndo;

      assert.deepEqual(again, result);
    });
  });

  it("ten operations undone one after another all land", async () => {
    await withClient(async (client) => {
      const created: string[][] = [];
      for (let round = 0; round < 10; round++) {
        created.push(await createWalls(client, 1));
      }

      for (const walls of created.reverse()) {
        const result = await undo(client, "create_walls");

        assert.deepEqual(result.createdIds.filter((id) => walls.includes(id)), walls);
        await assertGone(client, walls);
      }
    });
  });

  it("undo refuses when the last operation lies in another document, and works once that one is active", async () => {
    await withClient(async (client) => {
      const walls = await createWalls(client, 1);
      const other = `${name}-другой`;
      await client.call("create_project", { name: other });

      const refused = await undoRefusal(client);

      console.log(`# refusal: ${refused.message}`);
      assert.ok(refused.message.includes(name), "the refusal names the project the last operation lies in");
      assert.match(refused.message, /open_project/);

      await client.call("open_project", { name });
      await assertThere(client, walls);
      await undo(client, "create_walls");
      await assertGone(client, walls);
    });
  });

  it("each document keeps its own history, and undo follows the last operation between them", async () => {
    await withClient(async (client) => {
      const first = await createWalls(client, 1);
      await client.call("open_project", { name: `${name}-другой` });
      const second = await createWalls(client, 1);

      await undo(client, "create_walls");
      await assertGone(client, second);

      const refused = await undoRefusal(client);
      assert.ok(refused.message.includes(name));

      await client.call("open_project", { name });
      await undo(client, "create_walls");
      await assertGone(client, first);
    });
  });

  it("undo refuses on a project just opened from its file", async (t) => {
    await withClient(async (client) => {
      const file = await closedProject(client);
      if (file === null) {
        t.skip("no project of an earlier run lies closed in the test folder");
        return;
      }

      const opened = (await client.call("open_project", { name: file })) as { alreadyOpen: boolean };
      assert.equal(opened.alreadyOpen, false);
      console.log(`# opened ${file}`);

      const refused = await undoRefusal(client);

      console.log(`# refusal: ${refused.message}`);
      assert.match(refused.message, NOTHING_HERE);
      await client.call("open_project", { name });
    });
  });

  it("leaves Revit in a state the close rule accepts", async () => {
    await withClient(async (client) => {
      await saveEverything(client);

      assert.deepEqual(checkCanClose((await modelInfo(client)).openDocuments), { ok: true, reasons: [] });
    });
  });
});
