import { open, realpath } from "node:fs/promises";
import path from "node:path";

import { isInsideFolder } from "./cli/closeRule.ts";
import { defaultConnectionPath } from "./connection.ts";
import { SnapshotError } from "./errors.ts";
import type { ToolContent } from "./registry.ts";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** What the plugin answers to `get_view_snapshot`, as far as this server reads it. */
interface SnapshotAnswer {
  path?: unknown;
}

/**
 * The largest file sent to a client, as a guard: a client may refuse a larger image. An MCP image travels as base64, a
 * third larger than the file, and the strictest platform in Claude's vision guide takes 5 MB of base64 per image. For
 * one scene Revit made 2.17 MB at a width of 3000 pixels and 4.84 MB at 4096, so the size depends on the view.
 */
export const MAX_SNAPSHOT_BYTES = (5 * 1024 * 1024 * 3) / 4;

/** `%LOCALAPPDATA%\RevitMCP\snapshots`, beside connection.json. The plugin exports here, and this server reads nothing else. */
export function defaultSnapshotFolder(): string {
  return path.join(path.dirname(defaultConnectionPath()), "snapshots");
}

/**
 * Reads the PNG the plugin named. The path arrives over a socket, so it is not trusted: it must be inside `folder` both
 * as written and as the disk resolves it, which a junction inside the folder could otherwise change.
 *
 * @throws SnapshotError The file is outside the folder, gone, too large or not a PNG.
 */
export async function readSnapshot(file: unknown, folder: string = defaultSnapshotFolder()): Promise<Buffer> {
  if (typeof file !== "string" || !path.win32.isAbsolute(file)) {
    throw new SnapshotError("The plugin did not answer with a full path to the snapshot.");
  }
  if (!isInsideFolder(file, folder)) {
    throw outside(file, folder);
  }
  if (path.win32.extname(file).toLowerCase() !== ".png") {
    throw notPng(file);
  }

  const real = await resolve(file);
  if (!isInsideFolder(real, await resolve(folder))) {
    throw outside(file, folder);
  }

  const image = await readLimited(real);
  if (!image.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw notPng(file);
  }
  return image;
}

/** Builds the tool content: the image first, then the plugin's answer with the file size, for anything but pixels. */
export function presentSnapshot(folder: string = defaultSnapshotFolder()): (answer: unknown) => Promise<ToolContent[]> {
  return async (answer) => {
    const fields = (typeof answer === "object" && answer !== null ? answer : {}) as SnapshotAnswer;
    const image = await readSnapshot(fields.path, folder);

    return [
      { type: "image", data: image.toString("base64"), mimeType: "image/png" },
      { type: "text", text: JSON.stringify({ ...fields, sizeBytes: image.length }) },
    ];
  };
}

async function resolve(target: string): Promise<string> {
  try {
    return await realpath(target);
  } catch (error) {
    throw new SnapshotError(`The snapshot ${target} cannot be read: ${(error as NodeJS.ErrnoException).code ?? "unknown error"}.`, { cause: error });
  }
}

/** Reads through one handle, so the size that was checked belongs to the bytes that are read. */
async function readLimited(file: string): Promise<Buffer> {
  let handle;
  try {
    handle = await open(file, "r");
  } catch (error) {
    throw new SnapshotError(`The snapshot ${file} cannot be opened: ${(error as NodeJS.ErrnoException).code ?? "unknown error"}.`, { cause: error });
  }
  try {
    const { size } = await handle.stat();
    if (size > MAX_SNAPSHOT_BYTES) {
      throw new SnapshotError(
        `The snapshot takes ${size} bytes, more than the ${MAX_SNAPSHOT_BYTES} that is sent, as a client may refuse a larger image. It stays at ${file}. Ask again with a smaller widthPx.`,
      );
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

function outside(file: string, folder: string): SnapshotError {
  return new SnapshotError(`The plugin named a snapshot outside ${folder}, so it was not read: ${file}`);
}

function notPng(file: string): SnapshotError {
  return new SnapshotError(`The file the plugin named is not a PNG, so it was not read: ${file}`);
}
