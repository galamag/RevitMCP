import type { BridgeCaller } from "./client.ts";
import { BridgeRequestPendingError, BridgeRpcError, RevitNotRunningError, RpcCodes } from "./errors.ts";

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
  otherName: string | null;
  otherDocumentTitle: string | null;
}

const DO_NOT_REPEAT = "Do not call undo_last_operation again before you know: it would take the next operation.";

/** When the undo is known to be posted, the plugin's last attempt is this one. */
const FIND_OUT = `${DO_NOT_REPEAT} Call get_last_undo_result, which says what became of this undo, or read the elements with get_elements.`;

/** When the post itself is in doubt, the plugin's last attempt may be an earlier one. */
const FIND_OUT_AFTER_POST =
  `${DO_NOT_REPEAT} First see whether it was posted at all. Then call get_last_undo_result, but compare what it names with what you asked for: when this undo was never posted, it describes an older one.`;

/** `get_last_undo_result` waits in the same queue, so nothing the model calls gets past what holds this one up. */
const LOOK_AT_REVIT = "get_last_undo_result waits behind whatever holds Revit up too, so ask the user to look at Revit first and close any dialog there.";

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
export async function undoLastOperation(client: BridgeCaller, timeoutMs?: number): Promise<UndoResult> {
  const posted = await post(client, timeoutMs);
  const undoOf = `The undo of '${posted.transactionName}' was posted to Revit`;

  let answer: unknown;
  try {
    answer = await client.call("get_last_undo_result", {}, { timeoutMs });
  } catch (error) {
    throw new UndoNotConfirmedError(`${undoOf}, but ${whyNoAnswer(error)}, so it is not known whether it happened. ${FIND_OUT}${holdsRevitUp(error) ? ` ${LOOK_AT_REVIT}` : ""}`, { cause: error });
  }

  const result = readResult(answer);
  if (result === null) {
    throw new UndoNotConfirmedError(`${undoOf}, but its confirmation could not be read, so it is not known whether it happened. ${FIND_OUT}`);
  }
  if (result.state === "none") {
    throw new UndoNotConfirmedError(
      `${undoOf}, but the plugin now knows of no undo at all, which means it restarted in between, as Revit did. So it is not known whether it happened, and nothing will report it any more. ` +
        `${DO_NOT_REPEAT} Read the elements with get_elements and see get_model_info.`,
    );
  }
  if (result.undoId !== posted.undoId) {
    throw new UndoNotConfirmedError(`${undoOf}, but the answer is about another undo, so it is not known what became of this one. ${FIND_OUT}`);
  }

  switch (result.state) {
    case "undone":
      return result;
    case "not_confirmed":
      throw new UndoNotConfirmedError(
        `Not undone: Revit did not report the undo of '${posted.transactionName}' that was posted to it, so treat the model as unchanged. Revit may be holding the command, or it may have dropped it. ` +
          "Call get_last_undo_result to look again. Until a minute has passed since the post, undo_last_operation refuses, so that two undos never overlap.",
      );
    case "other":
      throw new UndoNotConfirmedError(describeOther(result, posted));
    default:
      throw new UndoNotConfirmedError(`${undoOf}, but a change could not be recorded while it waited, so it is not known whether it happened. ${DO_NOT_REPEAT} Read the elements with get_elements and see get_model_info.`);
  }
}

async function post(client: BridgeCaller, timeoutMs: number | undefined): Promise<PostedUndo> {
  let answer: unknown;
  try {
    answer = await client.call("undo_last_operation", {}, { timeoutMs });
  } catch (error) {
    if (error instanceof BridgeRequestPendingError) {
      throw new UndoNotConfirmedError(`It is not known whether the undo was posted: ${error.message} ${FIND_OUT_AFTER_POST}`, { cause: error });
    }
    throw error;
  }

  const posted = answer as Partial<PostedUndo> | null;
  if (typeof posted?.undoId !== "number" || typeof posted.transactionName !== "string") {
    throw new UndoNotConfirmedError(`The answer to the undo could not be read, so it is not known whether it was posted. ${FIND_OUT_AFTER_POST}`);
  }

  return { undoId: posted.undoId, transactionName: posted.transactionName };
}

function describeOther(result: UndoResult, posted: PostedUndo): string {
  const created = result.createdIds.length > 0 ? ` The elements it had created are gone: ${result.createdIds.join(", ")}.` : "";
  const restored = result.restoredIds.length > 0 ? ` The elements it had deleted are back: ${result.restoredIds.join(", ")}.` : "";

  return (
    `Revit undid '${result.otherName ?? "something unnamed"}' in '${result.otherDocumentTitle ?? "an unnamed project"}' instead of '${posted.transactionName}', so the model did change, and not as asked.${created}${restored} ` +
    `'${posted.transactionName}' was not taken by that. Read the model with get_model_info and get_elements before you go on, and tell the user if the change may be theirs.`
  );
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

function holdsRevitUp(error: unknown): boolean {
  return (error instanceof BridgeRpcError && error.code === RpcCodes.notExecuted) || error instanceof BridgeRequestPendingError;
}

function readResult(answer: unknown): UndoResult | null {
  const result = answer as Partial<UndoResult> | null;
  return typeof result?.state === "string" && Array.isArray(result.createdIds) && Array.isArray(result.restoredIds) ? (result as UndoResult) : null;
}
