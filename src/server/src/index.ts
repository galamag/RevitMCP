import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { BridgeClient } from "./client.ts";
import { defaultConnectionPath } from "./connection.ts";
import { createServer } from "./server.ts";

// MCP speaks over stdout, so nothing else may write to it. Diagnostics go to stderr.
async function main(): Promise<void> {
  const client = new BridgeClient(defaultConnectionPath());
  const server = createServer(client);

  const shutdown = (): void => {
    client.close();
    void server.close().finally(() => process.exit(0));
  };
  process.stdin.on("end", shutdown);
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  await server.connect(new StdioServerTransport());
  process.stderr.write("revit-mcp: ready; the connection to Revit opens on the first tool call.\n");
}

main().catch((error: unknown) => {
  process.stderr.write(`revit-mcp: failed to start: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exit(1);
});
