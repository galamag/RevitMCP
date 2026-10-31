import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { TestContext } from "node:test";

import { SnapshotError } from "../src/errors.ts";
import { MAX_SNAPSHOT_BYTES, defaultSnapshotFolder, presentSnapshot, readSnapshot } from "../src/snapshot.ts";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG = Buffer.concat([PNG_SIGNATURE, Buffer.from("rest of the image")]);

/** A temporary tree: `snapshots` is the folder under test, and `outside` is a neighbour that must stay out of reach. */
async function tree(t: TestContext): Promise<{ folder: string; outside: string; base: string }> {
  const base = await mkdtemp(path.join(tmpdir(), "revitmcp-snapshot-"));
  t.after(() => rm(base, { recursive: true, force: true }));

  const folder = path.join(base, "snapshots");
  const outside = path.join(base, "snapshots-evil");
  await mkdir(folder);
  await mkdir(outside);
  return { folder, outside, base };
}

async function refusal(promise: Promise<unknown>): Promise<SnapshotError> {
  const error = await promise.then(
    (value) => assert.fail(`expected a refusal, got ${String(value)}`),
    (reason: unknown) => reason,
  );

  assert.ok(error instanceof SnapshotError, `expected a SnapshotError, got ${String(error)}`);
  return error;
}

describe("snapshot files", () => {
  it("reads a PNG inside the folder, also under a Cyrillic name", async (t) => {
    const { folder } = await tree(t);
    const file = path.join(folder, "1 - 3D-вид - Фасад.png");
    await writeFile(file, PNG);

    assert.deepEqual(await readSnapshot(file, folder), PNG);
  });

  it("does not depend on the case of the path, as Windows does not", async (t) => {
    const { folder } = await tree(t);
    const file = path.join(folder, "a.png");
    await writeFile(file, PNG);

    assert.deepEqual(await readSnapshot(file.toUpperCase(), folder), PNG);
  });

  it("refuses a sibling folder whose name merely starts the same", async (t) => {
    const { folder, outside } = await tree(t);
    const file = path.join(outside, "a.png");
    await writeFile(file, PNG);

    const refused = await refusal(readSnapshot(file, folder));

    assert.match(refused.message, /outside/);
  });

  it("refuses a path that climbs out with dots", async (t) => {
    const { folder, base } = await tree(t);
    await writeFile(path.join(base, "a.png"), PNG);

    await refusal(readSnapshot(`${folder}\\..\\a.png`, folder));
    await refusal(readSnapshot(`${folder}\\x\\..\\..\\a.png`, folder));
  });

  it("refuses the folder itself, relative paths, other drives and network paths", async (t) => {
    const { folder } = await tree(t);

    for (const file of [folder, "a.png", "..\\a.png", "Z:\\snapshots\\a.png", "\\\\server\\share\\a.png", "\\\\?\\C:\\a.png"]) {
      await refusal(readSnapshot(file, folder));
    }
  });

  it("refuses a junction inside the folder that leads out of it", async (t) => {
    const { folder, outside } = await tree(t);
    await writeFile(path.join(outside, "a.png"), PNG);
    await symlink(outside, path.join(folder, "door"), "junction");

    const refused = await refusal(readSnapshot(path.join(folder, "door", "a.png"), folder));

    assert.match(refused.message, /outside/);
  });

  it("accepts a folder that is itself reached through a junction", async (t) => {
    const { folder, base } = await tree(t);
    const link = path.join(base, "link");
    await symlink(folder, link, "junction");
    await writeFile(path.join(folder, "a.png"), PNG);

    assert.deepEqual(await readSnapshot(path.join(link, "a.png"), link), PNG);
  });

  it("refuses a file that is not a PNG, by its extension and by its bytes", async (t) => {
    const { folder } = await tree(t);
    const text = path.join(folder, "a.txt");
    const fake = path.join(folder, "b.png");
    await writeFile(text, PNG);
    await writeFile(fake, "not an image");

    assert.match((await refusal(readSnapshot(text, folder))).message, /not a PNG/);
    assert.match((await refusal(readSnapshot(fake, folder))).message, /not a PNG/);
  });

  it("refuses an empty answer and a file that is gone", async (t) => {
    const { folder } = await tree(t);

    await refusal(readSnapshot(undefined, folder));
    await refusal(readSnapshot("", folder));
    assert.match((await refusal(readSnapshot(path.join(folder, "gone.png"), folder))).message, /gone\.png/);
  });

  it("refuses a file too large for an MCP client and says what to do", async (t) => {
    const { folder } = await tree(t);
    const file = path.join(folder, "big.png");
    await writeFile(file, Buffer.concat([PNG_SIGNATURE, Buffer.alloc(MAX_SNAPSHOT_BYTES)]));

    assert.match((await refusal(readSnapshot(file, folder))).message, /widthPx/);
  });

  it("keeps the image and the plugin's answer together in the tool content", async (t) => {
    const { folder } = await tree(t);
    const file = path.join(folder, "a.png");
    await writeFile(file, PNG);
    const answer = { viewId: "42", viewName: "Фасад", path: file, dialogs: [] };

    const [image, text] = await presentSnapshot(folder)(answer);

    assert.deepEqual(image, { type: "image", data: PNG.toString("base64"), mimeType: "image/png" });
    assert.equal(text?.type, "text");
    assert.deepEqual(JSON.parse((text as { text: string }).text), { ...answer, sizeBytes: PNG.length });
  });

  it("looks where the plugin writes", () => {
    assert.equal(defaultSnapshotFolder(), path.join(process.env["LOCALAPPDATA"] ?? "", "RevitMCP", "snapshots"));
  });
});
