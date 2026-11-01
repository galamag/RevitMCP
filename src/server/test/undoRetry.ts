import assert from "node:assert/strict";
import type { TestContext } from "node:test";

import type { BridgeClient } from "../src/client.ts";
import { UndoNotConfirmedError, undoLastOperation, type UndoResult } from "../src/undo.ts";

// The Undo step of the live tests, shared, so that every live file asks Revit the same way.

/**
 * Undoes the last operation. Revit itself now and then refuses the Undo that was posted to it: its journal says `API queue
 * command ID_BUTTON_UNDO cannot be invoked in this context`, and the tool answers `Not undone`, with the model as it was.
 * It came in windows of time and for every tool tried (create_walls, create_type, create_materials), also in the stage 2
 * undo tests, and the cause is not known. So this posts the undo once more, at once, which the tool allows after a refusal.
 * Before it does, it asks once more what became of the first post, as an undo that ran late must not be posted again: that
 * would take the next step. The retry is written to the result of the test.
 */
export async function undoWithOneRetry(t: Pick<TestContext, "diagnostic">, client: BridgeClient): Promise<UndoResult> {
  try {
    return await undoLastOperation(client);
  } catch (error) {
    if (!(error instanceof UndoNotConfirmedError) || !error.message.startsWith("Not undone")) {
      throw error;
    }

    const first = (await client.call("get_last_undo_result", {})) as UndoResult;
    t.diagnostic(`Revit refused a posted undo of ${String(first.transactionName)}; get_last_undo_result now says ${first.state}, so ${first.state === "undone" ? "it is not posted again" : "it is posted once more"}`);

    if (first.state === "undone") {
      return first;
    }
    assert.equal(first.state, "refused", `an undo that is neither refused nor undone must not be posted again: ${JSON.stringify(first)}`);

    return undoLastOperation(client);
  }
}
