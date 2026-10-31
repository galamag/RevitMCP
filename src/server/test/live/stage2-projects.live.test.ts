import assert from "node:assert/strict";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { checkCanClose, defaultTestFolder } from "../../src/cli/closeRule.ts";
import { BridgeClient } from "../../src/client.ts";
import { defaultConnectionPath } from "../../src/connection.ts";
import { BridgeRpcError } from "../../src/errors.ts";

// These tests need a running Revit with the RevitMCP plugin loaded. Each run creates one new project in the test
// folder and leaves it open and saved. There is no close tool, so projects stay open until Revit restarts.
// One run cannot restart Revit, so the reopen check is a second run: the first prints the name to set in
// REVITMCP_REOPEN_NAME, then restart with scripts/restart-revit.ps1 and run again.

interface OpenDocument {
  title: string;
  path: string;
  isModified: boolean;
}

interface ModelInfo {
  activeDocument: OpenDocument | null;
  openDocuments: OpenDocument[];
}

interface ProjectResult {
  name: string;
  path: string;
  alreadyOpen?: boolean;
  isModified?: boolean;
  dialogs: unknown[];
}

const INVALID_PARAMS = -32602;

const folder = defaultTestFolder();
const documents = path.win32.dirname(folder);
const stamp = new Date().toTimeString().slice(0, 8).replaceAll(":", "");
const name = `проверка-задача9-${stamp}`;
const file = path.win32.join(folder, `${name}.rvt`);
const reopenName = process.env["REVITMCP_REOPEN_NAME"];

const codes = (text: string): number[] => [...text].map((character) => character.codePointAt(0) ?? -1);

/** What is on disk: enough to see a file appear, go or change. */
function listing(directory: string): string[] {
  return readdirSync(directory)
    .map((entry) => {
      const stats = statSync(path.win32.join(directory, entry));
      return `${entry} ${stats.size} ${stats.mtimeMs}`;
    })
    .sort();
}

async function withClient<T>(body: (client: BridgeClient) => Promise<T>): Promise<T> {
  const client = new BridgeClient(defaultConnectionPath());
  try {
    return await body(client);
  } finally {
    client.close();
  }
}

const modelInfo = (client: BridgeClient): Promise<ModelInfo> => client.call("get_model_info", {}) as Promise<ModelInfo>;

/** Calls a method that must refuse, and returns the refusal. */
async function refusal(client: BridgeClient, method: string, params: object): Promise<BridgeRpcError> {
  const error = await client.call(method, params).then(
    (result) => assert.fail(`${method} ${JSON.stringify(params)} should be refused, and returned ${JSON.stringify(result)}`),
    (reason: unknown) => reason,
  );

  assert.ok(error instanceof BridgeRpcError, `${method}: expected a plugin error, got ${String(error)}`);
  return error;
}

describe("stage 2 live checks: projects", { timeout: 120_000 }, () => {
  it("save_project with nothing open refuses with no_active_document", async (t) => {
    await withClient(async (client) => {
      if ((await modelInfo(client)).activeDocument !== null) {
        t.skip("a project is active, so this needs a Revit that was just started");
        return;
      }

      const refused = await refusal(client, "save_project", {});

      assert.match(String((refused.data as { pluginMessage?: string } | undefined)?.pluginMessage), /^no_active_document/);
    });
  });

  it("reopens after a restart with the name intact", { skip: reopenName === undefined }, async () => {
    const reopened = reopenName as string;
    await withClient(async (client) => {
      const result = (await client.call("open_project", { name: reopened })) as ProjectResult;
      console.log(`# open_project after restart: ${JSON.stringify(result)}`);

      assert.equal(result.alreadyOpen, false);
      assert.equal(result.name, reopened);
      assert.equal(result.path, path.win32.join(folder, `${reopened}.rvt`));

      const info = await modelInfo(client);
      assert.deepEqual(codes(info.activeDocument?.title ?? ""), codes(reopened));
      assert.equal(info.activeDocument?.path, result.path);
    });
  });

  it("create_project makes a Cyrillic project active", async () => {
    await withClient(async (client) => {
      const started = performance.now();
      const result = (await client.call("create_project", { name })) as ProjectResult;
      console.log(`# create_project took ${((performance.now() - started) / 1000).toFixed(1)} s: ${JSON.stringify(result)}`);

      assert.equal(result.name, name);
      assert.equal(result.path, file);
      assert.deepEqual(result.dialogs, []);
      assert.ok(existsSync(file), "the file must be on disk under its Cyrillic name");
      assert.ok(readdirSync(folder).includes(`${name}.rvt`));

      const info = await modelInfo(client);
      assert.deepEqual(codes(info.activeDocument?.title ?? ""), codes(name));
      assert.equal(info.activeDocument?.path, file);
      assert.equal(info.activeDocument?.isModified, false);
    });
  });

  it("create_project refuses a name that exists and overwrites nothing", async () => {
    await withClient(async (client) => {
      const before = listing(folder);
      const open = (await modelInfo(client)).openDocuments.length;

      for (const taken of [name, `${name}.rvt`, name.toUpperCase()]) {
        const refused = await refusal(client, "create_project", { name: taken });
        assert.equal(refused.code, INVALID_PARAMS);
        assert.match(refused.message, /already exists/);
      }

      assert.deepEqual(listing(folder), before);
      assert.equal((await modelInfo(client)).openDocuments.length, open);
    });
  });

  it("save_project saves the active project, with and without a name", async () => {
    await withClient(async (client) => {
      for (const params of [{}, { name }]) {
        const before = readdirSync(folder);
        const result = (await client.call("save_project", params)) as ProjectResult;
        console.log(`# save_project ${JSON.stringify(params)}: ${JSON.stringify(result)}, new files: ${JSON.stringify(readdirSync(folder).filter((entry) => !before.includes(entry)))}`);

        assert.equal(result.name, name);
        assert.equal(result.path, file);
        assert.deepEqual(result.dialogs, []);
      }

      const info = await modelInfo(client);
      assert.equal(info.activeDocument?.isModified, false);
    });
  });

  it("save_project refuses a name that is not the active project", async () => {
    await withClient(async (client) => {
      const before = listing(folder);

      const refused = await refusal(client, "save_project", { name: `${name}-другой` });

      assert.equal(refused.code, INVALID_PARAMS);
      assert.match(refused.message, /^no_active_document/);
      assert.deepEqual(listing(folder), before);
    });
  });

  it("open_project on an open project activates it and adds no document", async () => {
    await withClient(async (client) => {
      const before = await modelInfo(client);

      const result = (await client.call("open_project", { name })) as ProjectResult;
      console.log(`# open_project while open: ${JSON.stringify(result)}`);

      assert.equal(result.alreadyOpen, true);
      assert.equal(result.isModified, false);
      assert.equal(result.path, file);

      const after = await modelInfo(client);
      assert.equal(after.openDocuments.length, before.openDocuments.length);
      assert.equal(after.openDocuments.filter((document) => document.path === file).length, 1);
      assert.equal(after.activeDocument?.path, file);
    });
  });

  it("open_project switches between open projects, and save_project refuses the one that is not active", { skip: reopenName === undefined }, async () => {
    const other = reopenName as string;
    await withClient(async (client) => {
      const before = listing(folder);

      const switched = (await client.call("open_project", { name: other })) as ProjectResult;
      assert.equal(switched.alreadyOpen, true);
      assert.deepEqual(codes((await modelInfo(client)).activeDocument?.title ?? ""), codes(other));

      const refused = await refusal(client, "save_project", { name });
      assert.equal(refused.code, INVALID_PARAMS);
      assert.match(refused.message, /^no_active_document/);
      console.log(`# save_project on the project that is not active: ${refused.message}`);
      assert.deepEqual(listing(folder), before);

      const back = (await client.call("open_project", { name })) as ProjectResult;
      assert.equal(back.alreadyOpen, true);
      assert.equal((await modelInfo(client)).activeDocument?.path, file);
    });
  });

  it("open_project refuses a project that does not exist", async () => {
    await withClient(async (client) => {
      const refused = await refusal(client, "open_project", { name: `${name}-нет` });

      assert.equal(refused.code, INVALID_PARAMS);
      assert.match(refused.message, /does not exist/);
    });
  });

  it("every tool refuses to leave the test folder and the disk stays as it was", async () => {
    await withClient(async (client) => {
      const escapes = [
        "..\\x",
        "../x",
        "..\\..\\x",
        path.win32.join(documents, "x.rvt"),
        path.win32.join(folder, "x.rvt"),
        "C:\\Temp\\x.rvt",
        "D:\\x.rvt",
        "\\\\server\\share\\x.rvt",
        "x.rte",
        "CON",
        "x.",
        "я".repeat(300),
        "",
      ];
      const before = [listing(folder), listing(documents)];
      const open = await modelInfo(client);

      for (const method of ["create_project", "open_project", "save_project"]) {
        for (const escape of escapes) {
          const refused = await refusal(client, method, { name: escape });
          assert.equal(refused.code, INVALID_PARAMS, `${method} ${escape}: ${refused.message}`);
        }
      }

      assert.deepEqual([listing(folder), listing(documents)], before);
      assert.ok(!existsSync(path.win32.join(documents, "x.rvt")));
      assert.deepEqual((await modelInfo(client)).openDocuments.map((document) => document.path), open.openDocuments.map((document) => document.path));
    });
  });

  it("leaves Revit in a state the close rule accepts", async () => {
    await withClient(async (client) => {
      assert.deepEqual(checkCanClose((await modelInfo(client)).openDocuments), { ok: true, reasons: [] });
      console.log(`# to check the reopen after a restart, set REVITMCP_REOPEN_NAME=${name}`);
    });
  });
});
