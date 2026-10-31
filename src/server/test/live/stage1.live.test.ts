import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import net from "node:net";
import { describe, it } from "node:test";

import { BridgeClient, PROTOCOL_VERSION } from "../../src/client.ts";
import { defaultConnectionPath, readConnectionInfo } from "../../src/connection.ts";
import { RpcCodes } from "../../src/errors.ts";
import { FrameDecoder, encodeFrame } from "../../src/framing.ts";

// These tests need a running Revit with the RevitMCP plugin loaded. They read nothing but never change the model.
// A project does not have to be open.
// Not covered here, because they need an open project (task 9): Cyrillic names, a modal dialog, edit mode.

const BURST = 40;

function newClient(): BridgeClient {
  return new BridgeClient(defaultConnectionPath());
}

/** Sends one raw frame on a fresh socket and returns the first answer. The token comes from connection.json and is never printed. */
async function rawCall(frame: Record<string, unknown>): Promise<Record<string, unknown>> {
  const info = await readConnectionInfo(defaultConnectionPath());
  const socket = net.connect({ host: "127.0.0.1", port: info.port });
  const decoder = new FrameDecoder();

  try {
    return await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("No answer within 5 s.")), 5000);
      socket.on("error", reject);
      socket.on("close", () => reject(new Error("The plugin closed the connection without an answer.")));
      socket.on("data", (chunk) => {
        const [message] = decoder.push(chunk);
        if (message !== undefined) {
          clearTimeout(timer);
          resolve(message as Record<string, unknown>);
        }
      });
      socket.write(encodeFrame(frame));
    });
  } finally {
    socket.destroy();
  }
}

describe("stage 1 live checks", { timeout: 120_000 }, () => {
  it("reports active document", async () => {
    const client = newClient();
    try {
      const info = (await client.call("get_model_info", {})) as Record<string, unknown>;

      const active = info["activeDocument"];
      assert.ok(active === null || (typeof active === "object" && !Array.isArray(active)), "activeDocument must be null or an object");
      assert.ok(Array.isArray(info["openDocuments"]), "openDocuments must be an array");

      if (active !== null) {
        const document = active as Record<string, unknown>;
        assert.equal(typeof document["title"], "string");
        assert.equal(typeof document["path"], "string");
        assert.equal(typeof document["isModified"], "boolean");
      }
      // The active project is named in the test report, not asserted.
      console.log(`# activeDocument: ${active === null ? "none" : JSON.stringify((active as Record<string, unknown>)["title"])}`);
    } finally {
      client.close();
    }
  });

  it("rejects a call without a valid token", async () => {
    const info = await readConnectionInfo(defaultConnectionPath());
    const request = { jsonrpc: "2.0", method: "get_status", params: {}, protocolVersion: PROTOCOL_VERSION };

    const wrong = await rawCall({ ...request, id: randomUUID(), token: `${info.token}x` });
    assert.equal((wrong["error"] as { code?: number } | undefined)?.code, RpcCodes.unauthorized);
    assert.equal(wrong["result"], undefined);

    const missing = await rawCall({ ...request, id: randomUUID() });
    assert.equal((missing["error"] as { code?: number } | undefined)?.code, RpcCodes.unauthorized);
    assert.equal(missing["result"], undefined);
  });

  it("burst of concurrent calls all succeed", async () => {
    const client = newClient();
    try {
      const answers = await Promise.all(Array.from({ length: BURST }, () => client.call("get_model_info", {})));

      assert.equal(answers.length, BURST);
      for (const answer of answers) {
        assert.ok(Array.isArray((answer as Record<string, unknown>)["openDocuments"]));
      }
    } finally {
      client.close();
    }
  });

  it("get_status stays responsive during a burst", async () => {
    const burstClient = newClient();
    const statusClient = newClient();
    try {
      // Warm the status connection so the measurement is about the answer, not the connect.
      await statusClient.call("get_status", {});

      const burst = Promise.all(Array.from({ length: BURST }, () => burstClient.call("get_model_info", {})));

      const latencies: number[] = [];
      for (let i = 0; i < 10; i++) {
        const started = performance.now();
        const status = (await statusClient.call("get_status", {}, { timeoutMs: 10_000 })) as Record<string, unknown>;
        latencies.push(performance.now() - started);
        assert.equal(typeof status["queueLength"], "number");
        assert.equal(typeof status["oldestQueuedSeconds"], "number");
      }

      await burst;
      console.log(`# get_status latency during burst, ms: ${latencies.map((ms) => ms.toFixed(0)).join(", ")}`);
      assert.ok(Math.max(...latencies) < 2000, `get_status took ${Math.max(...latencies).toFixed(0)} ms during the burst`);
    } finally {
      burstClient.close();
      statusClient.close();
    }
  });

  it("unknown request reports unknown", async () => {
    const client = newClient();
    try {
      const requestId = randomUUID();
      const status = (await client.call("get_request_status", { requestId })) as Record<string, unknown>;

      assert.equal(status["state"], "unknown");
      assert.equal(status["requestId"], requestId);
    } finally {
      client.close();
    }
  });
});
