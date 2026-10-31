import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { RevitNotRunningError } from "./errors.ts";

/** What the plugin writes to connection.json. The token is a secret: never log it, never put it in an error. */
export interface ConnectionInfo {
  port: number;
  token: string;
  pid: number;
  protocolVersion: number;
}

/** `%LOCALAPPDATA%\RevitMCP\connection.json`, where the plugin announces its port and token. */
export function defaultConnectionPath(): string {
  const localAppData = process.env["LOCALAPPDATA"] || path.join(homedir(), "AppData", "Local");
  return path.join(localAppData, "RevitMCP", "connection.json");
}

/** True when a process with this id exists. A process we may not signal still exists. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Reads connection.json afresh, since the port and the token change on every Revit start.
 * Throws {@link RevitNotRunningError} when the file is missing or unusable, or names a dead process.
 * Error messages carry the path and the pid, never the content.
 */
export async function readConnectionInfo(
  connectionPath: string,
  alive: (pid: number) => boolean = isProcessAlive,
): Promise<ConnectionInfo> {
  let text: string;
  try {
    text = await readFile(connectionPath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new RevitNotRunningError(
      code === "ENOENT" || code === "ENOTDIR"
        ? `Revit is not running, or the RevitMCP plugin did not start: there is no connection file at ${connectionPath}. Ask the user to start Revit and wait until it has loaded, then try again.`
        : `The connection file at ${connectionPath} cannot be read (${code ?? "unknown error"}). Ask the user to start Revit, or to restart it if it is running.`,
      { cause: error },
    );
  }

  const info = parse(text);
  if (info === null) {
    throw new RevitNotRunningError(
      `The connection file at ${connectionPath} is not valid. Ask the user to restart Revit so the plugin writes it again.`,
    );
  }

  if (!alive(info.pid)) {
    throw new RevitNotRunningError(
      `Revit (process ${info.pid}) is no longer running; the connection file at ${connectionPath} is left over from it. Ask the user to start Revit and wait until it has loaded, then try again.`,
    );
  }

  return info;
}

function parse(text: string): ConnectionInfo | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }

  if (typeof value !== "object" || value === null) {
    return null;
  }

  const { port, token, pid, protocolVersion } = value as Record<string, unknown>;
  if (
    typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535 ||
    typeof token !== "string" || token.length === 0 ||
    typeof pid !== "number" || !Number.isInteger(pid) || pid < 1
  ) {
    return null;
  }

  return { port, token, pid, protocolVersion: typeof protocolVersion === "number" ? protocolVersion : 0 };
}
