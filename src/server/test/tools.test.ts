import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { TestContext } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { BridgeClient } from "../src/client.ts";
import { tools } from "../src/registry.ts";
import type { ToolDefinition } from "../src/registry.ts";
import { createServer } from "../src/server.ts";
import { presentSnapshot } from "../src/snapshot.ts";
import { FakeBridge } from "./fakeBridge.ts";
import type { FrameHandler } from "./fakeBridge.ts";

/** Connects an MCP client to the real server over memory, with the fake bridge behind it. */
async function connect(t: TestContext, handler: FrameHandler, toolList: readonly ToolDefinition[] = tools) {
  const bridge = new FakeBridge(handler);
  t.after(() => bridge.close());
  await bridge.start();

  const bridgeClient = new BridgeClient(bridge.connectionPath, { connectRetryDelayMs: 10 });
  t.after(() => bridgeClient.close());

  const server = createServer(bridgeClient, toolList);
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  t.after(async () => {
    await client.close();
    await server.close();
  });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);

  return { bridge, client };
}

function textOf(result: unknown): string {
  const content = (result as { content: Array<{ type: string; text: string }> }).content;
  return content.map((part) => part.text).join("\n");
}

const wall = { startMm: { x: 0, y: 0 }, endMm: { x: 6000.5, y: 0 }, typeId: "1", levelId: "2" };
const floor = { boundaryMm: [{ x: 0, y: 0 }, { x: 6000, y: 0 }, { x: 6000, y: 4000 }], typeId: "1", levelId: "2" };
const batch = <T>(length: number, item: T): T[] => Array.from({ length }, () => item);

describe("MCP tools", { timeout: 20_000 }, () => {
  it("lists every tool with a description", async (t) => {
    const { client } = await connect(t, () => {});

    const { tools } = await client.listTools();

    assert.deepEqual(
      tools.map((tool) => tool.name).sort(),
      [
        "cancel_request",
        "create_3d_view",
        "create_floors",
        "create_levels",
        "create_project",
        "create_walls",
        "get_elements",
        "get_model_info",
        "get_request_status",
        "get_status",
        "get_view_snapshot",
        "list_types",
        "open_project",
        "save_project",
      ],
    );
    for (const tool of tools) {
      assert.ok(tool.description && tool.description.length > 0);
    }
  });

  it("tells the model it can create or open a project itself", async (t) => {
    const { client } = await connect(t, () => {});

    const instructions = client.getInstructions() ?? "";

    assert.match(instructions, /create_project/);
    assert.match(instructions, /open_project/);
    assert.doesNotMatch(instructions, /with a project open/);
  });

  it("forwards a call to the bridge method of the same name and returns the result as JSON text", async (t) => {
    const { bridge, client } = await connect(t, (frame, connection) =>
      connection.result(frame, { pluginVersion: "1.0.0", protocolVersion: 1, queueLength: 0, oldestQueuedSeconds: 0 }),
    );

    const result = await client.callTool({ name: "get_status", arguments: {} });

    assert.ok(!result.isError);
    assert.deepEqual(JSON.parse(textOf(result)), {
      pluginVersion: "1.0.0",
      protocolVersion: 1,
      queueLength: 0,
      oldestQueuedSeconds: 0,
    });
    assert.equal(bridge.frames[0]?.method, "get_status");
  });

  it("passes requestId to get_request_status", async (t) => {
    const { bridge, client } = await connect(t, (frame, connection) =>
      connection.result(frame, { requestId: frame.params["requestId"], state: "running" }),
    );

    await client.callTool({ name: "get_request_status", arguments: { requestId: "abc-123" } });

    assert.deepEqual(bridge.frames[0]?.params, { requestId: "abc-123" });
  });

  it("rejects get_request_status without a requestId before it reaches Revit", async (t) => {
    const { bridge, client } = await connect(t, (frame, connection) => connection.result(frame, {}));

    const result = await client.callTool({ name: "get_request_status", arguments: {} }).catch((error: unknown) => error);

    const failed = result instanceof Error || (result as { isError?: boolean }).isError === true;
    assert.ok(failed);
    assert.equal(bridge.frames.length, 0);
  });

  it("passes a Cyrillic project name to Revit unchanged and returns the real path", async (t) => {
    const name = "Коттедж проба";
    const { bridge, client } = await connect(t, (frame, connection) =>
      connection.result(frame, { name: frame.params["name"], path: `C:\\Папка\\${String(frame.params["name"])}.rvt`, dialogs: [] }),
    );

    const result = await client.callTool({ name: "create_project", arguments: { name } });

    assert.ok(!result.isError);
    assert.equal(bridge.frames[0]?.method, "create_project");
    assert.deepEqual(bridge.frames[0]?.params, { name });
    assert.deepEqual(JSON.parse(textOf(result)), { name, path: `C:\\Папка\\${name}.rvt`, dialogs: [] });
  });

  for (const tool of ["create_project", "open_project"]) {
    it(`rejects ${tool} without a name before it reaches Revit`, async (t) => {
      const { bridge, client } = await connect(t, (frame, connection) => connection.result(frame, {}));

      const result = await client.callTool({ name: tool, arguments: {} }).catch((error: unknown) => error);

      const failed = result instanceof Error || (result as { isError?: boolean }).isError === true;
      assert.ok(failed);
      assert.equal(bridge.frames.length, 0);
    });
  }

  it("lets save_project run with or without a name", async (t) => {
    const { bridge, client } = await connect(t, (frame, connection) => connection.result(frame, { dialogs: [] }));

    await client.callTool({ name: "save_project", arguments: {} });
    await client.callTool({ name: "save_project", arguments: { name: "дом" } });

    assert.deepEqual(bridge.frames[0]?.params, {});
    assert.deepEqual(bridge.frames[1]?.params, { name: "дом" });
  });

  it("passes a list_types category and returns Cyrillic names intact", async (t) => {
    const types = [{ id: "123", family: "Базовая стена", name: "Кирпич 250 мм" }];
    const { bridge, client } = await connect(t, (frame, connection) => connection.result(frame, types));

    const result = await client.callTool({ name: "list_types", arguments: { category: "walls" } });

    assert.ok(!result.isError);
    assert.deepEqual(bridge.frames[0]?.params, { category: "walls" });
    assert.deepEqual(JSON.parse(textOf(result)), types);
  });

  for (const [tool, args] of [
    ["list_types", { category: "стены" }],
    ["list_types", {}],
    ["get_elements", { ids: [] }],
    ["get_elements", { ids: [123] }],
    ["get_elements", { ids: Array.from({ length: 1001 }, (_, index) => String(index + 1)) }],
    ["create_3d_view", { name: "Вид", kind: "orthographic", displayStyle: "realistic" }],
    ["create_3d_view", { name: "Вид", kind: "isometric", displayStyle: "wireframe" }],
    ["create_3d_view", { name: "Вид", kind: "isometric" }],
    ["create_3d_view", { name: "Вид", kind: "perspective", displayStyle: "realistic", eyeMm: { x: 1, y: 2 }, targetMm: { x: 0, y: 0, z: 0 } }],
    ["create_3d_view", { name: "Вид", kind: "isometric", displayStyle: "realistic", viewTemplateId: 56766 }],
    ["create_3d_view", { name: "Вид", kind: "isometric", displayStyle: "realistic", viewTemplateId: "" }],
    ["create_3d_view", { name: "Вид", kind: "isometric", displayStyle: "realistic", sunAzimuthDeg: -1, sunAltitudeDeg: 45 }],
    ["create_3d_view", { name: "Вид", kind: "isometric", displayStyle: "realistic", sunAzimuthDeg: 361, sunAltitudeDeg: 45 }],
    ["create_3d_view", { name: "Вид", kind: "isometric", displayStyle: "realistic", sunAzimuthDeg: 135, sunAltitudeDeg: -1 }],
    ["create_3d_view", { name: "Вид", kind: "isometric", displayStyle: "realistic", sunAzimuthDeg: 135, sunAltitudeDeg: 91 }],
    ["create_3d_view", { name: "Вид", kind: "isometric", displayStyle: "realistic", sunAzimuthDeg: "135", sunAltitudeDeg: 45 }],
    ["get_view_snapshot", {}],
    ["get_view_snapshot", { viewId: 123 }],
    ["get_view_snapshot", { viewId: "123", widthPx: 1600.5 }],
    ["get_view_snapshot", { viewId: "123", widthPx: 10 }],
    ["get_view_snapshot", { viewId: "123", widthPx: 100_000 }],
    ["create_levels", {}],
    ["create_levels", { items: [] }],
    ["create_levels", { items: [{ name: "Этаж" }] }],
    ["create_levels", { items: [{ elevationMm: 3000 }] }],
    ["create_levels", { items: [{ name: "", elevationMm: 3000 }] }],
    ["create_levels", { items: [{ name: "Этаж", elevationMm: "3000" }] }],
    ["create_levels", { items: [{ name: "Этаж", elevationMm: 3000, createPlan: "да" }] }],
    ["create_levels", { items: [{ name: "Этаж", elevationMm: 3000, plan: true }] }],
    ["create_levels", { items: batch(501, { name: "Этаж", elevationMm: 3000 }) }],
    ["create_walls", { items: [] }],
    ["create_walls", { items: [wall] }],
    ["create_walls", { items: [{ ...wall, heightMm: 3000, topLevelId: "2" }] }],
    ["create_walls", { items: [{ ...wall, heightMm: 0 }] }],
    ["create_walls", { items: [{ ...wall, heightMm: -3000 }] }],
    ["create_walls", { items: [{ ...wall, heightMm: 3000, typeId: 56766 }] }],
    ["create_walls", { items: [{ ...wall, heightMm: 3000, levelId: "" }] }],
    ["create_walls", { items: [{ ...wall, heightMm: 3000, startMm: { x: 1 } }] }],
    ["create_walls", { items: [{ ...wall, heightMm: 3000, startMm: { x: 1, y: 2, z: 3 } }] }],
    ["create_walls", { items: [{ ...wall, heightMm: 3000, height: 3000 }] }],
    ["create_walls", { items: batch(501, { ...wall, heightMm: 3000 }) }],
    ["create_floors", { items: [] }],
    ["create_floors", { items: [{ ...floor, boundaryMm: floor.boundaryMm.slice(0, 2) }] }],
    ["create_floors", { items: [{ ...floor, boundaryMm: [{ x: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 }] }] }],
    ["create_floors", { items: [{ ...floor, typeId: 56766 }] }],
    ["create_floors", { items: [{ typeId: "1", levelId: "2" }] }],
    ["create_floors", { items: batch(501, floor) }],
  ] as const) {
    it(`rejects ${tool} ${JSON.stringify(args).slice(0, 120)} before it reaches Revit`, async (t) => {
      const { bridge, client } = await connect(t, (frame, connection) => connection.result(frame, {}));

      const result = await client.callTool({ name: tool, arguments: args }).catch((error: unknown) => error);

      const failed = result instanceof Error || (result as { isError?: boolean }).isError === true;
      assert.ok(failed);
      assert.equal(bridge.frames.length, 0);
    });
  }

  it("passes levels to create_levels with Cyrillic intact, and a plan unless told otherwise", async (t) => {
    const answer = { committed: true, items: [], warnings: [], errors: [], dialogs: [] };
    const { bridge, client } = await connect(t, (frame, connection) => connection.result(frame, answer));

    const result = await client.callTool({
      name: "create_levels",
      arguments: { items: [{ name: "Этаж 2", elevationMm: 3000.5 }, { name: "Чердак", elevationMm: -500, createPlan: false }] },
    });

    assert.ok(!result.isError);
    assert.equal(bridge.frames[0]?.method, "create_levels");
    assert.deepEqual(bridge.frames[0]?.params, {
      items: [{ name: "Этаж 2", elevationMm: 3000.5, createPlan: true }, { name: "Чердак", elevationMm: -500, createPlan: false }],
    });
    assert.deepEqual(JSON.parse(textOf(result)), answer);
  });

  it("passes a wall with a height and a wall with a top level, with no offset unless told otherwise", async (t) => {
    const { bridge, client } = await connect(t, (frame, connection) => connection.result(frame, { committed: true }));

    const result = await client.callTool({
      name: "create_walls",
      arguments: { items: [{ ...wall, heightMm: 2750.5 }, { ...wall, topLevelId: "3", baseOffsetMm: -300 }] },
    });

    assert.ok(!result.isError);
    assert.deepEqual(bridge.frames[0]?.params, {
      items: [{ ...wall, heightMm: 2750.5, baseOffsetMm: 0 }, { ...wall, topLevelId: "3", baseOffsetMm: -300 }],
    });
  });

  it("passes a floor outline of the fewest points unchanged, and returns the honest result", async (t) => {
    const answer = { committed: false, items: [{ index: 0, status: "failed", error: "Причина" }], warnings: [], errors: ["Причина"], dialogs: [] };
    const { bridge, client } = await connect(t, (frame, connection) => connection.result(frame, answer));

    const result = await client.callTool({ name: "create_floors", arguments: { items: [floor] } });

    assert.ok(!result.isError);
    assert.deepEqual(bridge.frames[0]?.params, { items: [floor] });
    assert.deepEqual(JSON.parse(textOf(result)), answer);
  });

  it("takes 500 items in a create_ tool, the most it allows", async (t) => {
    const { bridge, client } = await connect(t, (frame, connection) => connection.result(frame, { committed: true }));

    const result = await client.callTool({ name: "create_floors", arguments: { items: batch(500, floor) } });

    assert.ok(!result.isError);
    assert.equal((bridge.frames[0]?.params["items"] as unknown[]).length, 500);
  });

  it("tells the model the truth about batches", async (t) => {
    const { client } = await connect(t, () => {});

    const { tools: listed } = await client.listTools();

    for (const name of ["create_levels", "create_walls", "create_floors"]) {
      const description = listed.find((tool) => tool.name === name)?.description ?? "";

      assert.match(description, /one Undo step/);
      assert.match(description, /millimetres/);
      assert.match(description, /500/);
      for (const word of ["created", "failed", "rolled_back", "not attempted", "actual"]) {
        assert.ok(description.includes(word), `${name} should explain ${word}`);
      }
    }

    const levels = listed.find((tool) => tool.name === "create_levels")?.description ?? "";
    assert.match(levels, /already_existed/);
    assert.match(levels, /left as it is/);
  });

  it("passes the ids of get_elements as strings", async (t) => {
    const { bridge, client } = await connect(t, (frame, connection) => connection.result(frame, { elements: [], notFound: ["1"] }));

    const result = await client.callTool({ name: "get_elements", arguments: { ids: ["1", "9007199254740993"] } });

    assert.ok(!result.isError);
    assert.deepEqual(bridge.frames[0]?.params, { ids: ["1", "9007199254740993"] });
  });

  it("takes 1000 ids in get_elements, the most it allows", async (t) => {
    const { bridge, client } = await connect(t, (frame, connection) => connection.result(frame, { elements: [], notFound: [] }));
    const ids = Array.from({ length: 1000 }, (_, index) => String(index + 1));

    const result = await client.callTool({ name: "get_elements", arguments: { ids } });

    assert.ok(!result.isError);
    assert.deepEqual(bridge.frames[0]?.params, { ids });
  });

  it("passes the camera of create_3d_view unchanged and returns the honest result", async (t) => {
    const answer = { committed: false, viewId: null, errors: ["Причина"], warnings: [], dialogs: [] };
    const { bridge, client } = await connect(t, (frame, connection) => connection.result(frame, answer));
    const camera = { eyeMm: { x: 1, y: 2.5, z: -3 }, targetMm: { x: 0, y: 0, z: 0 } };

    const result = await client.callTool({
      name: "create_3d_view",
      arguments: { name: "Вид с юга", kind: "perspective", displayStyle: "realistic", ...camera },
    });

    assert.deepEqual(bridge.frames[0]?.params, { name: "Вид с юга", kind: "perspective", displayStyle: "realistic", ...camera });
    assert.deepEqual(JSON.parse(textOf(result)), answer);
  });

  it("accepts view_templates in list_types and passes it to Revit", async (t) => {
    const templates = [{ id: "56766", family: "", name: "Архитектурная презентация 3D" }];
    const { bridge, client } = await connect(t, (frame, connection) => connection.result(frame, templates));

    const result = await client.callTool({ name: "list_types", arguments: { category: "view_templates" } });

    assert.ok(!result.isError);
    assert.deepEqual(bridge.frames[0]?.params, { category: "view_templates" });
    assert.deepEqual(JSON.parse(textOf(result)), templates);
  });

  it("passes a template and a sun of create_3d_view unchanged, at the ends of their ranges too", async (t) => {
    const { bridge, client } = await connect(t, (frame, connection) => connection.result(frame, { committed: true }));
    const view = { name: "Вид", kind: "isometric", displayStyle: "realistic" };

    await client.callTool({ name: "create_3d_view", arguments: { ...view, viewTemplateId: "56766", sunAzimuthDeg: 135.5, sunAltitudeDeg: 45 } });
    await client.callTool({ name: "create_3d_view", arguments: { ...view, sunAzimuthDeg: 0, sunAltitudeDeg: 90 } });
    await client.callTool({ name: "create_3d_view", arguments: { ...view, sunAzimuthDeg: 360, sunAltitudeDeg: 0 } });

    assert.deepEqual(bridge.frames[0]?.params, { ...view, viewTemplateId: "56766", sunAzimuthDeg: 135.5, sunAltitudeDeg: 45 });
    assert.deepEqual(bridge.frames[1]?.params, { ...view, sunAzimuthDeg: 0, sunAltitudeDeg: 90 });
    assert.deepEqual(bridge.frames[2]?.params, { ...view, sunAzimuthDeg: 360, sunAltitudeDeg: 0 });
  });

  it("tells the model the truth about shadows in create_3d_view", async (t) => {
    const { client } = await connect(t, () => {});

    const { tools: listed } = await client.listTools();
    const description = listed.find((tool) => tool.name === "create_3d_view")?.description ?? "";

    assert.match(description, /without a template it has no cast shadows/);
    assert.match(description, /view_templates/);
    assert.match(description, /cannot be read back/);
  });

  async function snapshotFolder(t: TestContext): Promise<{ folder: string; toolList: readonly ToolDefinition[] }> {
    const folder = await mkdtemp(path.join(tmpdir(), "revitmcp-tools-"));
    t.after(() => rm(folder, { recursive: true, force: true }));
    const toolList = tools.map((tool) => (tool.name === "get_view_snapshot" ? { ...tool, present: presentSnapshot(folder) } : tool));
    return { folder, toolList };
  }

  it("returns get_view_snapshot as an MCP image, and asks for 1600 pixels unless told otherwise", async (t) => {
    const { folder, toolList } = await snapshotFolder(t);
    const file = path.join(folder, "вид.png");
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    await writeFile(file, png);
    const { bridge, client } = await connect(
      t,
      (frame, connection) => connection.result(frame, { viewId: "7", viewName: "Вид", path: file, dialogs: [] }),
      toolList,
    );

    const result = await client.callTool({ name: "get_view_snapshot", arguments: { viewId: "7" } });

    assert.ok(!result.isError);
    assert.deepEqual(bridge.frames[0]?.params, { viewId: "7", widthPx: 1600 });
    const content = result.content as Array<{ type: string; data?: string; mimeType?: string; text?: string }>;
    assert.equal(content[0]?.type, "image");
    assert.equal(content[0]?.mimeType, "image/png");
    assert.deepEqual(Buffer.from(content[0]?.data ?? "", "base64"), png);
    assert.deepEqual(JSON.parse(content[1]?.text ?? ""), { viewId: "7", viewName: "Вид", path: file, dialogs: [], sizeBytes: png.length });
  });

  it("turns a snapshot path outside the folder into a tool error and shows no file", async (t) => {
    const { folder, toolList } = await snapshotFolder(t);
    const secret = path.join(path.dirname(folder), `${path.basename(folder)}-evil.png`);
    t.after(() => rm(secret, { force: true }));
    await writeFile(secret, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9]));
    const { client } = await connect(t, (frame, connection) => connection.result(frame, { path: secret, dialogs: [] }), toolList);

    const result = await client.callTool({ name: "get_view_snapshot", arguments: { viewId: "7" } });

    assert.equal(result.isError, true);
    assert.match(textOf(result), /outside/);
    assert.equal((result.content as Array<{ type: string }>).filter((part) => part.type === "image").length, 0);
  });

  it("returns a tool error, not a protocol error, when Revit is not running", async (t) => {
    const { bridge, client } = await connect(t, () => {});
    await bridge.writeConnectionFile({ pid: 2 ** 31 - 2 });

    const result = await client.callTool({ name: "get_status", arguments: {} });

    assert.equal(result.isError, true);
    assert.match(textOf(result), /start Revit/i);
  });

  it("puts the request id into the tool error of a request that is still running", async (t) => {
    let original: string | undefined;
    const quick = tools.map((tool) => (tool.name === "get_model_info" ? { ...tool, timeoutMs: 50 } : tool));
    const { client } = await connect(
      t,
      (frame, connection) => {
        if (frame.method === "cancel_request") {
          connection.result(frame, { requestId: original, state: "running" });
        } else if (frame.method === "get_model_info") {
          original = frame.id;
        }
      },
      quick,
    );

    const result = await client.callTool({ name: "get_model_info", arguments: {} });

    assert.equal(result.isError, true);
    assert.ok(original);
    assert.ok(textOf(result).includes(original));
    assert.match(textOf(result), /get_request_status/);
  });
});
