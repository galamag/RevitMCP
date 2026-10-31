import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { TestContext } from "node:test";

import { BridgeClient } from "../src/client.ts";
import type { BridgeClientOptions } from "../src/client.ts";
import { BridgeRequestPendingError, BridgeRpcError, RevitNotRunningError } from "../src/errors.ts";
import { MAX_FRAME_BYTES } from "../src/framing.ts";
import { FakeBridge, unusedPort } from "./fakeBridge.ts";
import type { FrameHandler, ReceivedFrame } from "./fakeBridge.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Answers every request with `{ ok: true, method }`. */
const echo: FrameHandler = (frame, connection) => connection.result(frame, { ok: true, method: frame.method });

async function startBridge(t: TestContext, handler: FrameHandler = echo): Promise<FakeBridge> {
  const bridge = new FakeBridge(handler);
  t.after(() => bridge.close());
  await bridge.start();
  return bridge;
}

function makeClient(t: TestContext, connectionPath: string, options: BridgeClientOptions = {}): BridgeClient {
  const client = new BridgeClient(connectionPath, { connectRetryDelayMs: 10, ...options });
  t.after(() => client.close());
  return client;
}

async function tempFolder(t: TestContext): Promise<string> {
  const folder = await mkdtemp(path.join(tmpdir(), "revitmcp-client-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  return folder;
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function header(length: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(length);
  return buffer;
}

describe("BridgeClient", { timeout: 20_000 }, () => {
  describe("finding Revit", () => {
    it("throws RevitNotRunningError when connection file is missing", async (t) => {
      const folder = await tempFolder(t);
      const client = makeClient(t, path.join(folder, "connection.json"));

      await assert.rejects(client.call("get_status", {}), (error: unknown) => {
        assert.ok(error instanceof RevitNotRunningError);
        assert.match(error.message, /start Revit/i);
        return true;
      });
    });

    it("throws RevitNotRunningError when pid is dead", async (t) => {
      const bridge = await startBridge(t);
      const dead = spawnSync(process.execPath, ["-e", ""]);
      assert.ok(dead.pid);
      await bridge.writeConnectionFile({ pid: dead.pid });
      const client = makeClient(t, bridge.connectionPath);

      await assert.rejects(client.call("get_status", {}), (error: unknown) => {
        assert.ok(error instanceof RevitNotRunningError);
        assert.match(error.message, /start Revit/i);
        assert.match(error.message, new RegExp(String(dead.pid)));
        return true;
      });
      assert.equal(bridge.connections.length, 0, "must not connect to a dead Revit");
    });

    it("throws RevitNotRunningError when the connection file is malformed, without echoing it", async (t) => {
      const folder = await tempFolder(t);
      const file = path.join(folder, "connection.json");
      await writeFile(file, '{"port":"x","token":"leaky-token-value","pid":1}');
      const client = makeClient(t, file);

      await assert.rejects(client.call("get_status", {}), (error: unknown) => {
        assert.ok(error instanceof RevitNotRunningError);
        assert.doesNotMatch(error.message, /leaky-token-value/);
        return true;
      });
    });

    it("connects lazily, on the first call", async (t) => {
      const bridge = await startBridge(t);
      const client = makeClient(t, bridge.connectionPath);
      await pause(50);

      assert.equal(bridge.connections.length, 0);
      await client.call("get_status", {});
      assert.equal(bridge.connections.length, 1);
    });

    it("reuses one connection for later calls", async (t) => {
      const bridge = await startBridge(t);
      const client = makeClient(t, bridge.connectionPath);

      await client.call("get_status", {});
      await client.call("get_status", {});
      await Promise.all([client.call("get_status", {}), client.call("get_status", {})]);

      assert.equal(bridge.connections.length, 1);
      assert.equal(bridge.frames.length, 4);
    });

    it("reads connection.json fresh on every connect", async (t) => {
      const bridge = await startBridge(t);
      const client = makeClient(t, bridge.connectionPath);
      await client.call("get_status", {});
      const firstPort = bridge.port;

      // Revit restarted: new port, new token. The old socket dies with the old Revit.
      await bridge.stopListening();
      bridge.token = "token-of-the-second-revit";
      await bridge.start();
      assert.notEqual(bridge.port, firstPort);

      await client.call("get_status", {});

      assert.equal(bridge.frames.at(-1)?.token, "token-of-the-second-revit");
    });
  });

  describe("request frame", () => {
    it("sends jsonrpc, id, method, params, token and protocol version", async (t) => {
      const bridge = await startBridge(t);
      const client = makeClient(t, bridge.connectionPath);

      const result = await client.call("get_request_status", { requestId: "abc" });

      assert.deepEqual(result, { ok: true, method: "get_request_status" });
      const frame = bridge.frames[0];
      assert.ok(frame);
      assert.equal(frame.jsonrpc, "2.0");
      assert.equal(frame.method, "get_request_status");
      assert.deepEqual(frame.params, { requestId: "abc" });
      assert.equal(frame.token, bridge.token);
      assert.equal(frame.protocolVersion, 1);
      assert.match(frame.id, UUID);
    });

    it("new requestId for every call", async (t) => {
      const bridge = await startBridge(t);
      const client = makeClient(t, bridge.connectionPath);

      await client.call("get_status", {});
      await client.call("get_status", {});
      await client.call("get_model_info", {});

      const ids = bridge.frames.map((frame) => frame.id);
      assert.equal(new Set(ids).size, 3);
    });

    it("keeps Cyrillic intact both ways", async (t) => {
      const bridge = await startBridge(t, (frame, connection) =>
        connection.result(frame, { echoed: frame.params["name"] }),
      );
      const client = makeClient(t, bridge.connectionPath);

      const result = await client.call("get_model_info", { name: "Стена — наружная 🏠" });

      assert.deepEqual(result, { echoed: "Стена — наружная 🏠" });
    });

    it("matches out-of-order responses to their callers", async (t) => {
      const waiting: ReceivedFrame[] = [];
      const bridge = await startBridge(t, (frame, connection) => {
        waiting.push(frame);
        if (waiting.length === 2) {
          for (const pending of waiting.reverse()) {
            connection.result(pending, { answered: pending.params["n"] });
          }
        }
      });
      const client = makeClient(t, bridge.connectionPath);

      const [first, second] = await Promise.all([
        client.call("get_model_info", { n: 1 }),
        client.call("get_model_info", { n: 2 }),
      ]);

      assert.deepEqual(first, { answered: 1 });
      assert.deepEqual(second, { answered: 2 });
    });

    it("reassembles a response that arrives in pieces", async (t) => {
      const bridge = await startBridge(t, (frame, connection) => {
        const payload = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { text: "Привет" } }));
        const frameBytes = Buffer.concat([header(payload.length), payload]);
        const cut = 7;
        connection.socket.write(frameBytes.subarray(0, cut));
        setTimeout(() => connection.socket.write(frameBytes.subarray(cut)), 20);
      });
      const client = makeClient(t, bridge.connectionPath);

      assert.deepEqual(await client.call("get_status", {}), { text: "Привет" });
    });
  });

  describe("connection loss", () => {
    it("rejects pending calls immediately when socket closes", async (t) => {
      const received: ReceivedFrame[] = [];
      const bridge = await startBridge(t, (frame, connection) => {
        received.push(frame);
        if (received.length === 2) {
          connection.drop();
        }
      });
      const client = makeClient(t, bridge.connectionPath);

      const started = Date.now();
      const calls = [
        client.call("get_model_info", {}, { timeoutMs: 30_000 }),
        client.call("get_model_info", {}, { timeoutMs: 30_000 }),
      ];
      const outcomes = await Promise.allSettled(calls);

      assert.ok(Date.now() - started < 5_000, "must not wait for the timeout");
      for (const [index, outcome] of outcomes.entries()) {
        assert.equal(outcome.status, "rejected");
        const error = (outcome as PromiseRejectedResult).reason;
        assert.ok(error instanceof BridgeRequestPendingError);
        assert.equal(error.requestId, received[index]?.id);
        assert.equal(error.state, "unknown");
        assert.match(error.message, /get_request_status/);
        assert.ok(error.message.includes(error.requestId));
      }
    });

    it("close() rejects calls that are still waiting", async (t) => {
      const bridge = await startBridge(t, () => {});
      const client = makeClient(t, bridge.connectionPath);

      const call = client.call("get_model_info", {}, { timeoutMs: 30_000 });
      while (bridge.frames.length === 0) {
        await pause(5);
      }
      client.close();

      await assert.rejects(call, (error: unknown) => {
        assert.ok(error instanceof Error);
        return true;
      });
    });

    it("retries only when connect fails: a drop after send is not sent again", async (t) => {
      const bridge = await startBridge(t, (_frame, connection) => connection.drop());
      const client = makeClient(t, bridge.connectionPath);

      await assert.rejects(client.call("get_model_info", {}), BridgeRequestPendingError);
      await pause(150);

      assert.equal(bridge.frames.length, 1, "the request must be sent exactly once");
      assert.equal(bridge.connections.length, 1, "no reconnect for a request that was already sent");
    });

    it("reconnects on the next call after a drop", async (t) => {
      const bridge = await startBridge(t, (_frame, connection) => connection.drop());
      const client = makeClient(t, bridge.connectionPath);
      await assert.rejects(client.call("get_model_info", {}), BridgeRequestPendingError);

      bridge.handler = echo;
      const result = await client.call("get_status", {});

      assert.deepEqual(result, { ok: true, method: "get_status" });
      assert.equal(bridge.connections.length, 2);
    });

    it("retries when connect fails, and keeps the same requestId", async (t) => {
      const bridge = await startBridge(t);
      const port = bridge.port;
      await bridge.stopListening();
      const attempts: Array<{ requestId: string; attempt: number }> = [];
      const client = makeClient(t, bridge.connectionPath, {
        connectRetries: 3,
        connectRetryDelayMs: 300,
        onConnectAttempt: (requestId, attempt) => {
          attempts.push({ requestId, attempt });
          if (attempt === 0) {
            // Revit finishes starting while the client waits to retry.
            setTimeout(() => void bridge.start(port), 50);
          }
        },
      });

      const result = await client.call("get_status", {});

      assert.deepEqual(result, { ok: true, method: "get_status" });
      assert.ok(attempts.length >= 2, "the first attempt failed, so there must be a retry");
      assert.equal(new Set(attempts.map((a) => a.requestId)).size, 1, "same id on every attempt");
      assert.deepEqual(
        attempts.map((a) => a.attempt),
        attempts.map((_, index) => index),
      );
      assert.equal(bridge.frames.length, 1);
      assert.equal(bridge.frames[0]?.id, attempts[0]?.requestId, "the frame carries the id of the attempts");
    });

    it("gives up when connect keeps failing, with RevitNotRunningError", async (t) => {
      const bridge = await startBridge(t);
      await bridge.stopListening();
      let attempts = 0;
      const client = makeClient(t, bridge.connectionPath, {
        connectRetries: 2,
        onConnectAttempt: () => {
          attempts++;
        },
      });

      await assert.rejects(client.call("get_status", {}), RevitNotRunningError);
      assert.equal(attempts, 3, "one attempt plus two retries");
    });

    it("destroys the connection when a frame is over 16 MB", async (t) => {
      const bridge = await startBridge(t, (_frame, connection) => {
        connection.socket.write(header(MAX_FRAME_BYTES + 1));
      });
      const client = makeClient(t, bridge.connectionPath);

      const call = client.call("get_model_info", {}, { timeoutMs: 30_000 });
      await assert.rejects(call, BridgeRequestPendingError);

      const connection = bridge.connections[0];
      assert.ok(connection);
      if (!connection.socket.destroyed) {
        await once(connection.socket, "close");
      }
      assert.ok(connection.socket.destroyed);
    });
  });

  describe("timeout", () => {
    function silentExceptCancel(cancelAnswer: (original: ReceivedFrame, cancel: ReceivedFrame) => unknown): FrameHandler {
      let original: ReceivedFrame | undefined;
      return (frame, connection) => {
        if (frame.method === "cancel_request") {
          assert.ok(original);
          connection.result(frame, cancelAnswer(original, frame));
          return;
        }
        if (frame.method === "get_status") {
          connection.result(frame, { ok: true });
          return;
        }
        original = frame;
      };
    }

    it("sends cancel_request after timeout", async (t) => {
      const bridge = await startBridge(
        t,
        silentExceptCancel((original) => ({
          requestId: original.id,
          state: "cancelled",
          error: { code: -32003, message: "cancelled" },
        })),
      );
      const client = makeClient(t, bridge.connectionPath);

      await assert.rejects(client.call("get_model_info", {}, { timeoutMs: 50 }), (error: unknown) => {
        assert.ok(error instanceof BridgeRpcError);
        assert.equal(error.code, -32003);
        assert.match(error.message, /not executed/i);
        return true;
      });

      assert.deepEqual(
        bridge.frames.map((frame) => frame.method),
        ["get_model_info", "cancel_request"],
      );
      assert.deepEqual(bridge.frames[1]?.params, { requestId: bridge.frames[0]?.id });
      assert.notEqual(bridge.frames[1]?.id, bridge.frames[0]?.id);
    });

    it("ignores the late answer of a request it already gave up on", async (t) => {
      let original: ReceivedFrame | undefined;
      const bridge = await startBridge(t, (frame, connection) => {
        if (frame.method === "cancel_request") {
          assert.ok(original);
          connection.result(frame, { requestId: original.id, state: "cancelled" });
          connection.error(original, -32003, "cancelled while queued");
          return;
        }
        if (frame.method === "get_model_info") {
          original = frame;
          return;
        }
        connection.result(frame, { ok: true });
      });
      const client = makeClient(t, bridge.connectionPath);
      await assert.rejects(client.call("get_model_info", {}, { timeoutMs: 50 }), BridgeRpcError);

      assert.deepEqual(await client.call("get_status", {}), { ok: true });
      assert.equal(bridge.connections.length, 1);
    });

    it("reports a running request with its id, so the model can ask get_request_status", async (t) => {
      const bridge = await startBridge(
        t,
        silentExceptCancel((original) => ({ requestId: original.id, state: "running" })),
      );
      const client = makeClient(t, bridge.connectionPath);

      await assert.rejects(client.call("get_model_info", {}, { timeoutMs: 50 }), (error: unknown) => {
        assert.ok(error instanceof BridgeRequestPendingError);
        assert.equal(error.requestId, bridge.frames[0]?.id);
        assert.equal(error.state, "running");
        assert.ok(error.message.includes(error.requestId));
        assert.match(error.message, /get_request_status/);
        assert.ok(error.message.includes(`requestId "${error.requestId}"`), "the message tells the model which id to pass");
        return true;
      });
    });

    it("returns the result when the request finished just before the cancel", async (t) => {
      const bridge = await startBridge(
        t,
        silentExceptCancel((original) => ({ requestId: original.id, state: "succeeded", result: { levels: [] } })),
      );
      const client = makeClient(t, bridge.connectionPath);

      assert.deepEqual(await client.call("get_model_info", {}, { timeoutMs: 50 }), { levels: [] });
    });

    it("raises the plugin's error when the request failed just before the cancel", async (t) => {
      const bridge = await startBridge(
        t,
        silentExceptCancel((original) => ({
          requestId: original.id,
          state: "failed",
          error: { code: -32603, message: "boom" },
        })),
      );
      const client = makeClient(t, bridge.connectionPath);

      await assert.rejects(client.call("get_model_info", {}, { timeoutMs: 50 }), (error: unknown) => {
        assert.ok(error instanceof BridgeRpcError);
        assert.equal(error.code, -32603);
        return true;
      });
    });

    it("reports state unknown when the cancel gets no answer either", async (t) => {
      const bridge = await startBridge(t, () => {});
      const client = makeClient(t, bridge.connectionPath, { cancelTimeoutMs: 50 });

      await assert.rejects(client.call("get_model_info", {}, { timeoutMs: 50 }), (error: unknown) => {
        assert.ok(error instanceof BridgeRequestPendingError);
        assert.equal(error.requestId, bridge.frames[0]?.id);
        assert.equal(error.state, "unknown");
        return true;
      });
    });
  });

  describe("plugin errors", () => {
    function failWith(code: number, message: string): FrameHandler {
      return (frame, connection) => connection.error(frame, code, message);
    }

    it("maps -32003 to a message that the command was not executed", async (t) => {
      const bridge = await startBridge(t, failWith(-32003, "Expired in the queue."));
      const client = makeClient(t, bridge.connectionPath);

      await assert.rejects(client.call("get_model_info", {}), (error: unknown) => {
        assert.ok(error instanceof BridgeRpcError);
        assert.equal(error.code, -32003);
        assert.match(error.message, /not executed/i);
        return true;
      });
    });

    it("maps -32004 to a message that the plugin is busy", async (t) => {
      const bridge = await startBridge(t, failWith(-32004, "The bridge is full."));
      const client = makeClient(t, bridge.connectionPath);

      await assert.rejects(client.call("get_model_info", {}), (error: unknown) => {
        assert.ok(error instanceof BridgeRpcError);
        assert.equal(error.code, -32004);
        assert.match(error.message, /busy/i);
        assert.match(error.message, /not executed/i);
        return true;
      });
    });

    it("maps -32603 no_active_document to the tools that make a project active", async (t) => {
      const bridge = await startBridge(t, failWith(-32603, "no_active_document: needs an open document."));
      const client = makeClient(t, bridge.connectionPath);

      await assert.rejects(client.call("get_model_info", {}), (error: unknown) => {
        assert.ok(error instanceof BridgeRpcError);
        assert.equal(error.code, -32603);
        assert.match(error.message, /create_project/);
        assert.match(error.message, /open_project/);
        assert.doesNotMatch(error.message, /ask the user/i);
        return true;
      });
    });

    it("passes wrong_active_document through unchanged, because a project is active", async (t) => {
      const message = "wrong_active_document: C:\\a.rvt is not the active document, C:\\b.rvt is, so nothing was saved.";
      const bridge = await startBridge(t, failWith(-32602, message));
      const client = makeClient(t, bridge.connectionPath);

      await assert.rejects(client.call("save_project", {}), (error: unknown) => {
        assert.ok(error instanceof BridgeRpcError);
        assert.equal(error.code, -32602);
        assert.equal(error.message, message);
        return true;
      });
    });

    it("passes other errors through with their code and message", async (t) => {
      const bridge = await startBridge(t, failWith(-32603, "The bridge failed: boom"));
      const client = makeClient(t, bridge.connectionPath);

      await assert.rejects(client.call("get_model_info", {}), (error: unknown) => {
        assert.ok(error instanceof BridgeRpcError);
        assert.equal(error.code, -32603);
        assert.match(error.message, /boom/);
        return true;
      });
    });

    it("never puts the token in an error, and drops the connection after a rejected token", async (t) => {
      const bridge = await startBridge(t, failWith(-32001, "The token is missing or wrong."));
      const client = makeClient(t, bridge.connectionPath);

      await assert.rejects(client.call("get_status", {}), (error: unknown) => {
        assert.ok(error instanceof BridgeRpcError);
        assert.equal(error.code, -32001);
        assert.ok(!JSON.stringify([error.message, error.data, String(error.stack)]).includes(bridge.token));
        return true;
      });

      bridge.handler = echo;
      await client.call("get_status", {});
      assert.equal(bridge.connections.length, 2, "the next call must read connection.json again and reconnect");
    });
  });
});
