import type { BridgeClient } from "./client.ts";
import { BridgeRequestPendingError, BridgeRpcError, RevitNotRunningError, RpcCodes } from "./errors.ts";

/** What can make the calls of the undo tool. */
export type UndoClient = Pick<BridgeClient, "call">;

/** The answer of `undo_last_operation`: what was posted. Nothing has happened yet. */
interface PostedUndo {
  undoId: number;
  transactionName: string;
}

/** The answer of `get_last_undo_result`, and the result of an undo that happened. */
export interface UndoResult {
  state: string;
  undoId: number | null;
  transactionName: string | null;
  createdIds: string[];
  restoredIds: string[];
  documentTitle: string | null;
}

const FIND_OUT =
  "Do not call undo_last_operation again before you know: it would take the next operation. Call get_last_undo_result, which says what became of this undo, or read the elements with get_elements.";

/**
 * The undo did not end in a confirmation, because Revit was asked and did not report it, or because nobody could ask.
 * The message says which, and it is written for the model.
 */
export class UndoNotConfirmedError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "UndoNotConfirmedError";
  }
}

/**
 * Runs Revit's Undo in two requests. The first one posts it, which runs only after the plugin has answered, so its
 * answer proves nothing. The second one goes through the same queue right after it: live Revit lets a parked posted
 * command run ahead of the next request, so it also makes the undo happen, and it reports what the undo event said.
 *
 * @throws BridgeRpcError A refusal, or a request that never ran: nothing was posted.
 * @throws RevitNotRunningError Nothing was sent.
 * @throws UndoNotConfirmedError The undo was posted, or may have been, and no confirmation came.
 */
export async function undoLastOperation(client: UndoClient, timeoutMs?: number): Promise<UndoResult> {
  const posted = await post(client, timeoutMs);
  const undoOf = `The undo of '${posted.transactionName}' was posted to Revit`;

  let answer: unknown;
  try {
    answer = await client.call("get_last_undo_result", {}, { timeoutMs });
  } catch (error) {
    throw new UndoNotConfirmedError(`${undoOf}, but ${whyNoAnswer(error)}, so it is not known whether it happened. ${FIND_OUT}`, { cause: error });
  }

  const result = readResult(answer);
  if (result === null) {
    throw new UndoNotConfirmedError(`${undoOf}, but its confirmation could not be read, so it is not known whether it happened. ${FIND_OUT}`);
  }
  if (result.undoId !== posted.undoId) {
    throw new UndoNotConfirmedError(`${undoOf}, but the answer is about another undo, so it is not known what became of this one. ${FIND_OUT}`);
  }
  if (result.state !== "undone") {
    throw new UndoNotConfirmedError(
      `Not undone: Revit did not report the undo of '${posted.transactionName}' that was posted to it, so treat the model as unchanged. Revit may be holding the command, or it may have dropped it. ` +
        "Call get_last_undo_result to look again. Until a minute has passed since the post, undo_last_operation refuses, so that two undos never overlap.",
    );
  }

  return result;
}

async function post(client: UndoClient, timeoutMs: number | undefined): Promise<PostedUndo> {
  let answer: unknown;
  try {
    answer = await client.call("undo_last_operation", {}, { timeoutMs });
  } catch (error) {
    if (error instanceof BridgeRequestPendingError) {
      throw new UndoNotConfirmedError(`It is not known whether the undo was posted: ${error.message} ${FIND_OUT}`, { cause: error });
    }
    throw error;
  }

  const posted = answer as Partial<PostedUndo> | null;
  if (typeof posted?.undoId !== "number" || typeof posted.transactionName !== "string") {
    throw new UndoNotConfirmedError(`The answer to the undo could not be read, so it is not known whether it was posted. ${FIND_OUT}`);
  }

  return { undoId: posted.undoId, transactionName: posted.transactionName };
}

/** The words a failed confirmation gets. Its own message must not reach the model, as it may call the command safe to repeat. */
function whyNoAnswer(error: unknown): string {
  if (error instanceof BridgeRpcError && error.code === RpcCodes.notExecuted) {
    return "the request that confirms it could not run, as Revit may be busy or showing a dialog";
  }
  if (error instanceof BridgeRequestPendingError) {
    return "no confirmation came back in time";
  }
  if (error instanceof RevitNotRunningError) {
    return "Revit can no longer be reached";
  }
  return "the request that confirms it failed";
}

function readResult(answer: unknown): UndoResult | null {
  const result = answer as Partial<UndoResult> | null;
  return typeof result?.state === "string" && Array.isArray(result.createdIds) && Array.isArray(result.restoredIds) ? (result as UndoResult) : null;
}
