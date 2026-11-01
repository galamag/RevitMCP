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
const roof = {
  outlineMm: [{ x: 0, y: 0 }, { x: 6000, y: 0 }, { x: 6000, y: 4000 }, { x: 0, y: 4000 }],
  levelId: "2",
  typeId: "1",
  edgeSlopesDeg: [30, null, 30.5, null],
};
const attachment = { wallId: "10", roofId: "20" };
const ceiling = { boundaryMm: floor.boundaryMm, typeId: "1", levelId: "2", heightOffsetMm: 2350 };
const opening = { floorId: "10", boundaryMm: floor.boundaryMm };
const ground = { boundaryMm: floor.boundaryMm, levelId: "2", topOffsetMm: -400, typeId: "5" };
const family = { path: "Russia\\Мебель\\Кровати\\Кровать-Стандарт.rfa" };
const familyRow = { path: "Russia\\Двери\\Дверь-Одинарная-Панель.rfa", typeName: "800 x 2100 мм", widthMm: 800, heightMm: 2100 };
const instance = { typeId: "7", pointMm: { x: 1000, y: 2000 }, levelId: "2" };
const hosted = { typeId: "7", wallId: "10", offsetAlongWallMm: 1500, sillHeightMm: 900 };
const material = { name: "Краснодарский кирпич", colorRgb: { r: 170, g: 40, b: 35 } };
const layer = { thicknessMm: 200, materialId: "7", function: "structure" };
const typeItem = { category: "walls", baseTypeId: "408", name: "Стена 250 мм" };
const batch = <T>(length: number, item: T): T[] => Array.from({ length }, () => item);

describe("MCP tools", { timeout: 20_000 }, () => {
  it("lists every tool with a description", async (t) => {
    const { client } = await connect(t, () => {});

    const { tools } = await client.listTools();

    assert.deepEqual(
      tools.map((tool) => tool.name).sort(),
      [
        "attach_walls",
        "cancel_request",
        "create_3d_view",
        "create_ceilings",
        "create_floor_openings",
        "create_floors",
        "create_ground",
        "create_levels",
        "create_materials",
        "create_project",
        "create_roof",
        "create_type",
        "create_walls",
        "delete_elements",
        "get_elements",
        "get_last_undo_result",
        "get_model_info",
        "get_request_status",
        "get_status",
        "get_view_snapshot",
        "get_warnings",
        "list_materials",
        "list_types",
        "load_family",
        "open_project",
        "place_hosted",
        "place_instances",
        "save_project",
        "undo_last_operation",
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

  it("passes the toposolid category of list_types and get_elements to Revit", async (t) => {
    const { bridge, client } = await connect(t, (frame, connection) => connection.result(frame, []));

    assert.ok(!(await client.callTool({ name: "list_types", arguments: { category: "toposolid" } })).isError);
    assert.ok(!(await client.callTool({ name: "get_elements", arguments: { category: "toposolid" } })).isError);
    assert.deepEqual(bridge.frames.map((frame) => frame.params), [{ category: "toposolid" }, { category: "toposolid" }]);
  });

  for (const [tool, args] of [
    ["list_types", { category: "стены" }],
    ["list_types", {}],
    ["get_elements", { ids: [] }],
    ["get_elements", { ids: [123] }],
    ["get_elements", { ids: Array.from({ length: 1001 }, (_, index) => String(index + 1)) }],
    ["get_elements", { category: "стены" }],
    ["get_elements", { category: "view_templates" }],
    ["get_elements", { category: 5 }],
    ["get_elements", { category: "walls", levelId: 5 }],
    ["get_elements", { category: "walls", levelId: "" }],
    ["get_elements", { ids: "1" }],
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
    ["create_roof", {}],
    ["create_roof", { items: [] }],
    ["create_roof", { items: batch(501, roof) }],
    ["create_roof", { items: [{ ...roof, edgeSlopesDeg: [30, null, 30] }] }],
    ["create_roof", { items: [{ ...roof, edgeSlopesDeg: [30, null, 30, null, 30] }] }],
    ["create_roof", { items: [{ ...roof, edgeSlopesDeg: [null, null, null, null] }] }],
    ["create_roof", { items: [{ ...roof, edgeSlopesDeg: [0, null, 30, null] }] }],
    ["create_roof", { items: [{ ...roof, edgeSlopesDeg: [-30, null, 30, null] }] }],
    ["create_roof", { items: [{ ...roof, edgeSlopesDeg: [90, null, 30, null] }] }],
    ["create_roof", { items: [{ ...roof, edgeSlopesDeg: ["30", null, 30, null] }] }],
    ["create_roof", { items: [{ ...roof, overhangMm: -1 }] }],
    ["create_roof", { items: [{ ...roof, outlineMm: roof.outlineMm.slice(0, 2), edgeSlopesDeg: [30, null] }] }],
    ["create_roof", { items: [{ ...roof, typeId: 56766 }] }],
    ["create_roof", { items: [{ ...roof, levelId: "" }] }],
    ["create_roof", { items: [{ ...roof, slopes: [30] }] }],
    ["create_materials", {}],
    ["create_materials", { items: [] }],
    ["create_materials", { items: [{ name: "Без цвета" }] }],
    ["create_materials", { items: [{ colorRgb: material.colorRgb }] }],
    ["create_materials", { items: [{ ...material, name: "" }] }],
    ["create_materials", { items: [{ ...material, colorRgb: { r: 256, g: 0, b: 0 } }] }],
    ["create_materials", { items: [{ ...material, colorRgb: { r: -1, g: 0, b: 0 } }] }],
    ["create_materials", { items: [{ ...material, colorRgb: { r: 1.5, g: 0, b: 0 } }] }],
    ["create_materials", { items: [{ ...material, colorRgb: { r: 1, g: 2 } }] }],
    ["create_materials", { items: [{ ...material, colorRgb: { r: 1, g: 2, b: 3, a: 4 } }] }],
    ["create_materials", { items: [{ ...material, colorRgb: "#ff0000" }] }],
    ["create_materials", { items: [{ ...material, transparency: 101 }] }],
    ["create_materials", { items: [{ ...material, transparency: -1 }] }],
    ["create_materials", { items: [{ ...material, transparency: 50.5 }] }],
    ["create_materials", { items: [{ ...material, baseMaterialId: 56766 }] }],
    ["create_materials", { items: [{ ...material, baseMaterialId: "" }] }],
    ["create_materials", { items: [{ ...material, shininess: 5 }] }],
    ["create_materials", { items: batch(501, material) }],
    ["create_type", {}],
    ["create_type", { items: [] }],
    ["create_type", { items: [{ ...typeItem, category: "doors" }] }],
    ["create_type", { items: [{ ...typeItem, category: "стены" }] }],
    ["create_type", { items: [{ ...typeItem, baseTypeId: 408 }] }],
    ["create_type", { items: [{ ...typeItem, baseTypeId: "" }] }],
    ["create_type", { items: [{ ...typeItem, name: "" }] }],
    ["create_type", { items: [{ category: "walls", name: "Без основы" }] }],
    ["create_type", { items: [{ ...typeItem, layers: [] }] }],
    ["create_type", { items: [{ ...typeItem, layers: [{ ...layer, function: "core" }] }] }],
    ["create_type", { items: [{ ...typeItem, layers: [{ ...layer, function: "Structure" }] }] }],
    ["create_type", { items: [{ ...typeItem, layers: [{ ...layer, thicknessMm: -1 }] }] }],
    ["create_type", { items: [{ ...typeItem, layers: [{ ...layer, thicknessMm: "200" }] }] }],
    ["create_type", { items: [{ ...typeItem, layers: [{ ...layer, materialId: 7 }] }] }],
    ["create_type", { items: [{ ...typeItem, layers: [{ thicknessMm: 200, function: "structure" }] }] }],
    ["create_type", { items: [{ ...typeItem, layers: [{ ...layer, material: "Бетон" }] }] }],
    ["create_type", { items: [{ ...typeItem, width: 250 }] }],
    ["create_type", { items: batch(501, typeItem) }],
    ["create_ceilings", {}],
    ["create_ceilings", { items: [] }],
    ["create_ceilings", { items: batch(501, ceiling) }],
    ["create_ceilings", { items: [{ boundaryMm: ceiling.boundaryMm, typeId: "1", levelId: "2" }] }],
    ["create_ceilings", { items: [{ ...ceiling, heightOffsetMm: "2350" }] }],
    ["create_ceilings", { items: [{ ...ceiling, heightOffsetMm: null }] }],
    ["create_ceilings", { items: [{ ...ceiling, boundaryMm: ceiling.boundaryMm.slice(0, 2) }] }],
    ["create_ceilings", { items: [{ ...ceiling, boundaryMm: [{ x: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 }] }] }],
    ["create_ceilings", { items: [{ ...ceiling, typeId: 757 }] }],
    ["create_ceilings", { items: [{ ...ceiling, typeId: undefined }] }],
    ["create_ceilings", { items: [{ ...ceiling, levelId: "" }] }],
    ["create_ceilings", { items: [{ ...ceiling, height: 2350 }] }],
    ["create_floor_openings", {}],
    ["create_floor_openings", { items: [] }],
    ["create_floor_openings", { items: batch(501, opening) }],
    ["create_floor_openings", { items: [{ boundaryMm: opening.boundaryMm }] }],
    ["create_floor_openings", { items: [{ ...opening, floorId: 10 }] }],
    ["create_floor_openings", { items: [{ ...opening, floorId: "" }] }],
    ["create_floor_openings", { items: [{ floorId: "10" }] }],
    ["create_floor_openings", { items: [{ ...opening, boundaryMm: opening.boundaryMm.slice(0, 2) }] }],
    ["create_floor_openings", { items: [{ ...opening, boundaryMm: [{ x: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 }] }] }],
    ["create_floor_openings", { items: [{ ...opening, perpendicular: true }] }],
    ["create_ground", {}],
    ["create_ground", { items: [] }],
    ["create_ground", { items: batch(501, ground) }],
    ["create_ground", { items: [{ boundaryMm: ground.boundaryMm, levelId: "2", typeId: "5" }] }],
    ["create_ground", { items: [{ ...ground, topOffsetMm: "-400" }] }],
    ["create_ground", { items: [{ ...ground, typeId: undefined }] }],
    ["create_ground", { items: [{ ...ground, typeId: 272908 }] }],
    ["create_ground", { items: [{ ...ground, levelId: undefined }] }],
    ["create_ground", { items: [{ ...ground, levelId: "" }] }],
    ["create_ground", { items: [{ ...ground, boundaryMm: ground.boundaryMm.slice(0, 2) }] }],
    ["create_ground", { items: [{ ...ground, elevationMm: 0 }] }],
    ["load_family", {}],
    ["load_family", { items: [] }],
    ["load_family", { items: batch(501, family) }],
    ["load_family", { items: [{}] }],
    ["load_family", { items: [{ typeName: "800 x 2100 мм" }] }],
    ["load_family", { items: [{ path: 5 }] }],
    ["load_family", { items: [{ path: "" }] }],
    ["load_family", { items: [{ ...family, typeName: "" }] }],
    ["load_family", { items: [{ ...family, typeName: 800 }] }],
    ["load_family", { items: [{ ...familyRow, widthMm: 0 }] }],
    ["load_family", { items: [{ ...familyRow, widthMm: -800 }] }],
    ["load_family", { items: [{ ...familyRow, widthMm: "800" }] }],
    ["load_family", { items: [{ ...familyRow, heightMm: 0 }] }],
    ["load_family", { items: [{ ...familyRow, heightMm: null }] }],
    ["load_family", { items: [{ ...family, widthMm: 800 }] }],
    ["load_family", { items: [{ ...family, heightMm: 2100 }] }],
    ["load_family", { items: [{ ...family, name: "Кровать" }] }],
    ["load_family", { items: [{ ...family, family: "Кровать-Стандарт" }] }],
    ["place_instances", {}],
    ["place_instances", { items: [] }],
    ["place_instances", { items: batch(501, instance) }],
    ["place_instances", { items: [{ ...instance, typeId: undefined }] }],
    ["place_instances", { items: [{ ...instance, typeId: 7 }] }],
    ["place_instances", { items: [{ ...instance, typeId: "" }] }],
    ["place_instances", { items: [{ ...instance, pointMm: undefined }] }],
    ["place_instances", { items: [{ ...instance, pointMm: { x: 1 } }] }],
    ["place_instances", { items: [{ ...instance, pointMm: { x: 1, y: 2, z: 3 } }] }],
    ["place_instances", { items: [{ ...instance, pointMm: { x: "1", y: 2 } }] }],
    ["place_instances", { items: [{ ...instance, levelId: undefined }] }],
    ["place_instances", { items: [{ ...instance, levelId: 2 }] }],
    ["place_instances", { items: [{ ...instance, elevationMm: "0" }] }],
    ["place_instances", { items: [{ ...instance, elevationMm: null }] }],
    ["place_instances", { items: [{ ...instance, rotationDeg: "90" }] }],
    ["place_instances", { items: [{ ...instance, hostWallId: 10 }] }],
    ["place_instances", { items: [{ ...instance, hostWallId: "" }] }],
    ["place_instances", { items: [{ ...instance, flipFacing: "true" }] }],
    ["place_instances", { items: [{ ...instance, zMm: 0 }] }],
    ["place_instances", { items: [{ ...instance, hostId: "10" }] }],
    ["place_hosted", {}],
    ["place_hosted", { items: [] }],
    ["place_hosted", { items: batch(501, hosted) }],
    ["place_hosted", { items: [{ ...hosted, typeId: undefined }] }],
    ["place_hosted", { items: [{ ...hosted, typeId: 7 }] }],
    ["place_hosted", { items: [{ ...hosted, typeId: "" }] }],
    ["place_hosted", { items: [{ ...hosted, wallId: undefined }] }],
    ["place_hosted", { items: [{ ...hosted, wallId: 10 }] }],
    ["place_hosted", { items: [{ ...hosted, wallId: "" }] }],
    ["place_hosted", { items: [{ ...hosted, offsetAlongWallMm: undefined }] }],
    ["place_hosted", { items: [{ ...hosted, offsetAlongWallMm: "1500" }] }],
    ["place_hosted", { items: [{ ...hosted, offsetAlongWallMm: null }] }],
    ["place_hosted", { items: [{ ...hosted, sillHeightMm: "900" }] }],
    ["place_hosted", { items: [{ ...hosted, sillHeightMm: null }] }],
    ["place_hosted", { items: [{ ...hosted, flipFacing: "true" }] }],
    ["place_hosted", { items: [{ ...hosted, flipHand: 1 }] }],
    ["place_hosted", { items: [{ ...hosted, hostWallId: "10" }] }],
    ["place_hosted", { items: [{ ...hosted, pointMm: { x: 1, y: 2 } }] }],
    ["place_hosted", { items: [{ ...hosted, levelId: "2" }] }],
    ["attach_walls", {}],
    ["attach_walls", { items: [] }],
    ["attach_walls", { items: batch(501, attachment) }],
    ["attach_walls", { items: [{ wallId: "10" }] }],
    ["attach_walls", { items: [{ roofId: "20" }] }],
    ["attach_walls", { items: [{ wallId: 10, roofId: "20" }] }],
    ["attach_walls", { items: [{ ...attachment, top: true }] }],
    ["delete_elements", {}],
    ["delete_elements", { ids: [] }],
    ["delete_elements", { ids: [123] }],
    ["delete_elements", { ids: [""] }],
    ["delete_elements", { ids: ["1"], dryRun: "false" }],
    ["delete_elements", { ids: Array.from({ length: 1001 }, (_, index) => String(index + 1)) }],
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

  it("passes a roof with no overhang unless told otherwise, with null slopes kept in their places", async (t) => {
    const { bridge, client } = await connect(t, (frame, connection) => connection.result(frame, { committed: true }));

    const result = await client.callTool({ name: "create_roof", arguments: { items: [roof, { ...roof, overhangMm: 600.5 }] } });

    assert.ok(!result.isError);
    assert.equal(bridge.frames[0]?.method, "create_roof");
    assert.deepEqual(bridge.frames[0]?.params, { items: [{ ...roof, overhangMm: 0 }, { ...roof, overhangMm: 600.5 }] });
  });

  it("passes materials with Cyrillic intact, and no transparency unless one is given, 0 included", async (t) => {
    const answer = { committed: true, items: [{ index: 0, status: "already_existed", elementId: "300291", warnings: ["Цвет другой"] }], warnings: [], errors: [], dialogs: [] };
    const { bridge, client } = await connect(t, (frame, connection) => connection.result(frame, answer));

    const result = await client.callTool({
      name: "create_materials",
      arguments: {
        items: [material, { name: "Копия", baseMaterialId: "414" }, { name: "Стекло 2", colorRgb: { r: 0, g: 128, b: 192 }, transparency: 60 }, { name: "Плотное", baseMaterialId: "26", transparency: 0 }],
      },
    });

    assert.ok(!result.isError);
    assert.equal(bridge.frames[0]?.method, "create_materials");
    assert.deepEqual(bridge.frames[0]?.params, {
      items: [
        material,
        { name: "Копия", baseMaterialId: "414" },
        { name: "Стекло 2", colorRgb: { r: 0, g: 128, b: 192 }, transparency: 60 },
        { name: "Плотное", baseMaterialId: "26", transparency: 0 },
      ],
    });
    assert.deepEqual(JSON.parse(textOf(result)), answer);
  });

  it("passes a type with and without layers, with the order of the layers kept", async (t) => {
    const { bridge, client } = await connect(t, (frame, connection) => connection.result(frame, { committed: true }));
    const layers = [
      { thicknessMm: 20, materialId: "5", function: "finish2" },
      layer,
      { thicknessMm: 0, materialId: "9", function: "membrane" },
      { thicknessMm: 30.5, materialId: "6", function: "finish1" },
    ];
    const items = [typeItem, { ...typeItem, category: "roofs", name: "Крыша 300 мм", layers }];

    const result = await client.callTool({ name: "create_type", arguments: { items } });

    assert.ok(!result.isError);
    assert.equal(bridge.frames[0]?.method, "create_type");
    assert.deepEqual(bridge.frames[0]?.params, { items });
  });

  it("takes every category and every layer function that create_type names", async (t) => {
    const { bridge, client } = await connect(t, (frame, connection) => connection.result(frame, { committed: true }));
    const items = ["walls", "floors", "ceilings", "roofs"].map((category) => ({
      ...typeItem,
      category,
      layers: ["structure", "substrate", "insulation", "finish1", "finish2", "membrane"].map((fn) => ({ thicknessMm: fn === "membrane" ? 0 : 10, materialId: "7", function: fn })),
    }));

    const result = await client.callTool({ name: "create_type", arguments: { items } });

    assert.ok(!result.isError);
    assert.deepEqual(bridge.frames[0]?.params, { items });
  });

  it("takes 500 items in create_materials and create_type, the most they allow", async (t) => {
    const { bridge, client } = await connect(t, (frame, connection) => connection.result(frame, { committed: true }));

    assert.ok(!(await client.callTool({ name: "create_materials", arguments: { items: batch(500, material) } })).isError);
    assert.ok(!(await client.callTool({ name: "create_type", arguments: { items: batch(500, typeItem) } })).isError);
    assert.equal((bridge.frames[0]?.params["items"] as unknown[]).length, 500);
    assert.equal((bridge.frames[1]?.params["items"] as unknown[]).length, 500);
  });

  it("tells the model the truth about create_materials", async (t) => {
    const { client } = await connect(t, () => {});

    const { tools: listed } = await client.listTools();
    const description = listed.find((tool) => tool.name === "create_materials")?.description ?? "";

    assert.match(description, /one Undo step/);
    assert.match(description, /500/);
    for (const word of ["created", "failed", "rolled_back", "not attempted", "actual", "already_existed"]) {
      assert.ok(description.includes(word), `should explain ${word}`);
    }
    assert.match(description, /Realistic/);
    assert.match(description, /Shading/);
    assert.match(description, /so the base material does not change/);
    assert.match(description, /such as brick or wood has none, and a call that asks for a colour .* is refused before anything changes/);
    assert.match(description, /whole number from 0 to 255/);
    assert.match(description, /0, opaque, to 100/);
    assert.match(description, /Left out, it is 0 for a new material, and a copy keeps the transparency of its base/);
    assert.match(description, /refuses any value, 0 too, before anything changes/);
    assert.match(description, /appearanceTransparency is null/);
    assert.match(description, /A colour or a transparency you left out is not compared/);
    assert.match(description, /appearanceColorRgb is null/);
    assert.match(description, /left as it is/);
    assert.match(description, /create_type/);
  });

  it("tells the model the truth about create_type", async (t) => {
    const { client } = await connect(t, () => {});

    const { tools: listed } = await client.listTools();
    const description = listed.find((tool) => tool.name === "create_type")?.description ?? "";

    assert.match(description, /one Undo step/);
    assert.match(description, /millimetres/);
    assert.match(description, /500/);
    for (const word of ["created", "failed", "rolled_back", "not attempted", "actual", "already_existed"]) {
      assert.ok(description.includes(word), `should explain ${word}`);
    }
    for (const fn of ["structure", "substrate", "insulation", "finish1", "finish2", "membrane"]) {
      assert.ok(description.includes(fn), `should name the function ${fn}`);
    }
    assert.match(description, /from the outside in for a wall and from the top down for a floor, ceiling or roof/);
    assert.match(description, /membrane layer has no thickness/);
    assert.match(description, /curtain wall or a glazed roof, cannot be given layers/);
    assert.match(description, /widthMm is the total thickness/);
    assert.match(description, /left as it is/);
    assert.match(description, /same family as the base type/);
    assert.match(description, /create_walls/);
  });

  it("passes ceilings with every height given, a height of 0 and a negative one included, and adds none", async (t) => {
    const answer = { committed: true, items: [{ index: 0, status: "created", elementId: "300301" }], warnings: [], errors: [], dialogs: [] };
    const { bridge, client } = await connect(t, (frame, connection) => connection.result(frame, answer));
    const items = [ceiling, { ...ceiling, heightOffsetMm: 0 }, { ...ceiling, heightOffsetMm: -300.5 }];

    const result = await client.callTool({ name: "create_ceilings", arguments: { items } });

    assert.ok(!result.isError);
    assert.equal(bridge.frames[0]?.method, "create_ceilings");
    assert.deepEqual(bridge.frames[0]?.params, { items });
    assert.deepEqual(JSON.parse(textOf(result)), answer);
  });

  it("passes floor openings, two for one floor in one list, with their order kept", async (t) => {
    const answer = { committed: false, items: [{ index: 1, status: "failed", error: "Причина" }], warnings: [], errors: ["Причина"], dialogs: [] };
    const { bridge, client } = await connect(t, (frame, connection) => connection.result(frame, answer));
    const items = [opening, { ...opening, boundaryMm: [{ x: 7000, y: 1000 }, { x: 8000, y: 1000 }, { x: 8000, y: 2000 }] }];

    const result = await client.callTool({ name: "create_floor_openings", arguments: { items } });

    assert.ok(!result.isError);
    assert.equal(bridge.frames[0]?.method, "create_floor_openings");
    assert.deepEqual(bridge.frames[0]?.params, { items });
    assert.deepEqual(JSON.parse(textOf(result)), answer);
  });

  it("passes ground with its top above, at and below the level, and adds no height", async (t) => {
    const { bridge, client } = await connect(t, (frame, connection) => connection.result(frame, { committed: true, warnings: ["Highlighted toposolid and floor overlap."] }));
    const items = [ground, { ...ground, topOffsetMm: 0 }, { ...ground, topOffsetMm: 150.5 }];

    const result = await client.callTool({ name: "create_ground", arguments: { items } });

    assert.ok(!result.isError);
    assert.equal(bridge.frames[0]?.method, "create_ground");
    assert.deepEqual(bridge.frames[0]?.params, { items });
    assert.match(textOf(result), /toposolid and floor overlap/);
  });

  it("passes families with a Cyrillic path and type name intact, and no size unless one is given", async (t) => {
    const answer = { committed: true, items: [{ index: 0, status: "created", elementId: "300301" }], warnings: [], errors: [], dialogs: [] };
    const { bridge, client } = await connect(t, (frame, connection) => connection.result(frame, answer));
    const items = [
      family,
      familyRow,
      { path: "Russia\\Окна\\Для России\\ГОСТ 30674-99\\Окно 1-Распашное - Один. переплет с несколькими оконными стеклами - ГОСТ 30674-99.rfa", typeName: "ОП Д2 400-450 ГОСТ 30674-99" },
      { ...familyRow, widthMm: 600.5 },
    ];

    const result = await client.callTool({ name: "load_family", arguments: { items } });

    assert.ok(!result.isError);
    assert.equal(bridge.frames[0]?.method, "load_family");
    assert.deepEqual(bridge.frames[0]?.params, { items });
    assert.deepEqual(JSON.parse(textOf(result)), answer);
  });

  it("passes instances with the defaults filled in, a host and a flip kept, and a negative elevation and angle", async (t) => {
    const { bridge, client } = await connect(t, (frame, connection) => connection.result(frame, { committed: true }));
    const hung = { ...instance, hostWallId: "10", flipFacing: true };

    const result = await client.callTool({
      name: "place_instances",
      arguments: { items: [instance, hung, { ...instance, elevationMm: -150.5, rotationDeg: -90.5 }, { ...instance, rotationDeg: 720 }] },
    });

    assert.ok(!result.isError);
    assert.equal(bridge.frames[0]?.method, "place_instances");
    assert.deepEqual(bridge.frames[0]?.params, {
      items: [
        { ...instance, elevationMm: 0, rotationDeg: 0, flipFacing: false },
        { ...hung, elevationMm: 0, rotationDeg: 0 },
        { ...instance, elevationMm: -150.5, rotationDeg: -90.5, flipFacing: false },
        { ...instance, elevationMm: 0, rotationDeg: 720, flipFacing: false },
      ],
    });
  });

  it("passes openings with the flips defaulted, the sill left out for a door, and a negative sill and offset kept", async (t) => {
    const { bridge, client } = await connect(t, (frame, connection) => connection.result(frame, { committed: true }));
    const door = { typeId: "7", wallId: "10", offsetAlongWallMm: 1500.5 };

    const result = await client.callTool({
      name: "place_hosted",
      arguments: { items: [hosted, door, { ...hosted, flipFacing: true, flipHand: true }, { ...hosted, offsetAlongWallMm: -10, sillHeightMm: -400.5 }] },
    });

    assert.ok(!result.isError);
    assert.equal(bridge.frames[0]?.method, "place_hosted");
    assert.deepEqual(bridge.frames[0]?.params, {
      items: [
        { ...hosted, flipFacing: false, flipHand: false },
        { ...door, flipFacing: false, flipHand: false },
        { ...hosted, flipFacing: true, flipHand: true },
        { ...hosted, offsetAlongWallMm: -10, sillHeightMm: -400.5, flipFacing: false, flipHand: false },
      ],
    });
  });

  it("tells the model the truth about place_hosted", async (t) => {
    const { client } = await connect(t, () => {});

    const { tools: listed } = await client.listTools();
    const description = listed.find((tool) => tool.name === "place_hosted")?.description ?? "";

    assert.match(description, /one Undo step/);
    assert.match(description, /millimetres/);
    assert.match(description, /500/);
    for (const word of ["created", "failed", "rolled_back", "not attempted", "actual"]) {
      assert.ok(description.includes(word), `should explain ${word}`);
    }
    assert.match(description, /from its START to the CENTRE of the opening/);
    assert.match(description, /BASE LEVEL of the wall/);
    assert.match(description, /not its foot/);
    assert.match(description, /A door takes 0/);
    assert.match(description, /a window without it is refused/);
    assert.match(description, /Openings may touch but not overlap/);
    assert.match(description, /a window above a door does not overlap/);
    assert.match(description, /LEFT of the direction of the wall/);
    assert.match(description, /curtain wall/);
    assert.match(description, /fixed window cannot flip its hand/);
    assert.match(description, /fails its item after the instance is made/);
    assert.doesNotMatch(description, /flipHand is refused before anything changes/, "a flip that cannot be done is known only for an instance");
    assert.match(description, /where the opening stands/);
    assert.match(description, /the lowest of the three counts/);
    assert.match(description, /topMm in get_elements, is no limit for a window/);
    assert.match(description, /attach_walls/);
    assert.match(description, /Rough Width and Rough Height/);
    assert.match(description, /load_family refuses widthMm and heightMm for it/);
    assert.match(description, /cutsWall/);
    assert.match(description, /fromRoomId and toRoomId/);
    assert.match(description, /first instance of a type does not otherwise cut its wall/);
    assert.match(description, /list_types with doors or windows/);
    assert.match(description, /place_instances/);
    assert.match(description, /load_family/);
  });

  it("tells the model the truth about load_family", async (t) => {
    const { client } = await connect(t, () => {});

    const { tools: listed } = await client.listTools();
    const description = listed.find((tool) => tool.name === "load_family")?.description ?? "";

    assert.match(description, /one Undo step/);
    assert.match(description, /millimetres/);
    assert.match(description, /500/);
    for (const word of ["created", "failed", "rolled_back", "not attempted", "actual", "already_existed"]) {
      assert.ok(description.includes(word), `should explain ${word}`);
    }
    assert.match(description, /Libraries\\Russian/);
    assert.match(description, /nothing outside the folder is reachable/);
    assert.match(description, /Revit ignores them here/);
    assert.match(description, /850 x 2000/);
    assert.match(description, /This tool does not read the catalog/);
    assert.match(description, /They need typeName/);
    assert.match(description, /GOST/);
    assert.match(description, /nothing stays loaded/);
    assert.match(description, /moves nothing else in the type/);
    assert.match(description, /place_hosted reads its rough size/);
    assert.match(description, /reset the sizes/);
    assert.match(description, /A match is by the name of the family and not by its file/);
    assert.match(description, /cannot tell which file the family in the project came from/);
    assert.match(description, /only from the file that family came from/);
    assert.match(description, /typeIds/);
    assert.match(description, /place_instances/);
  });

  it("tells the model the truth about place_instances", async (t) => {
    const { client } = await connect(t, () => {});

    const { tools: listed } = await client.listTools();
    const description = listed.find((tool) => tool.name === "place_instances")?.description ?? "";

    assert.match(description, /one Undo step/);
    assert.match(description, /millimetres/);
    assert.match(description, /500/);
    for (const word of ["created", "failed", "rolled_back", "not attempted", "actual"]) {
      assert.ok(description.includes(word), `should explain ${word}`);
    }
    assert.match(description, /needs hostWallId/);
    assert.match(description, /refused before anything changes/);
    assert.match(description, /wrong place with no geometry/);
    assert.match(description, /axis of the wall/);
    assert.match(description, /flipFacing/);
    assert.match(description, /placement type/);
    assert.match(description, /compared with the request/);
    assert.match(description, /recessed ceiling light/);
    assert.match(description, /some other host than that wall fails its item/);
    assert.match(description, /A door or window type is refused as well/);
    assert.match(description, /use place_hosted/);
    assert.match(description, /load_family/);
  });

  it("tells the model the truth about create_ceilings", async (t) => {
    const { client } = await connect(t, () => {});

    const { tools: listed } = await client.listTools();
    const description = listed.find((tool) => tool.name === "create_ceilings")?.description ?? "";

    assert.match(description, /one Undo step/);
    assert.match(description, /millimetres/);
    assert.match(description, /500/);
    for (const word of ["created", "failed", "rolled_back", "not attempted", "actual"]) {
      assert.ok(description.includes(word), `should explain ${word}`);
    }
    assert.match(description, /heightOffsetMm is required, and there is no default/);
    assert.match(description, /2600/);
    assert.match(description, /underside/);
    assert.match(description, /list_types with ceilings/);
    assert.doesNotMatch(description, /height of the outline/, "the outline has no height to give");
  });

  it("tells the model the truth about create_floor_openings", async (t) => {
    const { client } = await connect(t, () => {});

    const { tools: listed } = await client.listTools();
    const description = listed.find((tool) => tool.name === "create_floor_openings")?.description ?? "";

    assert.match(description, /one Undo step/);
    assert.match(description, /millimetres/);
    assert.match(description, /500/);
    for (const word of ["created", "failed", "rolled_back", "not attempted", "actual"]) {
      assert.ok(description.includes(word), `should explain ${word}`);
    }
    assert.match(description, /reach across the edge of the floor/);
    assert.match(description, /takes no area off the floor fails its item/);
    assert.match(description, /same floor may appear in several items/);
    assert.match(description, /floorAreaAfterCallM2/);
    assert.match(description, /covers the whole floor lands as created and leaves the floor with an area of 0/);
    assert.match(description, /Revit adds the warning Opening not cutting anything for it, which is wrong there/);
    assert.match(description, /encloses stays in the model with the status created/);
  });

  it("tells the model the truth about create_ground", async (t) => {
    const { client } = await connect(t, () => {});

    const { tools: listed } = await client.listTools();
    const description = listed.find((tool) => tool.name === "create_ground")?.description ?? "";

    assert.match(description, /one Undo step/);
    assert.match(description, /millimetres/);
    assert.match(description, /500/);
    for (const word of ["created", "failed", "rolled_back", "not attempted", "actual"]) {
      assert.ok(description.includes(word), `should explain ${word}`);
    }
    assert.match(description, /topOffsetMm is required/);
    assert.match(description, /list_types with toposolid/);
    assert.match(description, /below the underside of every floor it reaches/);
    assert.match(description, /toposolid and floor overlap/);
    assert.match(description, /does not refuse that and does not hide it/);
    assert.doesNotMatch(description, /height of the outline/, "the outline has no height to give");
  });

  it("passes attachments unchanged and returns the honest result", async (t) => {
    const answer = { committed: true, items: [{ index: 0, status: "already_existed", elementId: "10" }], warnings: [], errors: [], dialogs: [] };
    const { bridge, client } = await connect(t, (frame, connection) => connection.result(frame, answer));

    const result = await client.callTool({ name: "attach_walls", arguments: { items: [attachment] } });

    assert.ok(!result.isError);
    assert.equal(bridge.frames[0]?.method, "attach_walls");
    assert.deepEqual(bridge.frames[0]?.params, { items: [attachment] });
    assert.deepEqual(JSON.parse(textOf(result)), answer);
  });

  it("asks delete_elements for a dry run unless told otherwise", async (t) => {
    const answer = { dryRun: true, committed: false, allAffected: ["1", "2"], dependents: ["2"], errors: [] };
    const { bridge, client } = await connect(t, (frame, connection) => connection.result(frame, answer));

    const result = await client.callTool({ name: "delete_elements", arguments: { ids: ["1"] } });

    assert.ok(!result.isError);
    assert.equal(bridge.frames[0]?.method, "delete_elements");
    assert.deepEqual(bridge.frames[0]?.params, { ids: ["1"], dryRun: true });
    assert.deepEqual(JSON.parse(textOf(result)), answer);
  });

  it("passes dryRun false only when asked, and 1000 ids, the most it allows", async (t) => {
    const { bridge, client } = await connect(t, (frame, connection) => connection.result(frame, { committed: true }));
    const ids = Array.from({ length: 1000 }, (_, index) => String(index + 1));

    const result = await client.callTool({ name: "delete_elements", arguments: { ids, dryRun: false } });

    assert.ok(!result.isError);
    assert.deepEqual(bridge.frames[0]?.params, { ids, dryRun: false });
  });

  it("tells the model the truth about delete_elements", async (t) => {
    const { client } = await connect(t, () => {});

    const { tools: listed } = await client.listTools();
    const description = listed.find((tool) => tool.name === "delete_elements")?.description ?? "";

    assert.match(description, /dryRun is true unless you pass false/);
    assert.match(description, /deletes nothing/);
    assert.match(description, /A level takes the walls, floors and views on it/);
    assert.match(description, /In a dry run committed is always false, which is no failure/);
    assert.match(description, /committed false means nothing was deleted/);
    assert.match(description, /each id can pass and the list still be refused/);
  });

  it("tells the model the truth about undo_last_operation", async (t) => {
    const { client } = await connect(t, () => {});

    const { tools: listed } = await client.listTools();
    const description = listed.find((tool) => tool.name === "undo_last_operation")?.description ?? "";

    assert.match(description, /every id you still hold from it is invalid/);
    assert.match(description, /undo_refused/);
    assert.match(description, /only the user can undo their own change, and it costs them that change/);
    assert.match(description, /so ask them only when the refusal says an operation of these tools lies below it/);
    assert.match(description, /asking the user to undo does not help/);
    assert.match(description, /undid something else instead of what was asked/);
    assert.match(description, /open_project/);
    assert.match(description, /get_last_undo_result/);
    assert.match(description, /There is no redo tool/);
  });

  it("tells the model the truth about get_last_undo_result", async (t) => {
    const { client } = await connect(t, () => {});

    const { tools: listed } = await client.listTools();
    const description = listed.find((tool) => tool.name === "get_last_undo_result")?.description ?? "";

    assert.match(description, /An empty createdIds does not prove that nothing was created/);
    for (const state of ["undone", "not_confirmed", "other", "unknown", "none"]) {
      assert.ok(description.includes(state), `should explain ${state}`);
    }
    assert.match(description, /otherName and otherDocumentTitle say what/);
    assert.match(description, /probably still in the model/);
    assert.match(description, /read the model first/);
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

    for (const name of ["create_levels", "create_walls", "create_floors", "create_roof", "attach_walls"]) {
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

  it("tells the model the truth about roof edges and overhangs", async (t) => {
    const { client } = await connect(t, () => {});

    const { tools: listed } = await client.listTools();
    const description = listed.find((tool) => tool.name === "create_roof")?.description ?? "";

    assert.match(description, /Edge 0 runs from point 0 to point 1/);
    assert.match(description, /a slope stays on the edge it is listed for/);
    assert.match(description, /\[30, 30, 30, 30\]/);
    assert.match(description, /\[30, null, 30, null\]/);
    assert.match(description, /the outline is the eaves/);
    assert.match(description, /eave ends below the level/);
    assert.match(description, /attach_walls/);
  });

  it("tells the model what the statuses of attach_walls mean", async (t) => {
    const { client } = await connect(t, () => {});

    const { tools: listed } = await client.listTools();
    const description = listed.find((tool) => tool.name === "attach_walls")?.description ?? "";

    assert.match(description, /created means a new attachment/);
    assert.match(description, /already_existed means that wall was attached to that roof before/);
    assert.match(description, /misses the target/);
    assert.match(description, /elementId is the id of the wall/);
  });

  it("passes the ids of get_elements as strings", async (t) => {
    const { bridge, client } = await connect(t, (frame, connection) => connection.result(frame, { elements: [], notFound: ["1"] }));

    const result = await client.callTool({ name: "get_elements", arguments: { ids: ["1", "9007199254740993"] } });

    assert.ok(!result.isError);
    assert.deepEqual(bridge.frames[0]?.params, { ids: ["1", "9007199254740993"] });
  });

  it("passes a category and a level of get_elements, and returns the answer unchanged", async (t) => {
    const answer = { elements: [{ id: "10", category: "walls", typeName: "Тип", levelId: "5", boundingBoxMm: null }], notFound: [], truncated: true };
    const { bridge, client } = await connect(t, (frame, connection) => connection.result(frame, answer));

    const withLevel = await client.callTool({ name: "get_elements", arguments: { category: "walls", levelId: "5" } });
    const withoutLevel = await client.callTool({ name: "get_elements", arguments: { category: "doors" } });

    assert.ok(!withLevel.isError && !withoutLevel.isError);
    assert.deepEqual(bridge.frames[0]?.params, { category: "walls", levelId: "5" });
    assert.deepEqual(bridge.frames[1]?.params, { category: "doors" });
    assert.deepEqual(JSON.parse(textOf(withLevel)), answer);
  });

  it("offers get_elements every category word of list_types except view_templates", async (t) => {
    const { client } = await connect(t, () => {});

    const { tools: listed } = await client.listTools();
    const words = (name: string): string[] => {
      const properties = listed.find((tool) => tool.name === name)?.inputSchema.properties as Record<string, { enum: string[] }> | undefined;
      return properties?.["category"]?.enum ?? [];
    };

    assert.ok(words("get_elements").length > 0);
    assert.deepEqual(words("list_types"), [...words("get_elements"), "view_templates"]);
  });

  it("tells the model the truth about get_elements by category", async (t) => {
    const { client } = await connect(t, () => {});

    const { tools: listed } = await client.listTools();
    const description = listed.find((tool) => tool.name === "get_elements")?.description ?? "";

    assert.match(description, /exactly one of ids and category/);
    assert.match(description, /at most 1000, and truncated is true when more matched/);
    assert.match(description, /only with category/);
    assert.match(description, /notFound is always empty with category/);
  });

  it("forwards list_materials and get_warnings with no arguments, and returns Cyrillic intact", async (t) => {
    const materials = [{ id: "7", name: "Кирпич", materialClass: "Кладка", color: { r: 1, g: 2, b: 3 }, transparency: 0 }];
    const warnings = [{ definitionId: "9f4a1c6e-0000-4000-8000-000000000001", text: "Стены перекрываются.", elementIds: ["1", "2"], additionalElementIds: [] }];
    const { bridge, client } = await connect(t, (frame, connection) => connection.result(frame, frame.method === "list_materials" ? materials : warnings));

    const first = await client.callTool({ name: "list_materials", arguments: {} });
    const second = await client.callTool({ name: "get_warnings", arguments: {} });

    assert.ok(!first.isError && !second.isError);
    assert.deepEqual(bridge.frames.map((frame) => [frame.method, frame.params]), [["list_materials", {}], ["get_warnings", {}]]);
    assert.deepEqual(JSON.parse(textOf(first)), materials);
    assert.deepEqual(JSON.parse(textOf(second)), warnings);
  });

  it("tells the model the truth about get_warnings", async (t) => {
    const { client } = await connect(t, () => {});

    const { tools: listed } = await client.listTools();
    const description = listed.find((tool) => tool.name === "get_warnings")?.description ?? "";

    assert.match(description, /match on it and not on text/);
    assert.match(description, /does not change with the language of Revit/);
    assert.match(description, /An empty list means that Revit holds no warning/);
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
