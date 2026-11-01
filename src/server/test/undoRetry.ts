import assert from "node:assert/strict";
import type { TestContext } from "node:test";

import type { BridgeClient } from "../src/client.ts";
import { UndoNotConfirmedError, undoLastOperation, type UndoResult } from "../src/undo.ts";

// The Undo step of the live tests, shared, so that every live file asks Revit the same way.

/** The undo tool refuses to post a second undo until a minute after an unconfirmed one, so that two never overlap. */
export const UNDO_SETTLE_MS = 61_000;

/**
 * Undoes the last operation. Revit itself now and then refuses the Undo that was posted to it: its journal says `API queue
 * command ID_BUTTON_UNDO cannot be invoked in this context`, and the tool answers `Not undone`, with the model as it was.
 * It came in windows of time and for every tool tried (create_walls, create_type, create_materials), also in the stage 2
 * undo tests, and the cause is not known. So this posts the undo once more after the minute the tool asks for. Before it
 * does, it asks what became of the first post, as an undo that ran late must not be posted again. The retry is written to
 * the result of the test.
 */
export async function undoWithOneRetry(t: TestContext, client: BridgeClient): Promise<UndoResult> {
  try {
    return await undoLastOperation(client);
  } catch (error) {
    if (!(error instanceof UndoNotConfirmedError) || !error.message.startsWith("Not undone")) {
      throw error;
    }

    await new Promise((resolve) => setTimeout(resolve, UNDO_SETTLE_MS));
    const first = (await client.call("get_last_undo_result", {})) as UndoResult;
    t.diagnostic(`Revit did not run the posted undo of ${String(first.transactionName)}; a minute later get_last_undo_result says ${first.state}, so ${first.state === "undone" ? "it is not posted again" : "it is posted again"}`);

    if (first.state === "undone") {
      return first;
    }
    assert.equal(first.state, "not_confirmed", `an undo that is neither confirmed nor undone must not be posted again: ${JSON.stringify(first)}`);

    return undoLastOperation(client);
  }
}
