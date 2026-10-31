import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { inflateSync } from "node:zlib";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { checkCanClose } from "../../src/cli/closeRule.ts";
import { BridgeClient } from "../../src/client.ts";
import { defaultConnectionPath } from "../../src/connection.ts";
import { BridgeRpcError } from "../../src/errors.ts";
import { createServer } from "../../src/server.ts";
import { defaultSnapshotFolder } from "../../src/snapshot.ts";

// These tests need a running Revit with the RevitMCP plugin loaded. Each run creates one new project in the test
// folder and leaves it open and saved. It holds no walls yet, so pictures come from what the template draws.

interface View {
  id: string;
  name: string;
  viewType: string;
}

interface OpenDocument {
  title: string;
  path: string;
  isModified: boolean;
}

interface ModelInfo {
  activeDocument: OpenDocument | null;
  openDocuments: OpenDocument[];
  levels: Array<{ id: string; name: string }>;
  views: View[];
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
  boundingBoxMm: { min: Record<string, number>; max: Record<string, number> } | null;
}

interface CreatedView {
  committed: boolean;
  viewId: string | null;
  name: string;
  kind: string;
  displayStyle: string | null;
  warnings: string[];
  errors: string[];
  dialogs: unknown[];
}

interface Snapshot {
  viewId: string;
  viewName: string;
  path: string;
  dialogs: unknown[];
}

const INVALID_PARAMS = -32602;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// Measured: a flat 1600 x 1200 export from Revit holds 6 distinct bytes, its empty plan 33 and a building 200 and more.
const FLAT_PICTURE_BYTES = 8;
const CATEGORIES = ["walls", "floors", "roofs", "ceilings", "doors", "windows", "furniture", "plumbing", "stairs", "railings"];
const CAMERA = { eyeMm: { x: 20000, y: -20000, z: 8000 }, targetMm: { x: 0, y: 0, z: 2000 } };

const stamp = new Date().toTimeString().slice(0, 8).replaceAll(":", "");
const name = `проверка-задача10-${stamp}`;

async function withClient<T>(body: (client: BridgeClient) => Promise<T>): Promise<T> {
  const client = new BridgeClient(defaultConnectionPath());
  try {
    return await body(client);
  } finally {
    client.close();
  }
}

const modelInfo = (client: BridgeClient): Promise<ModelInfo> => client.call("get_model_info", {}) as Promise<ModelInfo>;

/** Calls a method that must refuse, and returns the refusal. */
async function refusal(client: BridgeClient, method: string, params: object): Promise<BridgeRpcError> {
  const error = await client.call(method, params).then(
    (result) => assert.fail(`${method} ${JSON.stringify(params)} should be refused, and returned ${JSON.stringify(result)}`),
    (reason: unknown) => reason,
  );

  assert.ok(error instanceof BridgeRpcError, `${method}: expected a plugin error, got ${String(error)}`);
  return error;
}

/** Reads the pixel size and checks the signature. Tells a picture from one flat colour by the bytes of its pixels. */
function inspectPng(image: Buffer): { width: number; height: number; distinctBytes: number } {
  assert.deepEqual(image.subarray(0, PNG_SIGNATURE.length), PNG_SIGNATURE, "not a PNG");

  const parts: Buffer[] = [];
  for (let offset = PNG_SIGNATURE.length; offset < image.length; ) {
    const length = image.readUInt32BE(offset);
    if (image.toString("latin1", offset + 4, offset + 8) === "IDAT") {
      parts.push(image.subarray(offset + 8, offset + 8 + length));
    }
    offset += length + 12;
  }

  return {
    width: image.readUInt32BE(16),
    height: image.readUInt32BE(20),
    distinctBytes: new Set(inflateSync(Buffer.concat(parts))).size,
  };
}

const firstView = (info: ModelInfo, viewType: string): View => {
  const view = info.views.find((candidate) => candidate.viewType === viewType);
  assert.ok(view, `the template should give a ${viewType}`);
  return view;
};

describe("stage 2 live checks: reading and snapshots", { timeout: 120_000 }, () => {
  it("creates a project for this run", async () => {
    await withClient(async (client) => {
      await client.call("create_project", { name });
      assert.equal((await modelInfo(client)).activeDocument?.title, name);
    });
  });

  it("list_types gives wall types with Cyrillic intact, in a stable order", async () => {
    await withClient(async (client) => {
      const walls = (await client.call("list_types", { category: "walls" })) as TypeRow[];
      console.log(`# list_types walls: ${walls.length} types, for example ${JSON.stringify(walls.at(-20))}`);

      assert.ok(walls.length > 0);
      assert.ok(walls.some((wall) => /[а-яё]/i.test(wall.name)), "wall type names should be Cyrillic");
      assert.ok(walls.every((wall) => /^\d+$/.test(wall.id) && wall.family.length > 0 && wall.name.length > 0));
      assert.deepEqual(await client.call("list_types", { category: "walls" }), walls);
    });
  });

  it("list_types answers for every category and refuses another word, naming the allowed ones", async () => {
    await withClient(async (client) => {
      for (const category of CATEGORIES) {
        const types = (await client.call("list_types", { category })) as TypeRow[];
        console.log(`# list_types ${category}: ${types.length}`);
        assert.ok(Array.isArray(types));
      }

      const refused = await refusal(client, "list_types", { category: "стены" });

      assert.equal(refused.code, INVALID_PARAMS);
      for (const category of CATEGORIES) {
        assert.ok(refused.message.includes(category), `${category} is missing from: ${refused.message}`);
      }
    });
  });

  it("get_elements reads known ids, lists missing ones, and refuses text that is no id", async () => {
    await withClient(async (client) => {
      const info = await modelInfo(client);
      const [wallType] = (await client.call("list_types", { category: "walls" })) as TypeRow[];
      const level = info.levels[0];
      assert.ok(wallType && level);

      const result = (await client.call("get_elements", { ids: [wallType.id, "999999999", level.id, wallType.id, "-1"] })) as {
        elements: ElementRow[];
        notFound: string[];
      };
      console.log(`# get_elements: ${JSON.stringify(result)}`);

      assert.deepEqual(result.notFound, ["999999999", "-1"]);
      assert.deepEqual(result.elements.map((element) => element.id), [wallType.id, level.id]);
      assert.equal(result.elements[0]?.category, "walls");
      assert.equal(result.elements[0]?.boundingBoxMm, null);
      assert.equal(result.elements[1]?.category, "OST_Levels");

      for (const id of ["abc", "12abc", "1.5", "", " 5", "+5", "007", "99999999999999999999"]) {
        const refused = await refusal(client, "get_elements", { ids: [level.id, id] });
        assert.equal(refused.code, INVALID_PARAMS, id);
      }
      assert.equal((await refusal(client, "get_elements", { ids: [Number(level.id)] })).code, INVALID_PARAMS);
      assert.equal((await refusal(client, "get_elements", { ids: [] })).code, INVALID_PARAMS);
    });
  });

  it("create_3d_view makes both kinds, and reports the style and Cyrillic name it really got", async () => {
    await withClient(async (client) => {
      const isometric = (await client.call("create_3d_view", { name: "Изометрия проба", kind: "isometric", displayStyle: "shading" })) as CreatedView;
      const perspective = (await client.call("create_3d_view", { name: "Перспектива проба", kind: "perspective", displayStyle: "realistic", ...CAMERA })) as CreatedView;
      console.log(`# create_3d_view: ${JSON.stringify([isometric, perspective])}`);

      for (const created of [isometric, perspective]) {
        assert.equal(created.committed, true);
        assert.deepEqual(created.errors, []);
        assert.deepEqual(created.dialogs, []);
      }
      assert.equal(isometric.displayStyle, "shading");
      assert.equal(perspective.displayStyle, "realistic");

      const views = (await modelInfo(client)).views;
      assert.equal(views.find((view) => view.id === isometric.viewId)?.name, "Изометрия проба");
      assert.equal(views.find((view) => view.id === perspective.viewId)?.viewType, "ThreeD");
    });
  });

  it("create_3d_view refuses what it cannot honour and creates nothing", async () => {
    await withClient(async (client) => {
      const before = (await modelInfo(client)).views.length;
      const base = { name: "Отказ", kind: "perspective", displayStyle: "realistic", ...CAMERA };

      for (const params of [
        { ...base, name: "Перспектива проба" },
        { ...base, name: "ПЕРСПЕКТИВА ПРОБА" },
        { ...base, name: "скобка{" },
        { ...base, name: " пробел" },
        { ...base, kind: "orthographic" },
        { ...base, displayStyle: "wireframe" },
        { name: "Отказ", kind: "perspective", displayStyle: "realistic" },
        { ...base, targetMm: undefined },
        { ...base, targetMm: CAMERA.eyeMm },
        { ...base, eyeMm: { x: 1, y: 2 } },
        { ...base, kind: "isometric" },
        { name: "Отказ", kind: "isometric", displayStyle: "realistic", targetMm: CAMERA.targetMm },
        ...[..."{}[]|;<>?`~\\:"].map((character) => ({ ...base, name: `Отказ${character}` })),
      ]) {
        const refused = await refusal(client, "create_3d_view", params);
        assert.equal(refused.code, INVALID_PARAMS, JSON.stringify(params));
      }

      assert.equal((await modelInfo(client)).views.length, before);
    });
  });

  it("a perspective camera far from the model still sees it", async () => {
    await withClient(async (client) => {
      const info = await modelInfo(client);
      const created = (await client.call("create_3d_view", {
        name: "Издалека",
        kind: "perspective",
        displayStyle: "shading",
        eyeMm: { x: 60000, y: -60000, z: 20000 },
        targetMm: { x: 0, y: 0, z: 0 },
      })) as CreatedView;
      assert.equal(created.committed, true);

      // The level lines are all an empty project has to see, and Revit clipped them with a far clip of about 36 m.
      const snapshot = (await client.call("get_view_snapshot", { viewId: created.viewId, widthPx: 800 })) as Snapshot;
      const png = inspectPng(await readFile(snapshot.path));
      console.log(`# far camera: ${JSON.stringify(png)}, levels ${info.levels.length}`);

      assert.ok(png.distinctBytes > FLAT_PICTURE_BYTES, `the picture is flat: ${JSON.stringify(png)}`);
    });
  });

  it("get_view_snapshot exports a real PNG of the width asked for, inside the folder", async () => {
    await withClient(async (client) => {
      const plan = firstView(await modelInfo(client), "FloorPlan");
      const started = performance.now();

      const snapshot = (await client.call("get_view_snapshot", { viewId: plan.id, widthPx: 1200 })) as Snapshot;
      const image = await readFile(snapshot.path);
      const png = inspectPng(image);
      console.log(`# snapshot took ${((performance.now() - started) / 1000).toFixed(2)} s, ${image.length} bytes: ${JSON.stringify({ ...snapshot, ...png })}`);

      assert.equal(snapshot.viewId, plan.id);
      assert.equal(snapshot.viewName, plan.name);
      assert.equal(path.win32.dirname(snapshot.path).toLowerCase(), defaultSnapshotFolder().toLowerCase());
      assert.deepEqual(snapshot.dialogs, []);
      assert.equal(png.width, 1200);
      assert.ok(png.height > 0);
      assert.ok(png.distinctBytes > FLAT_PICTURE_BYTES, `the picture is flat: ${JSON.stringify(png)}`);
    });
  });

  it("get_view_snapshot takes 1600 pixels unless told otherwise, gives each export its own file and survives odd names", async () => {
    await withClient(async (client) => {
      const created = (await client.call("create_3d_view", { name: 'Вид/1*"2.', kind: "isometric", displayStyle: "realistic" })) as CreatedView;
      assert.equal(created.committed, true);

      const first = (await client.call("get_view_snapshot", { viewId: created.viewId })) as Snapshot;
      const second = (await client.call("get_view_snapshot", { viewId: created.viewId })) as Snapshot;

      assert.notEqual(first.path, second.path);
      assert.ok(existsSync(first.path) && existsSync(second.path));
      assert.equal(first.viewName, 'Вид/1*"2.');
      assert.equal(inspectPng(await readFile(first.path)).width, 1600);
    });
  });

  it("get_view_snapshot refuses what is no view and names the views that can be used", async () => {
    await withClient(async (client) => {
      const info = await modelInfo(client);
      const plan = firstView(info, "FloorPlan");
      const level = info.levels[0];
      assert.ok(level);

      for (const viewId of ["999999999", level.id]) {
        const refused = await refusal(client, "get_view_snapshot", { viewId });
        assert.equal(refused.code, INVALID_PARAMS);
        assert.ok(refused.message.includes(plan.id), refused.message);
      }

      assert.equal((await refusal(client, "get_view_snapshot", { viewId: "abc" })).code, INVALID_PARAMS);
      for (const widthPx of [99, 4097, 1600.5, "1600"]) {
        assert.equal((await refusal(client, "get_view_snapshot", { viewId: plan.id, widthPx })).code, INVALID_PARAMS);
      }
    });
  });

  it("the read tools leave a saved project saved, so they left no change to undo", async () => {
    await withClient(async (client) => {
      await client.call("save_project", {});
      const info = await modelInfo(client);
      assert.equal(info.activeDocument?.isModified, false);
      const view = firstView(info, "ThreeD");

      await client.call("list_types", { category: "doors" });
      await client.call("get_elements", { ids: [view.id] });
      await client.call("get_view_snapshot", { viewId: view.id, widthPx: 400 });

      assert.equal((await modelInfo(client)).activeDocument?.isModified, false);
    });
  });

  it("the MCP tool returns the snapshot as an image the client can read", async () => {
    await withClient(async (bridge) => {
      const server = createServer(bridge);
      const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "live", version: "0.0.0" });
      await Promise.all([server.connect(serverSide), client.connect(clientSide)]);

      try {
        const view = firstView(await modelInfo(bridge), "ThreeD");
        const result = await client.callTool({ name: "get_view_snapshot", arguments: { viewId: view.id } });
        const [image, text] = result.content as Array<{ type: string; data: string; mimeType: string; text: string }>;
        console.log(`# MCP result: ${text?.text}, base64 ${image?.data.length} characters`);

        assert.ok(!result.isError);
        assert.equal(image?.type, "image");
        assert.equal(image?.mimeType, "image/png");
        assert.equal(inspectPng(Buffer.from(image?.data ?? "", "base64")).width, 1600);
        assert.equal((JSON.parse(text?.text ?? "{}") as { viewId?: string }).viewId, view.id);
      } finally {
        await client.close();
        await server.close();
      }
    });
  });

  it("leaves Revit in a state the close rule accepts", async () => {
    await withClient(async (client) => {
      await client.call("save_project", {});
      assert.deepEqual(checkCanClose((await modelInfo(client)).openDocuments), { ok: true, reasons: [] });
    });
  });
});
