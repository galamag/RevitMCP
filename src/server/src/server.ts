import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { BridgeClient } from "./client.ts";
import { BridgeRequestPendingError, BridgeRpcError, RevitNotRunningError } from "./errors.ts";
import { tools } from "./registry.ts";
import type { ToolDefinition } from "./registry.ts";

const SERVER_VERSION = "0.1.0";

const INSTRUCTIONS =
  "These tools drive Autodesk Revit through its RevitMCP plugin, so Revit must be running with a project open. " +
  "Lengths are in millimetres and angles in degrees. Element and level ids are strings; pass them back unchanged. " +
  "Start with get_model_info. If a tool reports a requestId, ask get_request_status before sending the command again.";

interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

/** Builds the MCP server that forwards each tool call to Revit through the bridge client. Not connected yet. */
export function createServer(client: BridgeClient, toolList: readonly ToolDefinition[] = tools): McpServer {
  const server = new McpServer({ name: "revit-mcp", version: SERVER_VERSION }, { instructions: INSTRUCTIONS });

  for (const tool of toolList) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.inputSchema },
      async (args: Record<string, unknown>): Promise<ToolResult> => {
        try {
          const result = await client.call(tool.name, args, { timeoutMs: tool.timeoutMs });
          return { content: [{ type: "text", text: JSON.stringify(result) }] };
        } catch (error) {
          return { isError: true, content: [{ type: "text", text: describeError(error) }] };
        }
      },
    );
  }

  return server;
}

/** The text a failed tool call shows the model. Bridge errors already say what to do; anything else is a bug. */
export function describeError(error: unknown): string {
  if (error instanceof BridgeRpcError || error instanceof BridgeRequestPendingError || error instanceof RevitNotRunningError) {
    return error.message;
  }

  // Not a bridge error, so it is not meant for the model: keep the detail on stderr, which MCP does not use.
  process.stderr.write(`revit-mcp: unexpected error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  return `The MCP server failed unexpectedly: ${error instanceof Error ? error.message : String(error)}`;
}
