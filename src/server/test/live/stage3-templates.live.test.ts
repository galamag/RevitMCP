import assert from "node:assert/strict";
import { chmodSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { checkCanClose, defaultTestFolder } from "../../src/cli/closeRule.ts";
import { BridgeClient } from "../../src/client.ts";
import { defaultConnectionPath } from "../../src/connection.ts";
import { BridgeRpcError } from "../../src/errors.ts";
import { undoWithOneRetry } from "../undoRetry.ts";

// These tests need a running Revit with the RevitMCP plugin loaded. Each run creates one source project, saves two
// templates (.rte) from it and makes three new projects, two from those templates and one from the stock template. All of
// them stay open and saved, and nothing in the test folder is ever deleted, so every name carries a stamp. The one
// exception is the text file that stands in for a template Revit cannot read: it has a fixed name, is written once and reused.
//
// Not driven here: the failure of the save back to the .rvt, which leaves the document on the .rte, and a template that is open
// as a document, and so save_project refusing a document that is on a .rte. No tool closes a document, so provoking any of
// them would leave Revit in a state only a person can end. The words of those failures are unit tested in
// TemplateSaveFailureTests, and the rule that save_project needs a .rvt in TestFolderTests. The one failure that is easy to
// predict, a read-only .rvt, is refused before anything is written, and that refusal is driven.

interface OpenDocument {
  title: string;
  path: string;
  isModified: boolean;
}

interface ModelInfo {
  activeDocument: OpenDocument | null;
  openDocuments: OpenDocument[];
  levels: Array<{ id: string; name: string; elevationMm: number }>;
}

interface ProjectResult {
  name: string;
  path: string;
  dialogs: unknown[];
}

interface TemplateResult extends ProjectResult {
  templatePath: string;
  isModified: boolean;
}

interface TypeRow {
  id: string;
  family: string;
  name: string;
}

interface MaterialRow {
  id: string;
  name: string;
  color: { r: number; g: number; b: number } | null;
}

interface Item {
  index: number;
  status: string;
  elementId: string | null;
  error: string | null;
}

interface Batch {
  committed: boolean;
  items: Item[];
  errors: string[];
  dialogs: unknown[];
}

interface WallRow {
  id: string;
  typeName: string | null;
}

interface FileState {
  size: number;
  mtimeMs: number;
}

const INVALID_PARAMS = -32602;
const MIN_TEMPLATE_BYTES = 1_000_000;
const WALL_LENGTH_MM = 3000;
const WALL_HEIGHT_MM = 3000;
const RED = { r: 200, g: 30, b: 30 };

const folder = defaultTestFolder();
const documents = path.win32.dirname(folder);
const now = new Date();
const stamp = `${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}-${now.toTimeString().slice(0, 8).replaceAll(":", "")}`;

const sourceName = `проверка-шаблоны-источник-${stamp}`;
const firstTemplateName = `проверка-шаблон-стена-${stamp}`;
const secondTemplateName = `проверка-шаблон-две-стены-${stamp}`;
const fromFirstName = `проверка-шаблоны-из-стены-${stamp}`;
const fromSecondName = `проверка-шаблоны-из-двух-${stamp}`;
const plainName = `проверка-шаблоны-стандарт-${stamp}`;
/** One fixed name for the text file that stands in for a template Revit cannot read, so that runs share it and none adds another. */
const brokenTemplateName = "проверка-шаблон-битый";
const brokenTemplateText = "This is not a Revit template.\n";
const brokenProjectName = `проверка-шаблоны-битый-проект-${stamp}`;
const afterRestartName = `проверка-шаблоны-после-перезапуска-${stamp}`;
const earlierTemplate = process.env["REVITMCP_TEMPLATE_NAME"];
const typeName = `Шаблон-стена ${stamp}`;
const materialName = `Шаблон-материал ${stamp}`;

const projectFile = (name: string): string => path.win32.join(folder, `${name}.rvt`);
const templateFile = (name: string): string => path.win32.join(folder, `${name}.rte`);

let groundId: string | undefined;
let customTypeId: string | undefined;
let customMaterialId: string | undefined;
let firstWallId: string | undefined;
let secondWallId: string | undefined;

async function withClient<T>(body: (client: BridgeClient) => Promise<T>): Promise<T> {
  const client = new BridgeClient(defaultConnectionPath());
  try {
    return await body(client);
  } finally {
    client.close();
  }
}

const modelInfo = (client: BridgeClient): Promise<ModelInfo> => client.call("get_model_info", {}) as Promise<ModelInfo>;

const listTypes = (client: BridgeClient, category: string): Promise<TypeRow[]> => client.call("list_types", { category }) as Promise<TypeRow[]>;

const listMaterials = (client: BridgeClient): Promise<MaterialRow[]> => client.call("list_materials", {}) as Promise<MaterialRow[]>;

async function walls(client: BridgeClient): Promise<WallRow[]> {
  const answer = (await client.call("get_elements", { category: "walls" })) as { elements: WallRow[]; truncated: boolean };
  assert.equal(answer.truncated, false);
  return answer.elements;
}

/** What is on disk: enough to see a file appear, go or change. */
function listing(directory: string): string[] {
  return readdirSync(directory)
    .map((entry) => {
      const stats = statSync(path.win32.join(directory, entry));
      return `${entry} ${stats.size} ${stats.mtimeMs}`;
    })
    .sort();
}

function fileState(file: string): FileState {
  const stats = statSync(file);
  return { size: stats.size, mtimeMs: stats.mtimeMs };
}

/** Calls a method that must be refused, and returns the refusal. */
async function refusal(client: BridgeClient, method: string, params: object): Promise<BridgeRpcError> {
  const error = await client.call(method, params).then(
    (result) => assert.fail(`${method} ${JSON.stringify(params).slice(0, 300)} should be refused, and returned ${JSON.stringify(result).slice(0, 500)}`),
    (reason: unknown) => reason,
  );

  assert.ok(error instanceof BridgeRpcError, `${method}: expected a plugin error, got ${String(error)}`);
  return error;
}

function createdId(batch: Batch): string {
  assert.equal(batch.committed, true, JSON.stringify(batch).slice(0, 1500));
  assert.deepEqual(batch.errors, []);
  assert.deepEqual(batch.dialogs, []);
  assert.equal(batch.items.length, 1);

  const [item] = batch.items;
  assert.ok(item, JSON.stringify(batch).slice(0, 500));
  assert.equal(item.status, "created", JSON.stringify(item));
  assert.ok(item.elementId, JSON.stringify(item));
  return item.elementId;
}

function ready<T>(value: T | undefined, what: string): T {
  assert.ok(value !== undefined, `${what} comes from an earlier test`);
  return value;
}

/** One wall of the custom type, 3 m long, with its start at y. */
async function buildWall(client: BridgeClient, y: number): Promise<string> {
  return createdId(
    (await client.call("create_walls", {
      items: [
        {
          startMm: { x: 0, y },
          endMm: { x: WALL_LENGTH_MM, y },
          typeId: ready(customTypeId, "the custom type"),
          levelId: ready(groundId, "the ground level"),
          heightMm: WALL_HEIGHT_MM,
        },
      ],
    })) as Batch,
  );
}

const paths = (info: ModelInfo): string[] => info.openDocuments.map((document) => document.path);

/** The project the tool was called for is still the active document, on its .rvt, and no template is open as a document. */
function assertStaysOnProject(after: ModelInfo, before: ModelInfo): void {
  assert.equal(after.activeDocument?.path, before.activeDocument?.path);
  assert.equal(after.activeDocument?.title, before.activeDocument?.title);
  assert.match(after.activeDocument?.path ?? "", /\.rvt$/i);
  assert.deepEqual(paths(after), paths(before));
  assert.deepEqual(
    paths(after).filter((file) => /\.rte$/i.test(file)),
    [],
    "no template may stay open as a document",
  );
}

describe("stage 3 live checks: project templates", { timeout: 900_000 }, () => {
  it("creates the source project for this run", async () => {
    await withClient(async (client) => {
      const result = (await client.call("create_project", { name: sourceName })) as ProjectResult;
      assert.equal(result.path, projectFile(sourceName));

      const info = await modelInfo(client);
      assert.equal(info.activeDocument?.title, sourceName);
      groundId = info.levels.find((level) => level.elevationMm === 0)?.id;
      assert.ok(groundId, `no level at the origin in ${JSON.stringify(info.levels)}`);
    });
  });

  it("template keeps a created wall type", async () => {
    await withClient(async (client) => {
      const base = (await listTypes(client, "walls")).find((row) => /^Наружный - Стена из бруса толщиной 180 мм/.test(row.name));
      assert.ok(base, "the stock template has no wall type to copy");

      customMaterialId = createdId((await client.call("create_materials", { items: [{ name: materialName, colorRgb: RED }] })) as Batch);
      customTypeId = createdId(
        (await client.call("create_type", {
          items: [{ category: "walls", baseTypeId: base.id, name: typeName, layers: [{ thicknessMm: 200, materialId: customMaterialId, function: "structure" }] }],
        })) as Batch,
      );
      firstWallId = await buildWall(client, 0);

      // The changes above are not saved: the template must still carry them, and the project must come out saved.
      const before = await modelInfo(client);
      assert.equal(before.activeDocument?.isModified, true);
      const projectBefore = fileState(projectFile(sourceName));
      const folderBefore = readdirSync(folder);

      const started = performance.now();
      const result = (await client.call("save_project_template", { name: firstTemplateName })) as TemplateResult;
      console.log(`# save_project_template took ${((performance.now() - started) / 1000).toFixed(1)} s: ${JSON.stringify(result)}`);
      console.log(`# new files in the test folder: ${JSON.stringify(readdirSync(folder).filter((entry) => !folderBefore.includes(entry)))}`);

      assert.equal(result.name, sourceName);
      assert.equal(result.path, projectFile(sourceName));
      assert.equal(result.templatePath, templateFile(firstTemplateName));
      assert.equal(result.isModified, false);
      assert.deepEqual(result.dialogs, []);

      assert.ok(existsSync(templateFile(firstTemplateName)), "the .rte must be on disk under its Cyrillic name");
      assert.ok(readdirSync(folder).includes(`${firstTemplateName}.rte`));
      assert.ok(fileState(templateFile(firstTemplateName)).size > MIN_TEMPLATE_BYTES, "a template is a whole project file");
      assert.ok(fileState(projectFile(sourceName)).mtimeMs > projectBefore.mtimeMs, "the .rvt now holds the changes that were not saved");

      assertStaysOnProject(await modelInfo(client), before);
      assert.ok((await listTypes(client, "walls")).some((row) => row.id === customTypeId), "the source project still has its type");
    });
  });

  it("active project stays on its rvt after saving a template", async (t) => {
    await withClient(async (client) => {
      secondWallId = await buildWall(client, 5000);
      const before = await modelInfo(client);
      assert.equal(before.activeDocument?.isModified, true);
      const firstTemplate = fileState(templateFile(firstTemplateName));
      const projectBefore = fileState(projectFile(sourceName));

      // The .rte ending is accepted and is not doubled.
      const result = (await client.call("save_project_template", { name: `${secondTemplateName}.rte` })) as TemplateResult;
      assert.equal(result.templatePath, templateFile(secondTemplateName));
      assert.equal(result.path, projectFile(sourceName));
      assert.equal(result.isModified, false);

      const after = await modelInfo(client);
      assertStaysOnProject(after, before);
      assert.equal(after.activeDocument?.isModified, false);
      assert.ok(fileState(projectFile(sourceName)).mtimeMs > projectBefore.mtimeMs, "the .rvt was saved by the second template too");
      assert.deepEqual(fileState(templateFile(firstTemplateName)), firstTemplate, "the first template is not touched by the second");
      assert.ok(after.levels.some((level) => level.id === groundId), "get_model_info still reads the same document");

      // save_project must write into the .rvt and leave both templates alone.
      const secondTemplate = fileState(templateFile(secondTemplateName));
      const saved = (await client.call("save_project", {})) as ProjectResult;
      assert.equal(saved.path, projectFile(sourceName));
      assert.deepEqual(fileState(templateFile(secondTemplateName)), secondTemplate);
      assert.deepEqual(fileState(templateFile(firstTemplateName)), firstTemplate);

      // Undo still finds the step of the document across two SaveAs round trips.
      const undone = await undoWithOneRetry(t, client);
      console.log(`# undo after two templates: ${JSON.stringify(undone)}`);
      assert.equal(undone.state, "undone", JSON.stringify(undone));
      assert.equal(undone.transactionName, "MCP: create_walls");
      assert.ok(undone.createdIds.includes(ready(secondWallId, "the second wall")));
      assert.deepEqual((await walls(client)).map((wall) => wall.id), [firstWallId]);

      const undoneInfo = await modelInfo(client);
      assert.equal(undoneInfo.activeDocument?.title, sourceName);
      assert.equal(undoneInfo.activeDocument?.isModified, true, "an undo is a change that is not saved");
      await client.call("save_project", {});
      assert.equal((await modelInfo(client)).activeDocument?.isModified, false);
    });
  });

  it("existing template name is refused", async () => {
    await withClient(async (client) => {
      const first = fileState(templateFile(firstTemplateName));
      const second = fileState(templateFile(secondTemplateName));
      const before = await modelInfo(client);
      const folderBefore = listing(folder);

      for (const taken of [firstTemplateName, `${firstTemplateName}.rte`, firstTemplateName.toUpperCase(), secondTemplateName]) {
        const refused = await refusal(client, "save_project_template", { name: taken });
        assert.equal(refused.code, INVALID_PARAMS, refused.message);
        assert.match(refused.message, /already exists/);
      }

      assert.deepEqual(fileState(templateFile(firstTemplateName)), first);
      assert.deepEqual(fileState(templateFile(secondTemplateName)), second);
      assert.deepEqual(listing(folder), folderBefore);
      assertStaysOnProject(await modelInfo(client), before);
    });
  });

  it("a read-only project file is refused before anything is written", async () => {
    await withClient(async (client) => {
      const file = projectFile(sourceName);
      const before = await modelInfo(client);
      const folderBefore = listing(folder);

      // Revit cannot save back over a read-only file, which would leave the document on the template.
      chmodSync(file, 0o444);
      try {
        const refused = await refusal(client, "save_project_template", { name: `${firstTemplateName}-только-чтение` });
        console.log(`# save_project_template with a read-only project file: ${refused.message}`);
        assert.match(refused.message, /read-only/);
        assert.equal(refused.code, -32603);
        assert.ok(!existsSync(templateFile(`${firstTemplateName}-только-чтение`)), "no template may be written");
      } finally {
        chmodSync(file, 0o666);
      }

      assert.deepEqual(listing(folder), folderBefore);
      assertStaysOnProject(await modelInfo(client), before);
    });
  });

  it("template names cannot leave the test folder", async () => {
    await withClient(async (client) => {
      const before = await modelInfo(client);
      const escapes = [
        "..\\x",
        "../x",
        "..\\..\\x",
        path.win32.join(documents, "x.rte"),
        path.win32.join(folder, "x.rte"),
        "C:\\Temp\\x.rte",
        "D:\\x.rte",
        "\\\\server\\share\\x.rte",
        `${sourceName}.rvt`,
        "x.rvt",
        "x.txt",
        "CON",
        "x.",
        "я".repeat(300),
        "",
      ];
      const disk = [listing(folder), listing(documents)];

      for (const escape of escapes) {
        const refused = await refusal(client, "save_project_template", { name: escape });
        assert.equal(refused.code, INVALID_PARAMS, `save_project_template ${escape}: ${refused.message}`);

        const asTemplate = await refusal(client, "create_project", { name: `${sourceName}-граница`, templateName: escape });
        assert.equal(asTemplate.code, INVALID_PARAMS, `create_project with templateName ${escape}: ${asTemplate.message}`);
      }

      // A name that is not text never reaches Revit either, and the MCP server does not stand in front of this socket.
      for (const notText of [5, null, ["x"], {}]) {
        const asName = await refusal(client, "save_project_template", { name: notText });
        assert.equal(asName.code, INVALID_PARAMS, `save_project_template name ${JSON.stringify(notText)}: ${asName.message}`);

        const asTemplate = await refusal(client, "create_project", { name: `${sourceName}-граница`, templateName: notText });
        assert.equal(asTemplate.code, INVALID_PARAMS, `create_project templateName ${JSON.stringify(notText)}: ${asTemplate.message}`);
        assert.match(asTemplate.message, /needs a text templateName/);
      }
      assert.equal((await refusal(client, "save_project_template", {})).code, INVALID_PARAMS);

      assert.deepEqual([listing(folder), listing(documents)], disk);
      assert.ok(!existsSync(projectFile(`${sourceName}-граница`)), "a refused create_project must leave no project");
      assertStaysOnProject(await modelInfo(client), before);
    });
  });

  it("unknown template is refused", async () => {
    await withClient(async (client) => {
      const before = await modelInfo(client);
      const folderBefore = listing(folder);
      const projectName = `${plainName}-нет-шаблона`;

      for (const unknown of [`${firstTemplateName}-нет`, sourceName, `${sourceName}.rte`]) {
        const refused = await refusal(client, "create_project", { name: projectName, templateName: unknown });
        console.log(`# create_project with the template ${unknown}: ${refused.message}`);
        assert.equal(refused.code, INVALID_PARAMS, refused.message);
        assert.match(refused.message, /does not exist/);
        assert.match(refused.message, /save_project_template/);
      }

      assert.ok(!existsSync(projectFile(projectName)));
      assert.deepEqual(listing(folder), folderBefore);
      assertStaysOnProject(await modelInfo(client), before);
    });
  });

  it("new project from the template has that type", async () => {
    await withClient(async (client) => {
      const template = fileState(templateFile(firstTemplateName));
      const openBefore = (await modelInfo(client)).openDocuments.length;

      const result = (await client.call("create_project", { name: fromFirstName, templateName: firstTemplateName })) as ProjectResult;
      console.log(`# create_project from the template: ${JSON.stringify(result)}`);
      assert.equal(result.name, fromFirstName);
      assert.equal(result.path, projectFile(fromFirstName));
      assert.deepEqual(result.dialogs, []);
      assert.ok(existsSync(projectFile(fromFirstName)));

      const info = await modelInfo(client);
      assert.equal(info.activeDocument?.path, projectFile(fromFirstName));
      assert.equal(info.activeDocument?.isModified, false);
      assert.equal(info.openDocuments.length, openBefore + 1);
      assert.ok(info.levels.some((level) => level.elevationMm === 0));

      const type = (await listTypes(client, "walls")).find((row) => row.name === typeName);
      assert.ok(type, `the new project has no wall type '${typeName}'`);
      console.log(`# the type in the source has id ${String(customTypeId)}, in the new project ${type.id}`);

      const material = (await listMaterials(client)).find((row) => row.name === materialName);
      assert.ok(material, `the new project has no material '${materialName}'`);
      assert.deepEqual(material.color, RED);

      // The whole model comes with it: the wall that stood in the source when the template was saved.
      const inside = await walls(client);
      assert.equal(inside.length, 1, "a template saved from a project with a wall brings that wall");
      assert.equal(inside[0]?.typeName, typeName);

      assert.deepEqual(fileState(templateFile(firstTemplateName)), template, "using a template does not change it");
      assert.deepEqual(
        paths(info).filter((file) => /\.rte$/i.test(file)),
        [],
      );
    });
  });

  it("a template holds the project as it was when it was saved, unsaved changes included", async () => {
    await withClient(async (client) => {
      const result = (await client.call("create_project", { name: fromSecondName, templateName: secondTemplateName })) as ProjectResult;
      assert.equal(result.path, projectFile(fromSecondName));

      // The second wall was undone in the source after the template, so only the template still has it.
      const inside = await walls(client);
      assert.equal(inside.length, 2);
      assert.ok(inside.every((wall) => wall.typeName === typeName));
      assert.ok((await listTypes(client, "walls")).some((row) => row.name === typeName));
    });
  });

  it("a template from before a restart of Revit still starts a project", { skip: earlierTemplate === undefined }, async () => {
    await withClient(async (client) => {
      const info = await modelInfo(client);
      assert.equal(paths(info).includes(templateFile(earlierTemplate as string)), false, "the template is not open as a document");

      const result = (await client.call("create_project", { name: afterRestartName, templateName: earlierTemplate })) as ProjectResult;
      console.log(`# create_project from a template of an earlier run: ${JSON.stringify(result)}`);
      assert.equal(result.path, projectFile(afterRestartName));
      assert.deepEqual(result.dialogs, []);

      assert.ok((await listTypes(client, "walls")).some((row) => row.name.startsWith("Шаблон-стена ")), "the wall type of the earlier run is in the new project");
      assert.ok((await walls(client)).length >= 1, "the wall of the earlier run is in the new project");
    });
  });

  it("without templateName a new project starts from the stock template", async () => {
    await withClient(async (client) => {
      const result = (await client.call("create_project", { name: plainName })) as ProjectResult;
      assert.equal(result.path, projectFile(plainName));
      assert.deepEqual(result.dialogs, []);

      assert.deepEqual(await walls(client), []);
      assert.equal((await listTypes(client, "walls")).some((row) => row.name === typeName), false);
      assert.equal((await listMaterials(client)).some((row) => row.name === materialName), false);
    });
  });

  it("a template that Revit cannot read gives an error, opens nothing and makes no project", async () => {
    await withClient(async (client) => {
      // Written once: a file that is already there from an earlier run is kept and reused, and nothing overwrites it.
      try {
        writeFileSync(templateFile(brokenTemplateName), brokenTemplateText, { flag: "wx" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw error;
        }
      }
      assert.equal(readFileSync(templateFile(brokenTemplateName), "utf8"), brokenTemplateText, "the stand-in must still be the text file");
      const before = await modelInfo(client);
      const folderBefore = listing(folder);

      const refused = await refusal(client, "create_project", { name: brokenProjectName, templateName: brokenTemplateName });
      console.log(`# create_project with a text file as the template: code ${refused.code}, ${refused.message}`);
      assert.match(refused.message, /create_project failed/);

      assert.ok(!existsSync(projectFile(brokenProjectName)), "no project file may be left");
      assert.deepEqual(listing(folder), folderBefore);
      assertStaysOnProject(await modelInfo(client), before);
    });
  });

  it("leaves Revit in a state the close rule accepts", async () => {
    await withClient(async (client) => {
      await client.call("save_project", {});
      const info = await modelInfo(client);

      assert.deepEqual(checkCanClose(info.openDocuments), { ok: true, reasons: [] });
      assert.ok(paths(info).includes(projectFile(sourceName)));
      console.log(`# to check a template after a restart, set REVITMCP_TEMPLATE_NAME=${firstTemplateName}`);
    });
  });
});
