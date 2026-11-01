import assert from "node:assert/strict";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";

import { checkCanClose } from "../../src/cli/closeRule.ts";
import { BridgeClient } from "../../src/client.ts";
import { defaultConnectionPath } from "../../src/connection.ts";
import { BridgeRpcError } from "../../src/errors.ts";
import { UndoNotConfirmedError, undoLastOperation, type UndoResult } from "../../src/undo.ts";
import { decodePng, meanColour, reportColours, type Band, type Pixels, type Region } from "../pngPixels.ts";

// These tests need a running Revit with the RevitMCP plugin loaded. Each run creates one new project in the test folder
// and leaves it open and saved. Colour is judged on snapshots, two ways: the pixels are read here, so a machine decides,
// and the PNGs are kept in the test folder, so a person or a model can look at them too.

interface Level {
  id: string;
  name: string;
  elevationMm: number;
}

interface ModelInfo {
  activeDocument: { title: string; isModified: boolean } | null;
  openDocuments: Array<{ title: string; path: string; isModified: boolean }>;
  levels: Level[];
}

interface TypeRow {
  id: string;
  family: string;
  name: string;
}

interface MaterialRow {
  id: string;
  name: string;
  materialClass: string;
  color: { r: number; g: number; b: number } | null;
  transparency: number;
}

interface Rgb {
  r: number;
  g: number;
  b: number;
}

interface MaterialActual {
  name: string;
  materialClass: string;
  colorRgb: Rgb | null;
  appearanceColorRgb: Rgb | null;
  transparency: number;
  appearanceTransparency: number | null;
  appearanceAssetId: string | null;
  useRenderAppearanceForShading: boolean;
}

interface LayerActual {
  thicknessMm: number;
  materialId: string | null;
  function: string;
}

interface TypeActual {
  category: string;
  family: string;
  name: string;
  widthMm: number | null;
  layers: LayerActual[] | null;
}

interface Item<A> {
  index: number;
  status: string;
  elementId: string | null;
  requested: unknown;
  actual: A | null;
  warnings: string[];
  error: string | null;
}

interface Batch<A> {
  committed: boolean;
  items: Array<Item<A>>;
  warnings: string[];
  errors: string[];
  dialogs: unknown[];
}

interface ElementRow {
  id: string;
  typeName: string | null;
  boundingBoxMm: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } } | null;
}

interface WallActual {
  widthMm: number;
  typeId: string;
}

/** What the tests share: the types and materials of the template, found by what the template calls them. */
interface World {
  ground: Level;
  wall: TypeRow;
  floor: TypeRow;
  roof: TypeRow;
  compoundCeiling: TypeRow;
  basicCeiling: TypeRow;
  curtainWall: TypeRow;
  glazedRoof: TypeRow;
  concrete: MaterialRow;
  plaster: MaterialRow;
  brick: MaterialRow;
  glass: MaterialRow;
}

const INVALID_PARAMS = -32602;
const NEAR_MM = 0.01;
const SNAPSHOT_WIDTH_PX = 1200;
const WALL_HEIGHT_MM = 3000;
const WALL_LENGTH_MM = 3000;
const WALL_PITCH_MM = 3500;
const CAMERA_DISTANCE_MM = 18000;
const CAMERA_HEIGHT_MM = 1500;

/** The undo tool refuses to post a second undo until a minute after an unconfirmed one, so that two never overlap. */
const UNDO_SETTLE_MS = 61_000;

const RED: Rgb = { r: 255, g: 0, b: 0 };
const GREEN: Rgb = { r: 0, g: 200, b: 0 };
const BLUE: Rgb = { r: 0, g: 0, b: 255 };

/**
 * Where three walls of a row show in a picture, measured on a first run: the camera stands 18 m off the middle of the row
 * and looks at it level. Each region lies well inside its wall, so all of it should be wall.
 */
const SLOTS: Readonly<Record<"left" | "middle" | "right", Region>> = {
  left: { left: 0.22, top: 0.42, right: 0.36, bottom: 0.58 },
  middle: { left: 0.43, top: 0.42, right: 0.57, bottom: 0.58 },
  right: { left: 0.64, top: 0.42, right: 0.78, bottom: 0.58 },
};

/** A region counts as showing a colour when almost all of its coloured pixels are of that band, and almost all of it is coloured. */
const MIN_BAND_SHARE = 0.95;
/** Realistic and Shading must differ at least this much in a channel on a wall of one colour. Measured: 33. */
const MIN_STYLE_DIFFERENCE = 10;
const MIN_COLOURED_SHARE = 0.9;

const stamp = new Date().toTimeString().slice(0, 8).replaceAll(":", "");
const name = `проверка-этап3-типы-${stamp}`;
const snapshotFolder = path.join(homedir(), "Documents", "RevitMCP", "task4-types");

let world: World | undefined;
/** Rows of walls stand this far apart in y, so no wall of one scene touches another. */
let nextRowY = 0;

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

const materials = (client: BridgeClient, items: unknown[]): Promise<Batch<MaterialActual>> =>
  client.call("create_materials", { items }) as Promise<Batch<MaterialActual>>;

const types = (client: BridgeClient, items: unknown[]): Promise<Batch<TypeActual>> => client.call("create_type", { items }) as Promise<Batch<TypeActual>>;

function ready(): World {
  assert.ok(world, "the first test reads the template");
  return world;
}

/** Calls a method that must refuse, and returns the refusal. */
async function refusal(client: BridgeClient, method: string, params: object): Promise<BridgeRpcError> {
  const error = await client.call(method, params).then(
    (result) => assert.fail(`${method} ${JSON.stringify(params).slice(0, 300)} should be refused, and returned ${JSON.stringify(result).slice(0, 500)}`),
    (reason: unknown) => reason,
  );

  assert.ok(error instanceof BridgeRpcError, `${method}: expected a plugin error, got ${String(error)}`);
  assert.equal(error.code, INVALID_PARAMS, error.message);
  return error;
}

function assertLanded<A>(batch: Batch<A>): void {
  assert.equal(batch.committed, true, JSON.stringify(batch).slice(0, 1500));
  assert.deepEqual(batch.errors, []);
  assert.deepEqual(batch.dialogs, []);
  assert.deepEqual(batch.warnings, [], "nothing here should give Revit something to warn about");
}

function created<A>(batch: Batch<A>): Array<{ id: string; actual: A }> {
  assertLanded(batch);

  return batch.items.map((item) => {
    assert.equal(item.status, "created", JSON.stringify(item));
    assert.ok(item.elementId && item.actual, JSON.stringify(item));
    return { id: item.elementId, actual: item.actual };
  });
}

function assertNear(actual: unknown, expected: number, what: string, within = NEAR_MM): void {
  assert.equal(typeof actual, "number", what);
  assert.ok(Math.abs((actual as number) - expected) < within, `${what}: ${String(actual)}, expected ${expected}`);
}

const materialNamed = (rows: MaterialRow[], exact: string): MaterialRow => {
  const found = rows.find((row) => row.name === exact);
  assert.ok(found, `the template has no material named '${exact}'`);
  return found;
};

const typeNamed = (rows: TypeRow[], pattern: RegExp): TypeRow => {
  const found = rows.find((row) => pattern.test(row.name));
  assert.ok(found, `no type matches ${pattern}`);
  return found;
};

async function isModified(client: BridgeClient): Promise<boolean> {
  const active = (await modelInfo(client)).activeDocument;
  assert.ok(active);
  return active.isModified;
}

/**
 * Undoes the last operation. Revit itself now and then refuses the Undo that was posted to it: its journal says `API queue
 * command ID_BUTTON_UNDO cannot be invoked in this context`, and the tool answers `Not undone`, with the model as it was.
 * It came in windows of time and for every tool tried (create_walls, create_type, create_materials), also in the stage 2
 * undo tests, and the cause is not known. So this posts the undo once more after the minute the tool asks for. Before it
 * does, it asks what became of the first post, as an undo that ran late must not be posted again. The retry is written to
 * the result of the test.
 */
async function undoWithOneRetry(t: TestContext, client: BridgeClient): Promise<UndoResult> {
  try {
    return await undoLastOperation(client);
  } catch (error) {
    if (!(error instanceof UndoNotConfirmedError) || !error.message.startsWith("Not undone")) {
      throw error;
    }

    await new Promise((resolve) => setTimeout(resolve, UNDO_SETTLE_MS));
    const first = (await client.call("get_last_undo_result", {})) as UndoResult;
    t.diagnostic(`Revit did not run the posted undo of ${String(first.transactionName)}; a minute later get_last_undo_result says ${first.state}, so ${first.state === "undone" ? "it is not posted again" : "it is posted again"}`);

    if (first.state === "undone") {
      return first;
    }
    assert.equal(first.state, "not_confirmed", `an undo that is neither confirmed nor undone must not be posted again: ${JSON.stringify(first)}`);

    return undoLastOperation(client);
  }
}

/** Saves, so that a later read of isModified says whether a call changed anything. */
async function saved(client: BridgeClient): Promise<void> {
  await client.call("save_project", {});
  assert.equal(await isModified(client), false);
}

/**
 * Builds a row of walls, one per type, each 3 m long and 3 m high with a gap between, and looks at it from the south
 * with a camera that stands level with the middle of the walls, so each wall fills one of the three SLOTS.
 */
async function photographRow(client: BridgeClient, typeIds: string[], style: "realistic" | "shading", title: string): Promise<Pixels> {
  const { ground } = ready();
  const y = nextRowY;
  nextRowY += 40000;

  const walls = (await client.call("create_walls", {
    items: typeIds.map((typeId, slot) => ({
      startMm: { x: slot * WALL_PITCH_MM, y },
      endMm: { x: slot * WALL_PITCH_MM + WALL_LENGTH_MM, y },
      typeId,
      levelId: ground.id,
      heightMm: WALL_HEIGHT_MM,
    })),
  })) as Batch<WallActual>;
  created(walls);

  const centreX = ((typeIds.length - 1) * WALL_PITCH_MM + WALL_LENGTH_MM) / 2;
  const view = (await client.call("create_3d_view", {
    name: `${title} ${style} ${stamp}`,
    kind: "perspective",
    displayStyle: style,
    eyeMm: { x: centreX, y: y - CAMERA_DISTANCE_MM, z: CAMERA_HEIGHT_MM },
    targetMm: { x: centreX, y, z: CAMERA_HEIGHT_MM },
  })) as { committed: boolean; viewId: string; displayStyle: string; errors: string[] };
  assert.equal(view.committed, true, JSON.stringify(view));
  assert.equal(view.displayStyle, style);

  const snapshot = (await client.call("get_view_snapshot", { viewId: view.viewId, widthPx: SNAPSHOT_WIDTH_PX })) as { path: string; dialogs: unknown[] };
  assert.deepEqual(snapshot.dialogs, []);

  await mkdir(snapshotFolder, { recursive: true });
  const kept = path.join(snapshotFolder, `${title}-${style}-${stamp}.png`);
  await copyFile(snapshot.path, kept);
  console.log(`# snapshot: ${kept}`);

  return decodePng(await readFile(kept));
}

/** Asserts that a region of the picture is one colour, or no colour at all for null, and logs what it measured. */
function assertShows(pixels: Pixels, slot: keyof typeof SLOTS, expected: Band | null, what: string): void {
  const report = reportColours(pixels, SLOTS[slot]);
  const shares = { red: report.bands.red.share, green: report.bands.green.share, blue: report.bands.blue.share };
  console.log(`# ${what}, ${slot}: expected ${String(expected)}, ${report.coloured} of ${report.pixels} pixels coloured, shares ${JSON.stringify(shares)}`);

  if (expected === null) {
    assert.equal(report.coloured, 0, `${what}, ${slot}: no colour was expected`);
    return;
  }

  assert.equal(report.dominant, expected, `${what}, ${slot}`);
  assert.ok(report.bands[expected].share >= MIN_BAND_SHARE, `${what}, ${slot}: only ${report.bands[expected].share} of the colour is ${expected}`);
  assert.ok(report.coloured / report.pixels >= MIN_COLOURED_SHARE, `${what}, ${slot}: only ${report.coloured} of ${report.pixels} pixels are coloured`);
}

/** The three layers every wall type here takes: outside finish, structure and inside finish, outside first. */
const wallLayers = (w: World) => [
  { thicknessMm: 20, materialId: w.plaster.id, function: "finish2" },
  { thicknessMm: 200, materialId: w.concrete.id, function: "structure" },
  { thicknessMm: 15, materialId: w.plaster.id, function: "finish1" },
];

describe("stage 3 live checks: materials and types", { timeout: 900_000 }, () => {
  it("creates a project for this run and finds what the template calls its types and materials", async () => {
    await withClient(async (client) => {
      await client.call("create_project", { name });

      const info = await modelInfo(client);
      assert.equal(info.activeDocument?.title, name);
      const ground = info.levels.find((level) => level.elevationMm === 0);
      assert.ok(ground, `no level at the origin in ${JSON.stringify(info.levels)}`);

      const rows = await listMaterials(client);
      const walls = await listTypes(client, "walls");
      const ceilings = await listTypes(client, "ceilings");
      const roofs = await listTypes(client, "roofs");

      world = {
        ground,
        wall: typeNamed(walls, /^Наружный - Стена из бруса толщиной 180 мм/),
        floor: typeNamed(await listTypes(client, "floors"), /^Типовой 300мм$/),
        roof: typeNamed(roofs, /^Типовой - 400мм$/),
        compoundCeiling: typeNamed(ceilings, /^Гладкий$/),
        basicCeiling: typeNamed(ceilings, /^Типовой$/),
        curtainWall: typeNamed(walls, /^Витраж$/),
        glazedRoof: typeNamed(roofs, /^Наклонное остекление$/),
        concrete: materialNamed(rows, "Бетон, монолитный"),
        plaster: materialNamed(rows, "Штукатурка"),
        brick: materialNamed(rows, "Кирпич, обычный"),
        glass: materialNamed(rows, "Стекло"),
      };
      console.log(`# template: ${JSON.stringify(world)}`);
    });
  });

  it("material colour shows on a snapshot", async () => {
    await withClient(async (client) => {
      const w = ready();
      const wanted = [
        { name: `Красный ${stamp}`, colour: RED, band: "red" },
        { name: `Зелёный ${stamp}`, colour: GREEN, band: "green" },
        { name: `Синий ${stamp}`, colour: BLUE, band: "blue" },
      ] as const;

      const made = created(await materials(client, wanted.map((entry) => ({ name: entry.name, colorRgb: entry.colour }))));

      // What the model holds: the colour of Shading and the colour of Realistic, as asked, on a material that is plainly new.
      for (const [index, entry] of wanted.entries()) {
        const actual = made[index]!.actual;
        console.log(`# material ${entry.name}: ${JSON.stringify(actual)}`);
        assert.equal(actual.name, entry.name);
        assert.deepEqual(actual.colorRgb, entry.colour);
        assert.deepEqual(actual.appearanceColorRgb, entry.colour);
        assert.equal(actual.transparency, 0);
        assert.equal(actual.useRenderAppearanceForShading, false);
        assert.ok(actual.appearanceAssetId);
      }
      const assets = made.map((entry) => entry.actual.appearanceAssetId);
      assert.equal(new Set(assets).size, 3, "each material has its own appearance asset");

      const rows = await listMaterials(client);
      for (const [index, entry] of wanted.entries()) {
        assert.deepEqual(rows.find((row) => row.id === made[index]!.id)?.color, entry.colour);
      }

      // One wall type of one layer of each colour, then a row of walls of those types.
      const typed = created(
        await types(
          client,
          wanted.map((entry, index) => ({
            category: "walls",
            baseTypeId: w.wall.id,
            name: `Стена ${entry.name}`,
            layers: [{ thicknessMm: 200, materialId: made[index]!.id, function: "structure" }],
          })),
        ),
      );
      for (const entry of typed) {
        assertNear(entry.actual.widthMm, 200, `width of ${entry.actual.name}`);
      }
      const typeIds = typed.map((entry) => entry.id);

      const realistic = await photographRow(client, typeIds, "realistic", "цвета");
      for (const [slot, entry] of (["left", "middle", "right"] as const).map((slot, index) => [slot, wanted[index]!] as const)) {
        assertShows(realistic, slot, entry.band, `Realistic, ${entry.name}`);
      }

      const shading = await photographRow(client, typeIds, "shading", "цвета");
      for (const [slot, entry] of (["left", "middle", "right"] as const).map((slot, index) => [slot, wanted[index]!] as const)) {
        assertShows(shading, slot, entry.band, `Shading, ${entry.name}`);
      }

      // The two display styles draw by different ways, the asset in Realistic and the colour of the material in Shading:
      // the same red wall comes out as 255 in Realistic and about 222 in Shading, lit by the default sun. Measured the same in six runs.
      const inRealistic = meanColour(realistic, SLOTS.left);
      const inShading = meanColour(shading, SLOTS.left);
      console.log(`# the red wall, mean colour in Realistic ${JSON.stringify(inRealistic)}, in Shading ${JSON.stringify(inShading)}`);
      assert.ok(inRealistic.r - inShading.r >= MIN_STYLE_DIFFERENCE, `Realistic and Shading should not draw the red wall alike: ${inRealistic.r} against ${inShading.r}`);

      // A control: between the red and the blue wall stands a wall of a grey template material, which shows no colour, in both styles.
      const [grey] = created(
        await types(client, [{ category: "walls", baseTypeId: w.wall.id, name: `Стена серая ${stamp}`, layers: [{ thicknessMm: 200, materialId: w.concrete.id, function: "structure" }] }]),
      );
      assert.ok(grey);
      const withGrey = [typeIds[0]!, grey.id, typeIds[2]!];
      for (const style of ["realistic", "shading"] as const) {
        const picture = await photographRow(client, withGrey, style, "контроль");
        assertShows(picture, "left", "red", `${style} control, the red wall`);
        assertShows(picture, "middle", null, `${style} control, the grey template material`);
        assertShows(picture, "right", "blue", `${style} control, the blue wall`);
      }
    });
  });

  it("a copy does not recolour its base, and a textured base takes a flat colour on its copy", async () => {
    await withClient(async (client) => {
      const w = ready();
      const baseName = `База красная ${stamp}`;
      const [base] = created(await materials(client, [{ name: baseName, colorRgb: RED }]));
      assert.ok(base);

      const rowsBefore = await listMaterials(client);
      const plasterBefore = materialNamed(rowsBefore, w.plaster.name);
      const plasterAssetBefore = (await materials(client, [{ name: w.plaster.name, baseMaterialId: w.plaster.id }])).items[0]?.actual?.appearanceAssetId;
      assert.ok(plasterAssetBefore);

      const copies = created(
        await materials(client, [
          { name: `Копия синяя ${stamp}`, baseMaterialId: base.id, colorRgb: BLUE },
          { name: `Штукатурка зелёная ${stamp}`, baseMaterialId: w.plaster.id, colorRgb: GREEN },
          { name: `Копия как есть ${stamp}`, baseMaterialId: base.id },
        ]),
      );
      const [blue, green, same] = copies;
      assert.ok(blue && green && same);
      console.log(`# copies: ${JSON.stringify(copies.map((copy) => copy.actual))}`);

      // A copy has an asset of its own, whichever way it was made, and says the colour it was given.
      assert.deepEqual(blue.actual.colorRgb, BLUE);
      assert.deepEqual(blue.actual.appearanceColorRgb, BLUE);
      assert.deepEqual(green.actual.colorRgb, GREEN);
      assert.deepEqual(green.actual.appearanceColorRgb, GREEN);
      assert.deepEqual(same.actual.colorRgb, RED, "a copy without a colour keeps the colour of its base");
      assert.deepEqual(same.actual.appearanceColorRgb, RED);
      const assets = [base.actual.appearanceAssetId, blue.actual.appearanceAssetId, green.actual.appearanceAssetId, same.actual.appearanceAssetId, plasterAssetBefore];
      assert.equal(new Set(assets).size, assets.length, `every material has an asset of its own: ${JSON.stringify(assets)}`);

      // The base is asked about again, by its name, and says what it is now: red, as it was, with its own asset.
      const baseNow = (await materials(client, [{ name: baseName, colorRgb: RED }])).items[0];
      assert.equal(baseNow?.status, "already_existed");
      assert.deepEqual(baseNow?.warnings, [], "the base should still be what it was");
      assert.deepEqual(baseNow?.actual?.colorRgb, RED);
      assert.deepEqual(baseNow?.actual?.appearanceColorRgb, RED);
      assert.equal(baseNow?.actual?.appearanceAssetId, base.actual.appearanceAssetId);

      // The template material the green one came from has the colour and the asset it had, and still has a texture.
      const plasterNow = (await materials(client, [{ name: w.plaster.name, baseMaterialId: w.plaster.id }])).items[0];
      assert.equal(plasterNow?.actual?.appearanceAssetId, plasterAssetBefore);
      assert.equal(plasterNow?.actual?.appearanceColorRgb, null, "the plaster of the template keeps its texture, so it has no single colour");
      assert.deepEqual(plasterNow?.actual?.colorRgb, plasterBefore.color);
      assert.deepEqual(materialNamed(await listMaterials(client), w.plaster.name), plasterBefore);

      // And on a picture: the base wall is still red next to a blue copy of it and a green plaster.
      const typed = created(
        await types(
          client,
          [
            ["База", base.id],
            ["Штукатурка зелёная", green.id],
            ["Копия синяя", blue.id],
          ].map(([label, materialId]) => ({
            category: "walls",
            baseTypeId: w.wall.id,
            name: `Стена ${label} ${stamp}`,
            layers: [{ thicknessMm: 200, materialId, function: "structure" }],
          })),
        ),
      );
      const picture = await photographRow(client, typed.map((entry) => entry.id), "realistic", "копии");
      assertShows(picture, "left", "red", "Realistic, the base");
      assertShows(picture, "middle", "green", "Realistic, the plaster copy");
      assertShows(picture, "right", "blue", "Realistic, the copy of the base");
    });
  });

  it("same material name returns already_existed with real values and a mismatch warning", async () => {
    await withClient(async (client) => {
      const label = `Кирпич ярко-красный ${stamp}`;
      const [first] = created(await materials(client, [{ name: label, colorRgb: RED }]));
      assert.ok(first);
      const before = await listMaterials(client);

      const same = (await materials(client, [{ name: label, colorRgb: RED }])).items[0];
      console.log(`# same name, same values: ${JSON.stringify(same)}`);
      assert.equal(same?.status, "already_existed");
      assert.equal(same?.elementId, first.id);
      assert.deepEqual(same?.warnings, []);
      assert.deepEqual(same?.actual, first.actual);

      // Another colour and another transparency: the material is not touched, says what it is, and warns, in Shading, in Realistic and in transparency.
      const other = await materials(client, [{ name: label, colorRgb: BLUE, transparency: 40 }]);
      assert.equal(other.committed, true);
      assert.deepEqual(other.errors, []);
      const item = other.items[0];
      console.log(`# same name, other values: ${JSON.stringify(item)}`);
      assert.equal(item?.status, "already_existed");
      assert.equal(item?.elementId, first.id);
      assert.deepEqual(item?.actual?.colorRgb, RED);
      assert.deepEqual(item?.actual?.appearanceColorRgb, RED);
      assert.equal(item?.actual?.transparency, 0);
      assert.equal(item?.warnings.length, 3, JSON.stringify(item?.warnings));
      assert.ok(item?.warnings.some((text) => /Shading/.test(text) && /255, 0, 0/.test(text) && /0, 0, 255/.test(text)));
      assert.ok(item?.warnings.some((text) => /Realistic/.test(text)));
      assert.ok(item?.warnings.some((text) => /transparency 0, not the 40/.test(text)));

      // Not a duplicate: one material of that name, and as many materials as before.
      const after = await listMaterials(client);
      assert.equal(after.filter((row) => row.name === label).length, 1);
      assert.equal(after.length, before.length);
      assert.deepEqual(after.find((row) => row.name === label)?.color, RED);

      // A name that differs in case only is another name, as Revit takes it.
      const upper = (await materials(client, [{ name: label.toUpperCase(), colorRgb: RED }])).items[0];
      assert.equal(upper?.status, "created");

      // An existing name next to a new one: each is judged on its own.
      const mixed = await materials(client, [{ name: label, colorRgb: RED }, { name: `${label} новый`, colorRgb: GREEN }]);
      assert.deepEqual(mixed.items.map((entry) => entry.status), ["already_existed", "created"]);

      // When every item exists, no model change is made at all.
      await saved(client);
      const allExist = await materials(client, [{ name: label, colorRgb: RED }, { name: `${label} новый`, colorRgb: GREEN }]);
      assert.deepEqual(allExist.items.map((entry) => entry.status), ["already_existed", "already_existed"]);
      assert.equal(await isModified(client), false, "a call of existing materials leaves nothing to save");
    });
  });

  it("same type name returns already_existed with real values and a mismatch warning", async () => {
    await withClient(async (client) => {
      const w = ready();
      const label = `Стена трёхслойная ${stamp}`;
      const layers = wallLayers(w);
      const [first] = created(await types(client, [{ category: "walls", baseTypeId: w.wall.id, name: label, layers }]));
      assert.ok(first);
      const before = await listTypes(client, "walls");

      const same = (await types(client, [{ category: "walls", baseTypeId: w.wall.id, name: label, layers }])).items[0];
      console.log(`# same type, same layers: ${JSON.stringify(same)}`);
      assert.equal(same?.status, "already_existed");
      assert.equal(same?.elementId, first.id);
      assert.deepEqual(same?.warnings, []);
      assert.deepEqual(same?.actual, first.actual);

      const thicker = (await types(client, [{ category: "walls", baseTypeId: w.wall.id, name: label, layers: [{ ...layers[0]!, thicknessMm: 30 }, layers[1], layers[2]] }])).items[0];
      console.log(`# same type, other layers: ${JSON.stringify(thicker)}`);
      assert.equal(thicker?.status, "already_existed");
      assert.equal(thicker?.elementId, first.id);
      assertNear(thicker?.actual?.widthMm, 235, "the real width");
      assert.equal(thicker?.warnings.length, 1, JSON.stringify(thicker?.warnings));
      assert.match(thicker?.warnings[0] ?? "", /Layer 0/);
      assert.match(thicker?.warnings[0] ?? "", /thickness 20 mm, not 30 mm/);

      const fewer = (await types(client, [{ category: "walls", baseTypeId: w.wall.id, name: label, layers: [layers[1]] }])).items[0];
      assert.equal(fewer?.status, "already_existed");
      assert.match(fewer?.warnings[0] ?? "", /has 3 layers, not the 1 asked for/);

      // No layers asked for means a copy of the base type, and this type is not that.
      const copyOfBase = (await types(client, [{ category: "walls", baseTypeId: w.wall.id, name: label }])).items[0];
      assert.equal(copyOfBase?.status, "already_existed");
      assert.ok((copyOfBase?.warnings.length ?? 0) > 0, "a layered type is not a copy of its base");
      assert.match(copyOfBase?.warnings.join(" ") ?? "", /of the base type/);

      // Not a duplicate: one type of that name in the family, and as many types as before.
      const after = await listTypes(client, "walls");
      assert.equal(after.filter((row) => row.name === label && row.family === first.actual.family).length, 1);
      assert.equal(after.length, before.length);

      // The same for the other categories.
      for (const [category, base] of [["floors", w.floor], ["roofs", w.roof], ["ceilings", w.compoundCeiling]] as const) {
        const item = { category, baseTypeId: base.id, name: `Тип ${category} ${stamp}`, layers: [{ thicknessMm: 100, materialId: w.concrete.id, function: "structure" }] };
        const [one] = created(await types(client, [item]));
        const again = (await types(client, [item])).items[0];
        assert.equal(again?.status, "already_existed", category);
        assert.equal(again?.elementId, one?.id);
        assert.deepEqual(again?.warnings, [], category);
      }

      // A name that another family already has is free in this one, which Revit takes: the curtain wall type stays as it is.
      const curtainBefore = await listTypes(client, "walls");
      const sameAsCurtain = await types(client, [{ category: "walls", baseTypeId: w.wall.id, name: w.curtainWall.name }]);
      console.log(`# the name of the curtain wall type, on a basic wall: ${JSON.stringify(sameAsCurtain.items[0])}`);
      assert.equal(sameAsCurtain.items[0]?.status, "created");
      assert.notEqual(sameAsCurtain.items[0]?.elementId, w.curtainWall.id);
      const curtainAfter = await listTypes(client, "walls");
      assert.equal(curtainAfter.length, curtainBefore.length + 1);
      assert.equal(curtainAfter.filter((row) => row.name === w.curtainWall.name).length, 2);

      // The same name twice in one list is refused, as for levels, and nothing is made.
      const twice = { category: "walls", baseTypeId: w.wall.id, name: `Дважды ${stamp}` };
      const refused = await refusal(client, "create_type", { items: [twice, twice] });
      assert.match(refused.message, /items 0 and 1 both name/);
      assert.equal((await listTypes(client, "walls")).some((row) => row.name === twice.name), false);

      // When every item exists, nothing changes and nothing is left to save.
      await saved(client);
      assert.equal((await types(client, [{ category: "walls", baseTypeId: w.wall.id, name: label, layers }])).items[0]?.status, "already_existed");
      assert.equal(await isModified(client), false);
    });
  });

  it("layered wall has the requested total width", async () => {
    await withClient(async (client) => {
      const w = ready();
      const layers = [
        { thicknessMm: 20, materialId: w.plaster.id, function: "finish2" },
        { thicknessMm: 100, materialId: w.concrete.id, function: "insulation" },
        { thicknessMm: 0, materialId: w.concrete.id, function: "membrane" },
        { thicknessMm: 200, materialId: w.concrete.id, function: "structure" },
        { thicknessMm: 12.5, materialId: w.plaster.id, function: "substrate" },
        { thicknessMm: 15, materialId: w.plaster.id, function: "finish1" },
      ];
      const total = 20 + 100 + 200 + 12.5 + 15;
      const label = `Стена слоистая ${stamp}`;

      const [type] = created(await types(client, [{ category: "walls", baseTypeId: w.wall.id, name: label, layers }]));
      assert.ok(type);
      console.log(`# layered wall type: ${JSON.stringify(type.actual)}`);
      assert.equal(type.actual.category, "walls");
      assertNear(type.actual.widthMm, total, "width of the type");
      assert.equal(type.actual.layers?.length, layers.length);
      for (const [index, layer] of layers.entries()) {
        const real: LayerActual | undefined = type.actual.layers?.[index];
        assertNear(real?.thicknessMm, layer.thicknessMm, `thickness of layer ${index}`);
        assert.equal(real?.materialId, layer.materialId, `material of layer ${index}`);
        assert.equal(real?.function, layer.function, `function of layer ${index}`);
      }

      // The type is in the project under that name, and a wall of it is as wide as the layers say.
      const listed = (await listTypes(client, "walls")).find((row) => row.name === label);
      assert.equal(listed?.id, type.id);
      const wallBatch = (await client.call("create_walls", {
        items: [{ startMm: { x: 0, y: 200000 }, endMm: { x: 4000, y: 200000 }, typeId: type.id, levelId: w.ground.id, heightMm: 2500 }],
      })) as Batch<WallActual>;
      const [wall] = created(wallBatch);
      assert.ok(wall);
      assertNear(wall.actual.widthMm, total, "width of the wall");
      assert.equal(wall.actual.typeId, type.id);

      // A floor: the layers go from the top down, and its thickness hangs below the level.
      const floorLayers = [
        { thicknessMm: 20, materialId: w.plaster.id, function: "finish1" },
        { thicknessMm: 150, materialId: w.concrete.id, function: "structure" },
      ];
      const [floorType] = created(await types(client, [{ category: "floors", baseTypeId: w.floor.id, name: `Пол слоистый ${stamp}`, layers: floorLayers }]));
      assert.ok(floorType);
      assertNear(floorType.actual.widthMm, 170, "width of the floor type");
      assert.deepEqual(floorType.actual.layers?.map((layer) => layer.function), ["finish1", "structure"]);
      const floor = (await client.call("create_floors", {
        items: [{ boundaryMm: [{ x: 0, y: 210000 }, { x: 4000, y: 210000 }, { x: 4000, y: 214000 }, { x: 0, y: 214000 }], typeId: floorType.id, levelId: w.ground.id }],
      })) as Batch<{ boundingBoxMm: ElementRow["boundingBoxMm"] }>;
      const [floorMade] = created(floor);
      const box = floorMade?.actual.boundingBoxMm;
      assert.ok(box);
      assertNear(box.max.z - box.min.z, 170, "thickness of the floor", 0.5);

      // Roofs and ceilings take layers too, and give their total.
      const [roofType] = created(await types(client, [{ category: "roofs", baseTypeId: w.roof.id, name: `Крыша слоистая ${stamp}`, layers: floorLayers }]));
      const [ceilingType] = created(await types(client, [{ category: "ceilings", baseTypeId: w.compoundCeiling.id, name: `Потолок слоистый ${stamp}`, layers: floorLayers }]));
      assertNear(roofType?.actual.widthMm, 170, "width of the roof type");
      assertNear(ceilingType?.actual.widthMm, 170, "width of the ceiling type");
    });
  });

  it("bad layer stack fails before any change", async () => {
    await withClient(async (client) => {
      const w = ready();
      await saved(client);
      const wallsBefore = await listTypes(client, "walls");
      const floorsBefore = await listTypes(client, "floors");
      const materialsBefore = await listMaterials(client);
      const good = { category: "walls", baseTypeId: w.wall.id, name: `Хорошая ${stamp}`, layers: [{ thicknessMm: 200, materialId: w.concrete.id, function: "structure" }] };
      const structure = { thicknessMm: 100, materialId: w.concrete.id, function: "structure" };
      const bad = (extra: object) => ({ category: "walls", baseTypeId: w.wall.id, name: `Плохая ${stamp}`, ...extra });

      const stacks: Array<[string, object, RegExp]> = [
        ["a layer with no thickness", bad({ layers: [{ ...structure, thicknessMm: 0 }] }), /layers\[0\].*above zero/],
        ["a negative thickness", bad({ layers: [{ ...structure, thicknessMm: -5 }] }), /layers\[0\]/],
        ["a membrane with a thickness", bad({ layers: [structure, { thicknessMm: 3, materialId: w.concrete.id, function: "membrane" }] }), /layers\[1\].*membrane has no thickness/],
        ["membranes only", bad({ layers: [{ thicknessMm: 0, materialId: w.concrete.id, function: "membrane" }] }), /nothing but membranes/],
        ["a layer too thin for Revit", bad({ layers: [{ ...structure, thicknessMm: 0.1 }] }), /Layer 0.*too thin/],
        ["no layers at all", bad({ layers: [] }), /layers must be a list of at least one layer/],
        ["a layers that is no list", bad({ layers: "бетон" }), /layers must be a list/],
        ["a layer that is no object", bad({ layers: [200] }), /layers\[0\] must be an object/],
        ["an unknown function", bad({ layers: [{ ...structure, function: "core" }] }), /function must be one of structure, substrate, insulation, finish1, finish2, membrane/],
        ["a material that is a wall type", bad({ layers: [{ ...structure, materialId: w.wall.id }] }), /layers\[0\]: materialId .* is not a material/],
        ["no material id", bad({ layers: [{ thicknessMm: 100, function: "structure" }] }), /materialId must be an element id/],
        ["a base type with no layers", { category: "walls", baseTypeId: w.curtainWall.id, name: `Витраж слои ${stamp}`, layers: [structure] }, /has no layers to replace/],
        ["a base ceiling with no layers", { category: "ceilings", baseTypeId: w.basicCeiling.id, name: `Потолок слои ${stamp}`, layers: [structure] }, /has no layers to replace/],
        ["a glazed roof with layers", { category: "roofs", baseTypeId: w.glazedRoof.id, name: `Остекление слои ${stamp}`, layers: [structure] }, /has no layers to replace/],
        ["a base of another category", { category: "walls", baseTypeId: w.floor.id, name: `Не та основа ${stamp}` }, /baseTypeId .* is not a type of walls/],
        ["a category that holds no layered types", { category: "doors", baseTypeId: w.wall.id, name: `Дверь ${stamp}` }, /category must be one of walls, floors, ceilings, roofs/],
        ["a name Revit forbids", bad({ name: "Плохая {скобка}" }), /cannot be a type name/],
        ["a name with a space at the end", bad({ name: "Плохая " }), /cannot be a type name/],
      ];

      for (const [what, item, message] of stacks) {
        const refused = await refusal(client, "create_type", { items: [good, item] });
        console.log(`# ${what}: ${refused.message.slice(0, 220)}`);
        assert.match(refused.message, message, what);
        assert.match(refused.message, /item 1/, `${what}: the refusal should name the item`);
      }

      // The good item before each bad one was not made, and the model is as it was, with nothing to save.
      assert.deepEqual(await listTypes(client, "walls"), wallsBefore);
      assert.deepEqual(await listTypes(client, "floors"), floorsBefore);
      assert.deepEqual(await listMaterials(client), materialsBefore);
      assert.equal(await isModified(client), false, "a refused call changes nothing");
    });
  });

  it("bad material requests fail before any change", async () => {
    await withClient(async (client) => {
      const w = ready();
      await saved(client);
      const materialsBefore = await listMaterials(client);
      const good = { name: `Хороший ${stamp}`, colorRgb: RED };

      const requests: Array<[string, object, RegExp]> = [
        ["no colour and no base", { name: `Без цвета ${stamp}` }, /give colorRgb, or baseMaterialId/],
        ["a channel above 255", { name: `Яркий ${stamp}`, colorRgb: { r: 256, g: 0, b: 0 } }, /colorRgb\.r must be a whole number from 0 to 255/],
        ["a negative channel", { name: `Минус ${stamp}`, colorRgb: { r: 0, g: -1, b: 0 } }, /colorRgb\.g must be a whole number/],
        ["a fractional channel", { name: `Дробный ${stamp}`, colorRgb: { r: 0, g: 0, b: 1.5 } }, /colorRgb\.b must be a whole number/],
        ["a missing channel", { name: `Нет канала ${stamp}`, colorRgb: { r: 0, g: 0 } }, /b is missing/],
        ["a colour that is no object", { name: `Не цвет ${stamp}`, colorRgb: "#ff0000" }, /colorRgb must be/],
        ["a transparency above 100", { ...good, name: `Прозрачный ${stamp}`, transparency: 101 }, /transparency must be a whole number from 0 to 100/],
        ["a fractional transparency", { ...good, name: `Дробно ${stamp}`, transparency: 50.5 }, /transparency must be a whole number/],
        ["a base that is a wall type", { ...good, name: `Основа не та ${stamp}`, baseMaterialId: w.wall.id }, /baseMaterialId .* is not a material/],
        ["a base that is no id", { ...good, name: `Основа текст ${stamp}`, baseMaterialId: "кирпич" }, /baseMaterialId .* is not a material/],
        ["a name Revit forbids", { ...good, name: "Плохой [материал]" }, /cannot be a material name/],
        ["an empty name", { ...good, name: "" }, /cannot be a material name/],
        ["a name with a space at the start", { ...good, name: " Пробел" }, /cannot be a material name/],
        ["a colour on a brick base", { name: `Кирпич зелёный ${stamp}`, baseMaterialId: w.brick.id, colorRgb: GREEN }, /no plain colour to set/],
        ["a transparency on a glass base", { name: `Стекло мутное ${stamp}`, baseMaterialId: w.glass.id, transparency: 50 }, /no transparency to set/],
        ["a transparency of 0 on a glass base", { name: `Стекло плотное ${stamp}`, baseMaterialId: w.glass.id, transparency: 0 }, /no transparency to set, so its copy could not be given a transparency in Realistic, not even 0/],
      ];

      for (const [what, item, message] of requests) {
        const refused = await refusal(client, "create_materials", { items: [good, item] });
        console.log(`# ${what}: ${refused.message.slice(0, 220)}`);
        assert.match(refused.message, message, what);
        assert.match(refused.message, /item 1/, `${what}: the refusal should name the item`);
      }

      assert.equal((await refusal(client, "create_materials", { items: [good, { ...good, colorRgb: BLUE }] })).message.includes("items 0 and 1 both name"), true);
      await refusal(client, "create_materials", { items: [] });
      await refusal(client, "create_materials", { items: Array.from({ length: 501 }, (_, index) => ({ name: `М${index} ${stamp}`, colorRgb: RED })) });

      assert.deepEqual(await listMaterials(client), materialsBefore);
      assert.equal(await isModified(client), false, "a refused call changes nothing");
    });
  });

  it("copies a base that has no plain colour as it is, with an asset of its own", async () => {
    await withClient(async (client) => {
      const w = ready();
      const brickBefore = materialNamed(await listMaterials(client), w.brick.name);

      const [copy] = created(await materials(client, [{ name: `Кирпич копия ${stamp}`, baseMaterialId: w.brick.id }]));
      assert.ok(copy);
      console.log(`# brick copy: ${JSON.stringify(copy.actual)}`);
      assert.deepEqual(copy.actual.colorRgb, brickBefore.color, "the copy has the colour of its base");
      assert.equal(copy.actual.appearanceColorRgb, null, "a brick appearance has no single colour");
      assert.equal(copy.actual.transparency, brickBefore.transparency);
      assert.ok(copy.actual.appearanceAssetId);

      const brickAsset = (await materials(client, [{ name: w.brick.name, baseMaterialId: w.brick.id }])).items[0]?.actual?.appearanceAssetId;
      assert.ok(brickAsset);
      assert.notEqual(copy.actual.appearanceAssetId, brickAsset, "the copy has its own asset, and does not share the one of the base");
      assert.deepEqual(materialNamed(await listMaterials(client), w.brick.name), brickBefore);

      // Layered types of every kind come out as the structure asked for, and the types that have no layers are copied as they are.
      for (const base of [w.curtainWall, w.basicCeiling, w.glazedRoof]) {
        const category = base === w.curtainWall ? "walls" : base === w.basicCeiling ? "ceilings" : "roofs";
        const [made] = created(await types(client, [{ category, baseTypeId: base.id, name: `Копия ${base.name} ${stamp}` }]));
        assert.equal(made?.actual.layers, null, base.name);
        assert.equal(made?.actual.widthMm, null, base.name);
        assert.equal(made?.actual.family, base.family, base.name);
      }
    });
  });

  it("transparency is set on the material and in its appearance, and left out it is 0 for a new material and the base's for a copy", async () => {
    await withClient(async (client) => {
      const baseName = `Тонированное ${stamp}`;
      const colour: Rgb = { r: 40, g: 120, b: 200 };

      // Given, on a new material: the transparency of Shading and the one of the appearance are both read back from the model.
      const [base] = created(await materials(client, [{ name: baseName, colorRgb: colour, transparency: 60 }]));
      assert.ok(base);
      console.log(`# transparency 60: ${JSON.stringify(base.actual)}`);
      assert.equal(base.actual.transparency, 60);
      assertNear(base.actual.appearanceTransparency, 60, "transparency of the appearance");
      assert.deepEqual(base.actual.colorRgb, colour);
      assert.deepEqual(base.actual.appearanceColorRgb, colour);
      assert.equal((await listMaterials(client)).find((row) => row.id === base.id)?.transparency, 60);

      // Left out, on a new material: opaque in both.
      const [plain] = created(await materials(client, [{ name: `Непрозрачное ${stamp}`, colorRgb: colour }]));
      assert.equal(plain?.actual.transparency, 0);
      assertNear(plain?.actual.appearanceTransparency, 0, "transparency of the appearance of a new material");

      // Left out, on a copy: the copy is as see-through as its base, in Shading and in Realistic, with an asset of its own.
      // Given, on a copy, 25 and 0: it is set, in both. A colour alone leaves the transparency as it is.
      const copies = created(
        await materials(client, [
          { name: `Тонированное копия ${stamp}`, baseMaterialId: base.id },
          { name: `Тонированное копия 25 ${stamp}`, baseMaterialId: base.id, transparency: 25 },
          { name: `Тонированное копия 0 ${stamp}`, baseMaterialId: base.id, transparency: 0 },
          { name: `Тонированное копия цвет ${stamp}`, baseMaterialId: base.id, colorRgb: RED },
        ]),
      );
      const [kept, quarter, zero, recoloured] = copies;
      assert.ok(kept && quarter && zero && recoloured);
      console.log(`# copies of the transparency 60: ${JSON.stringify(copies.map((copy) => [copy.actual.transparency, copy.actual.appearanceTransparency]))}`);
      assert.equal(kept.actual.transparency, 60);
      assertNear(kept.actual.appearanceTransparency, 60, "the copy keeps the transparency of the appearance");
      assert.deepEqual(kept.actual.colorRgb, colour);
      assert.equal(quarter.actual.transparency, 25);
      assertNear(quarter.actual.appearanceTransparency, 25, "a transparency of 25 on a copy");
      assert.equal(zero.actual.transparency, 0);
      assertNear(zero.actual.appearanceTransparency, 0, "a transparency of 0 on a copy");
      assert.equal(recoloured.actual.transparency, 60, "a colour on a copy leaves its transparency alone");
      assertNear(recoloured.actual.appearanceTransparency, 60, "a colour on a copy leaves the transparency of its appearance alone");
      assert.deepEqual(recoloured.actual.appearanceColorRgb, RED);
      assert.equal(new Set([base, ...copies].map((copy) => copy.actual.appearanceAssetId)).size, 5, "each has an appearance asset of its own");

      // The base did not move, and a transparency that is left out is not compared with the one the material has.
      const again = (await materials(client, [{ name: baseName, colorRgb: colour }])).items[0];
      assert.equal(again?.status, "already_existed");
      assert.deepEqual(again?.warnings, [], "no transparency was given, so none is compared");
      assert.equal(again?.actual?.transparency, 60);
      assertNear(again?.actual?.appearanceTransparency, 60, "the appearance of the base");
      const asked = (await materials(client, [{ name: baseName, colorRgb: colour, transparency: 0 }])).items[0];
      assert.equal(asked?.warnings.length, 1, JSON.stringify(asked?.warnings));
      assert.match(asked?.warnings[0] ?? "", /transparency 60, not the 0 asked for/);
      assert.equal(asked?.actual?.transparency, 60, "an existing material is not changed");
    });
  });

  it("a copy of the template glass keeps its transparency and has an asset of its own, and glass takes none of its own", async () => {
    await withClient(async (client) => {
      const w = ready();
      const glassBefore = materialNamed(await listMaterials(client), w.glass.name);
      assert.ok(glassBefore.transparency > 0, "the glass of the template is see-through");

      const baseRead = (await materials(client, [{ name: w.glass.name, baseMaterialId: w.glass.id }])).items[0];
      assert.equal(baseRead?.status, "already_existed");
      assert.deepEqual(baseRead?.warnings, [], "no transparency was given, so none is compared");
      assert.equal(baseRead?.actual?.transparency, glassBefore.transparency);
      assert.equal(baseRead?.actual?.appearanceTransparency, null, "the glazing appearance has no transparency to read");

      const [copy] = created(await materials(client, [{ name: `Стекло копия ${stamp}`, baseMaterialId: w.glass.id }]));
      assert.ok(copy);
      console.log(`# glass copy: ${JSON.stringify(copy.actual)}`);
      assert.equal(copy.actual.transparency, glassBefore.transparency, "a name-only copy keeps the transparency of its base");
      assert.deepEqual(copy.actual.colorRgb, glassBefore.color);
      assert.equal(copy.actual.appearanceTransparency, null);
      assert.ok(copy.actual.appearanceAssetId);
      assert.notEqual(copy.actual.appearanceAssetId, baseRead?.actual?.appearanceAssetId, "the copy has an asset of its own");
      assert.equal(copy.actual.materialClass, glassBefore.materialClass);
      assert.equal((await listMaterials(client)).find((row) => row.id === copy.id)?.transparency, glassBefore.transparency);
      assert.deepEqual(materialNamed(await listMaterials(client), w.glass.name), glassBefore, "the glass of the template did not move");

      // A transparency, 0 included, is refused for the glass, as its appearance has none to set.
      for (const transparency of [0, 50]) {
        const refused = await refusal(client, "create_materials", { items: [{ name: `Стекло ${transparency} ${stamp}`, baseMaterialId: w.glass.id, transparency }] });
        assert.match(refused.message, /no transparency to set/);
      }
    });
  });

  it("basic type name with Cyrillic", async () => {
    await withClient(async (client) => {
      const w = ready();
      const typeName = `Ёж-Щука №7, стена 250 мм (кирпич + газобетон) ${stamp}`;
      const materialName = `Эрмитажный жёлтый «охра» №3 ${stamp}`;

      const [material] = created(await materials(client, [{ name: materialName, colorRgb: { r: 227, g: 168, b: 54 } }]));
      assert.ok(material);
      assert.equal(material.actual.name, materialName);

      const [type] = created(
        await types(client, [{ category: "walls", baseTypeId: w.wall.id, name: typeName, layers: [{ thicknessMm: 250, materialId: material.id, function: "structure" }] }]),
      );
      assert.ok(type);
      assert.equal(type.actual.name, typeName);
      assert.equal(type.actual.layers?.[0]?.materialId, material.id);

      // Read back through other tools, to the code point, with no replacement character on the way.
      const listedType = (await listTypes(client, "walls")).find((row) => row.name === typeName);
      assert.equal(listedType?.id, type.id);
      assert.equal(listedType?.name, typeName);
      const listedMaterial = (await listMaterials(client)).find((row) => row.name === materialName);
      assert.equal(listedMaterial?.id, material.id);
      assert.equal(listedMaterial?.name, materialName);
      assert.deepEqual(listedMaterial?.color, { r: 227, g: 168, b: 54 });

      const wall = (await client.call("create_walls", {
        items: [{ startMm: { x: 0, y: 220000 }, endMm: { x: 3000, y: 220000 }, typeId: type.id, levelId: w.ground.id, heightMm: 2500 }],
      })) as Batch<WallActual>;
      const [made] = created(wall);
      assert.ok(made);
      const read = (await client.call("get_elements", { ids: [made.id] })) as { elements: ElementRow[] };
      assert.equal(read.elements[0]?.typeName, typeName);

      // The name asked for comes back in requested as it was sent.
      const again = await types(client, [{ category: "walls", baseTypeId: w.wall.id, name: typeName }]);
      assert.equal(again.items[0]?.status, "already_existed");
      assert.equal((again.items[0]?.requested as { name: string }).name, typeName);
      assert.ok(![typeName, materialName].some((text) => text.includes("�")));
    });
  });

  it("one call is one Undo step, for materials with their assets and for types", async (t) => {
    await withClient(async (client) => {
      const w = ready();
      const typeName = `Тип под отмену ${stamp}`;
      const [type] = created(await types(client, [{ category: "walls", baseTypeId: w.wall.id, name: typeName, layers: wallLayers(w) }]));
      assert.ok(type);

      const names = [`Под отмену красный ${stamp}`, `Под отмену копия ${stamp}`];
      const before = await listMaterials(client);
      const made = created(await materials(client, [{ name: names[0], colorRgb: RED }, { name: names[1], baseMaterialId: w.plaster.id, colorRgb: GREEN }]));
      assert.equal((await listMaterials(client)).length, before.length + 2);

      // One undo takes both materials, with the assets they made, and nothing before them.
      const undone = await undoWithOneRetry(t, client);
      console.log(`# undo of create_materials: ${JSON.stringify(undone)}`);
      assert.equal(undone.state, "undone", JSON.stringify(undone));
      assert.equal(undone.transactionName, "MCP: create_materials");
      for (const entry of made) {
        assert.ok(undone.createdIds.includes(entry.id), `${entry.id} should be among the created ids of the undo`);
        assert.ok(entry.actual.appearanceAssetId, `the material ${entry.id} has an appearance asset`);
        assert.ok(undone.createdIds.includes(entry.actual.appearanceAssetId), `the asset ${entry.actual.appearanceAssetId} of ${entry.id} should be among the created ids of the undo`);
      }
      assert.deepEqual(await listMaterials(client), before);
      assert.ok((await listTypes(client, "walls")).some((row) => row.id === type.id), "the type made before the materials is still there");

      // The next undo is the type's own step.
      const second = await undoWithOneRetry(t, client);
      assert.equal(second.transactionName, "MCP: create_type");
      assert.ok(second.createdIds.includes(type.id));
      assert.equal((await listTypes(client, "walls")).some((row) => row.id === type.id), false);
    });
  });

  it("leaves Revit in a state the close rule accepts", async () => {
    await withClient(async (client) => {
      await client.call("save_project", {});
      assert.deepEqual(checkCanClose((await modelInfo(client)).openDocuments), { ok: true, reasons: [] });
    });
  });
});
