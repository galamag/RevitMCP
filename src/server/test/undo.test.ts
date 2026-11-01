import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TestContext } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { BridgeClient } from "../src/client.ts";
import { BridgeRpcError, RevitNotRunningError } from "../src/errors.ts";
import { tools } from "../src/registry.ts";
import { createServer } from "../src/server.ts";
import { UndoNotConfirmedError, undoLastOperation } from "../src/undo.ts";
import { FakeBridge } from "./fakeBridge.ts";
import type { FrameHandler } from "./fakeBridge.ts";
import { undoWithOneRetry } from "./undoRetry.ts";

const posted = { undoId: 7, transactionName: "MCP: create_walls", createdIds: ["10"], restoredIds: [], documentTitle: "Дом" };
const undone = { state: "undone", ...posted };
const INVALID_PARAMS = -32602;
const NOT_EXECUTED = -32003;

/** Connects an MCP client to the real server over memory, with a fake bridge whose calls time out fast. */
async function connect(t: TestContext, handler: FrameHandler, timeoutMs?: number) {
  const bridge = new FakeBridge(handler);
  t.after(() => bridge.close());
  await bridge.start();

  const bridgeClient = new BridgeClient(bridge.connectionPath, { connectRetries: 0, connectRetryDelayMs: 10 });
  t.after(() => bridgeClient.close());

  const toolList = tools.map((tool) => (tool.name === "undo_last_operation" && timeoutMs !== undefined ? { ...tool, timeoutMs } : tool));
  const server = createServer(bridgeClient, toolList);
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  t.after(async () => {
    await client.close();
    await server.close();
  });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);

  return { bridge, bridgeClient, client };
}

const undo = (client: Client) => client.callTool({ name: "undo_last_operation", arguments: {} });

function textOf(result: unknown): string {
  const content = (result as { content: Array<{ type: string; text: string }> }).content;
  return content.map((part) => part.text).join("\n");
}

/** A bridge that answers the post, and leaves the confirmation to `confirm`. */
function afterPost(confirm: FrameHandler): FrameHandler {
  return (frame, connection) => {
    if (frame.method === "undo_last_operation") {
      connection.result(frame, posted);
    } else {
      confirm(frame, connection);
    }
  };
}

function assertNoClaim(text: string): void {
  assert.doesNotMatch(text, /safe to send/i);
  assert.doesNotMatch(text, /nothing in the Revit project changed/i);
}

describe("undo_last_operation", { timeout: 20_000 }, () => {
  it("posts, confirms right after, and returns the confirmation", async (t) => {
    const { bridge, client } = await connect(t, afterPost((frame, connection) => connection.result(frame, undone)));

    const result = await undo(client);

    assert.ok(!result.isError);
    assert.deepEqual(JSON.parse(textOf(result)), undone);
    assert.deepEqual(bridge.frames.map((frame) => frame.method), ["undo_last_operation", "get_last_undo_result"]);
    assert.deepEqual(bridge.frames[0]?.params, {});
    assert.deepEqual(bridge.frames[1]?.params, {});
  });

  it("passes a refusal on and sends no confirmation", async (t) => {
    const refusal = "undo_refused: the last change in 'Дом' is 'Wall', which did not come from these tools.";
    const { bridge, client } = await connect(t, (frame, connection) => connection.error(frame, INVALID_PARAMS, refusal));

    const result = await undo(client);

    assert.equal(result.isError, true);
    assert.equal(textOf(result), refusal);
    assert.equal(bridge.frames.length, 1);
  });

  it("says Revit refused, that the model did not change, and that it can be tried again", async (t) => {
    const { bridge, client } = await connect(t, afterPost((frame, connection) => connection.result(frame, { ...undone, state: "refused" })));

    const result = await undo(client);

    assert.equal(result.isError, true);
    assert.match(textOf(result), /^Not undone: Revit refused/);
    assert.match(textOf(result), /MCP: create_walls/);
    assert.match(textOf(result), /the model did not change/);
    assert.match(textOf(result), /can be called again at once/);
    assert.doesNotMatch(textOf(result), /holding|a minute/);
    assert.deepEqual(bridge.frames.map((frame) => frame.method), ["undo_last_operation", "get_last_undo_result"]);
  });

  it("takes a state from before the refusal for one it has not heard of", async (t) => {
    const { client } = await connect(t, afterPost((frame, connection) => connection.result(frame, { ...undone, state: "not_confirmed" })));

    const result = await undo(client);

    assert.equal(result.isError, true);
    assert.match(textOf(result), /not known whether it happened/);
    assert.doesNotMatch(textOf(result), /Not undone/);
  });

  it("never claims success after a plugin restart, and says that is what happened", async (t) => {
    const nothing = { state: "none", undoId: null, transactionName: null, createdIds: [], restoredIds: [], documentTitle: null, otherName: null, otherDocumentTitle: null };
    const { client } = await connect(t, afterPost((frame, connection) => connection.result(frame, nothing)));

    const result = await undo(client);

    assert.equal(result.isError, true);
    assert.match(textOf(result), /the plugin now knows of no undo at all/);
    assert.match(textOf(result), /restarted/);
    assert.match(textOf(result), /not known whether it happened/);
    assert.doesNotMatch(textOf(result), /about another undo/);
  });

  it("says what Revit undid when it took something else", async (t) => {
    const other = { ...undone, state: "other", otherName: "Wall", otherDocumentTitle: "Другой", createdIds: [], restoredIds: [] };
    const { client } = await connect(t, afterPost((frame, connection) => connection.result(frame, other)));

    const result = await undo(client);

    assert.equal(result.isError, true);
    assert.match(textOf(result), /^Revit undid 'Wall' in 'Другой' instead of 'MCP: create_walls'/);
    assert.match(textOf(result), /the model did change/);
    assert.doesNotMatch(textOf(result), /Not undone/);
    assert.doesNotMatch(textOf(result), /treat the model as unchanged/);
    assert.doesNotMatch(textOf(result), /are gone|are back/);
  });

  it("names the ids of what Revit undid instead, when it knows them", async (t) => {
    const other = { ...undone, state: "other", otherName: "MCP: create_walls", otherDocumentTitle: "Дом", createdIds: ["20"], restoredIds: ["5"] };
    const { client } = await connect(t, afterPost((frame, connection) => connection.result(frame, other)));

    const result = await undo(client);

    assert.equal(result.isError, true);
    assert.match(textOf(result), /are gone: 20\./);
    assert.match(textOf(result), /are back: 5\./);
  });

  it("calls the state unknown when a change could not be recorded while the undo waited", async (t) => {
    const { client } = await connect(t, afterPost((frame, connection) => connection.result(frame, { ...undone, state: "unknown" })));

    const result = await undo(client);

    assert.equal(result.isError, true);
    assert.match(textOf(result), /a change could not be recorded/);
    assert.match(textOf(result), /not known whether it happened/);
    assert.doesNotMatch(textOf(result), /Not undone/);
  });

  it("never claims anything for a state it has not heard of", async (t) => {
    const { client } = await connect(t, afterPost((frame, connection) => connection.result(frame, { ...undone, state: "пропало" })));

    const result = await undo(client);

    assert.equal(result.isError, true);
    assert.match(textOf(result), /not known whether it happened/);
    assert.doesNotMatch(textOf(result), /Not undone/);
  });

  it("calls the state unknown when the confirmation was cancelled in the queue", async (t) => {
    const { client } = await connect(
      t,
      afterPost((frame, connection) => {
        if (frame.method === "cancel_request") {
          connection.result(frame, { requestId: frame.params["requestId"], state: "cancelled" });
        }
      }),
      50,
    );

    const result = await undo(client);

    assert.equal(result.isError, true);
    assert.match(textOf(result), /not known whether it happened/);
    assert.match(textOf(result), /get_last_undo_result/);
    assert.match(textOf(result), /Do not call undo_last_operation again/);
    assert.match(textOf(result), /ask the user to look at Revit/);
    assertNoClaim(textOf(result));
  });

  it("calls the state unknown when the confirmation is stuck in Revit", async (t) => {
    const { client } = await connect(
      t,
      afterPost((frame, connection) => {
        if (frame.method === "cancel_request") {
          connection.result(frame, { requestId: frame.params["requestId"], state: "running" });
        }
      }),
      50,
    );

    const result = await undo(client);

    assert.equal(result.isError, true);
    assert.match(textOf(result), /not known whether it happened/);
    assert.match(textOf(result), /get_last_undo_result/);
    assert.match(textOf(result), /ask the user to look at Revit/);
    assertNoClaim(textOf(result));
  });

  it("calls the state unknown when the connection goes during the confirmation", async (t) => {
    const { client } = await connect(t, afterPost((_frame, connection) => connection.drop()));

    const result = await undo(client);

    assert.equal(result.isError, true);
    assert.match(textOf(result), /not known whether it happened/);
    assert.match(textOf(result), /ask the user to look at Revit/);
    assertNoClaim(textOf(result));
  });

  it("calls the state unknown when Revit is gone by the confirmation", async (t) => {
    const { bridge, client } = await connect(t, (frame, connection) => {
      connection.result(frame, posted);
      void bridge.stopListening();
    });

    const result = await undo(client);

    assert.equal(result.isError, true);
    assert.match(textOf(result), /not known whether it happened/);
    assertNoClaim(textOf(result));
  });

  it("calls the state unknown when the confirmation fails in the plugin", async (t) => {
    const { client } = await connect(t, afterPost((frame, connection) => connection.error(frame, -32603, "boom")));

    const result = await undo(client);

    assert.equal(result.isError, true);
    assert.match(textOf(result), /not known whether it happened/);
  });

  it("calls the state unknown when the confirmation expired in the queue", async (t) => {
    const { client } = await connect(t, afterPost((frame, connection) => connection.error(frame, NOT_EXECUTED, "expired")));

    const result = await undo(client);

    assert.equal(result.isError, true);
    assert.match(textOf(result), /not known whether it happened/);
    assertNoClaim(textOf(result));
  });

  it("calls the state unknown when the confirmation is about another undo", async (t) => {
    const { client } = await connect(t, afterPost((frame, connection) => connection.result(frame, { ...undone, undoId: 8 })));

    const result = await undo(client);

    assert.equal(result.isError, true);
    assert.match(textOf(result), /another undo/);
  });

  for (const [what, answer] of [
    ["null", null],
    ["no state", { undoId: 7, createdIds: [], restoredIds: [] }],
    ["a state that is no text", { ...undone, state: 1 }],
    ["no id lists", { state: "undone", undoId: 7 }],
    ["a list", []],
  ] as const) {
    it(`calls the state unknown for a confirmation that reads ${what}`, async (t) => {
      const { client } = await connect(t, afterPost((frame, connection) => connection.result(frame, answer)));

      const result = await undo(client);

      assert.equal(result.isError, true);
      assert.match(textOf(result), /could not be read/);
    });
  }

  it("calls the state unknown when the post cannot be read, and asks nothing more", async (t) => {
    const { bridge, client } = await connect(t, (frame, connection) => connection.result(frame, { undoId: "7" }));

    const result = await undo(client);

    assert.equal(result.isError, true);
    assert.match(textOf(result), /not known whether it was posted/);
    assert.match(textOf(result), /it describes an older one/);
    assert.equal(bridge.frames.length, 1);
  });

  it("says nothing was executed when the post was cancelled in the queue", async (t) => {
    const { bridge, client } = await connect(
      t,
      (frame, connection) => {
        if (frame.method === "cancel_request") {
          connection.result(frame, { requestId: frame.params["requestId"], state: "cancelled" });
        }
      },
      50,
    );

    const result = await undo(client);

    assert.equal(result.isError, true);
    assert.match(textOf(result), /was not executed/);
    assert.deepEqual(bridge.frames.map((frame) => frame.method), ["undo_last_operation", "cancel_request"]);
  });

  it("calls the post unknown when it times out and may have run", async (t) => {
    const { client } = await connect(
      t,
      (frame, connection) => {
        if (frame.method === "cancel_request") {
          connection.result(frame, { requestId: frame.params["requestId"], state: "running" });
        }
      },
      50,
    );

    const result = await undo(client);

    assert.equal(result.isError, true);
    assert.match(textOf(result), /not known whether the undo was posted/);
    assert.match(textOf(result), /Do not call undo_last_operation again/);
    assert.match(textOf(result), /First see whether it was posted at all/);
    assert.match(textOf(result), /it describes an older one/);
    assert.match(textOf(result), /ask the user to look at Revit/);
  });

  it("softens what it says about the asked-for step when Revit undid something else", async (t) => {
    const other = { ...undone, state: "other", otherName: "Wall", otherDocumentTitle: "Другой", createdIds: [], restoredIds: [] };
    const { client } = await connect(t, afterPost((frame, connection) => connection.result(frame, other)));

    const result = await undo(client);

    assert.match(textOf(result), /probably still in the model/);
    assert.match(textOf(result), /parked undo could still run later/);
    assert.doesNotMatch(textOf(result), /was not taken by that\./);
  });

  it("throws a refusal as the plugin error, and an unconfirmed undo as its own error", async (t) => {
    let refuse = true;
    const { bridgeClient } = await connect(t, (frame, connection) => {
      if (refuse) {
        connection.error(frame, INVALID_PARAMS, "undo_refused: nothing");
      } else if (frame.method === "undo_last_operation") {
        connection.result(frame, posted);
      } else {
        connection.result(frame, { ...undone, state: "refused" });
      }
    });

    await assert.rejects(undoLastOperation(bridgeClient), (error: unknown) => error instanceof BridgeRpcError && error.code === INVALID_PARAMS);

    refuse = false;
    await assert.rejects(undoLastOperation(bridgeClient), UndoNotConfirmedError);
  });

  it("lets a Revit that is not running surface as such, with nothing sent", async (t) => {
    const { bridge, bridgeClient } = await connect(t, () => {});
    await bridge.writeConnectionFile({ pid: 2 ** 31 - 2 });

    await assert.rejects(undoLastOperation(bridgeClient), RevitNotRunningError);
    assert.equal(bridge.frames.length, 0);
  });
});

describe("undoWithOneRetry, the undo of the live tests", { timeout: 20_000 }, () => {
  /** A bridge that answers each confirmation with the next of `states`, and a list of what the retry wrote to the test. */
  async function retryAgainst(t: TestContext, states: string[]) {
    const left = [...states];
    const notes: string[] = [];
    const { bridge, bridgeClient } = await connect(t, afterPost((frame, connection) => connection.result(frame, { ...undone, state: left.shift() })));

    return { bridge, notes, run: () => undoWithOneRetry({ diagnostic: (message) => notes.push(message) }, bridgeClient) };
  }

  it("needs no retry for an undo that lands", async (t) => {
    const { bridge, notes, run } = await retryAgainst(t, ["undone"]);

    assert.equal((await run()).state, "undone");
    assert.equal(bridge.frames.length, 2);
    assert.deepEqual(notes, []);
  });

  it("posts a refused undo once more, at once, after one more read, and writes that to the test", async (t) => {
    const { bridge, notes, run } = await retryAgainst(t, ["refused", "refused", "undone"]);

    assert.equal((await run()).state, "undone");
    assert.deepEqual(bridge.frames.map((frame) => frame.method), ["undo_last_operation", "get_last_undo_result", "get_last_undo_result", "undo_last_operation", "get_last_undo_result"]);
    assert.equal(notes.length, 1);
    assert.match(notes[0] ?? "", /Revit refused/);
    assert.match(notes[0] ?? "", /it is posted once more/);
  });

  it("returns an undo that ran late and does not post again, which would take the next step", async (t) => {
    const { bridge, notes, run } = await retryAgainst(t, ["refused", "undone"]);

    assert.equal((await run()).state, "undone");
    assert.deepEqual(bridge.frames.map((frame) => frame.method), ["undo_last_operation", "get_last_undo_result", "get_last_undo_result"]);
    assert.match(notes[0] ?? "", /it is not posted again/);
  });

  it("does not post again when the read after a refusal says anything else", async (t) => {
    const { bridge, run } = await retryAgainst(t, ["refused", "other"]);

    await assert.rejects(run(), /must not be posted again/);
    assert.equal(bridge.frames.length, 3);
  });

  it("gives up after the second refusal", async (t) => {
    const { bridge, run } = await retryAgainst(t, ["refused", "refused", "refused"]);

    await assert.rejects(run(), /^UndoNotConfirmedError: Not undone/);
    assert.equal(bridge.frames.length, 5);
  });

  it("does not post again when it is not known what became of the undo", async (t) => {
    const { bridge, run } = await retryAgainst(t, ["unknown"]);

    await assert.rejects(run(), /not known whether it happened/);
    assert.equal(bridge.frames.length, 2);
  });
});

describe("get_last_undo_result", { timeout: 20_000 }, () => {
  it("forwards to the bridge and answers without undoing", async (t) => {
    const answer = { state: "none", undoId: null, transactionName: null, createdIds: [], restoredIds: [], documentTitle: null };
    const { bridge, client } = await connect(t, (frame, connection) => connection.result(frame, answer));

    const result = await client.callTool({ name: "get_last_undo_result", arguments: {} });

    assert.ok(!result.isError);
    assert.deepEqual(JSON.parse(textOf(result)), answer);
    assert.deepEqual(bridge.frames.map((frame) => frame.method), ["get_last_undo_result"]);
  });
});
