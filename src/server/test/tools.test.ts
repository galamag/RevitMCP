import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TestContext } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { BridgeClient } from "../src/client.ts";
import { tools } from "../src/registry.ts";
import type { ToolDefinition } from "../src/registry.ts";
import { createServer } from "../src/server.ts";
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

describe("MCP tools", { timeout: 20_000 }, () => {
  it("lists the four stage-1 tools with descriptions", async (t) => {
    const { client } = await connect(t, () => {});

    const { tools } = await client.listTools();

    assert.deepEqual(
      tools.map((tool) => tool.name).sort(),
      ["cancel_request", "get_model_info", "get_request_status", "get_status"],
    );
    for (const tool of tools) {
      assert.ok(tool.description && tool.description.length > 0);
    }
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
