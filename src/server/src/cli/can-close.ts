import { BridgeClient } from "../client.ts";
import { defaultConnectionPath } from "../connection.ts";
import { checkCanClose, defaultTestFolder } from "./closeRule.ts";

/**
 * Exit 0: Revit may be closed. Exit 1: it may not (the reasons are on stderr). Exit 2: the plugin did not answer.
 * The connection token is never printed.
 */
async function main(): Promise<number> {
  const client = new BridgeClient(defaultConnectionPath());
  try {
    const info = await client.call("get_model_info", {}, { timeoutMs: 10_000 });
    const openDocuments = (typeof info === "object" && info !== null ? info : {}) as { openDocuments?: unknown };
    const verdict = checkCanClose(openDocuments.openDocuments, defaultTestFolder());

    if (!verdict.ok) {
      process.stderr.write(`can-close: REFUSED, Revit must stay open.\n${verdict.reasons.map((reason) => `  - ${reason}\n`).join("")}`);
      return 1;
    }

    const count = (openDocuments.openDocuments as unknown[]).length;
    process.stdout.write(`can-close: OK, ${count === 0 ? "no document is open" : `${count} saved document(s) in ${defaultTestFolder()}`}.\n`);
    return 0;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    process.stderr.write(`can-close: REFUSED, the plugin did not answer, so open documents are unknown. ${reason}\n`);
    return 2;
  } finally {
    client.close();
  }
}

process.exitCode = await main();
