import type { TestContext } from "node:test";

import type { BridgeClient } from "../src/client.ts";
import { UndoNotConfirmedError, undoLastOperation, type UndoResult } from "../src/undo.ts";

// The Undo step of the live tests, shared, so that every live file asks Revit the same way.

/**
 * Undoes the last operation. Revit itself now and then refuses the Undo that was posted to it: its journal says `API queue
 * command ID_BUTTON_UNDO cannot be invoked in this context`, and the tool answers `Not undone`, with the model as it was.
 * It came in windows of time and for every tool tried (create_walls, create_type, create_materials), also in the stage 2
 * undo tests, and the cause is not known. So this posts the undo once more, at once, which the tool allows after a refusal.
 * The retry is written to the result of the test.
 */
export async function undoWithOneRetry(t: Pick<TestContext, "diagnostic">, client: BridgeClient): Promise<UndoResult> {
  try {
    return await undoLastOperation(client);
  } catch (error) {
    if (!(error instanceof UndoNotConfirmedError) || !error.message.startsWith("Not undone")) {
      throw error;
    }

    t.diagnostic(`Revit refused a posted undo, so it is posted once more: ${error.message}`);

    return undoLastOperation(client);
  }
}
