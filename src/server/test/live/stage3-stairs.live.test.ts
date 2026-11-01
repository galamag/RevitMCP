import assert from "node:assert/strict";
import { copyFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { checkCanClose } from "../../src/cli/closeRule.ts";
import { BridgeClient } from "../../src/client.ts";
import { defaultConnectionPath } from "../../src/connection.ts";
import { BridgeRpcError } from "../../src/errors.ts";
import { UndoNotConfirmedError, undoLastOperation } from "../../src/undo.ts";
import { undoWithOneRetry } from "../undoRetry.ts";

// These tests need a running Revit with the RevitMCP plugin loaded. Each run creates one new project in the test folder and
// leaves it open and saved. They build real stairs through a StairsEditScope, which is the one place where a mistake can leave
// Revit in an edit mode only a person can end, so every path out of a failure is followed by a call that needs Revit free.
// The stairs stand far apart, each in a scene of its own. Pictures of both kinds of stairs are kept in the test folder.

interface Level {
  id: string;
  name: string;
  elevationMm: number;
}

interface CategoryCount {
  category: string | null;
  count: number;
}

interface ModelInfo {
  activeDocument: { title: string; isModified: boolean } | null;
  openDocuments: Array<{ title: string; path: string; isModified: boolean }>;
  levels: Level[];
  categoryCounts: CategoryCount[];
}

interface TypeRow {
  id: string;
  family: string;
  name: string;
}

interface PlanPoint {
  x: number;
  y: number;
}

interface Run {
  startMm: PlanPoint;
  endMm: PlanPoint;
}

interface StairsItem {
  baseLevelId: string;
  topLevelId: string;
  typeId: string;
  runsMm: Run[];
  widthMm: number;
  desiredRisers: number;
}

interface StairsActual {
  risers: number;
  riserHeightMm: number;
  treadDepthMm: number;
  topElevationMm: number;
  footprintMm: PlanPoint[];
  railingIds: string[];
}

interface Item {
  index: number;
  status: string;
  elementId: string | null;
  requested: unknown;
  actual: StairsActual | null;
  warnings: string[];
  error: string | null;
}

interface Batch {
  committed: boolean;
  items: Item[];
  warnings: string[];
  errors: string[];
  dialogs: unknown[];
}

interface ElementRow {
  id: string;
  category: string | null;
  typeName: string | null;
  levelId: string | null;
  boundingBoxMm: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } } | null;
}

interface ElementsAnswer {
  elements: ElementRow[];
  notFound: string[];
}

const INVALID_PARAMS = -32602;
const NEAR_MM = 0.01;
const SCENE_PITCH_MM = 12000;
/** The height of the first storey, and what the default type gives for it. */
const STOREY_MM = 3000;
const RISERS = 16;
const RISER_MM = STOREY_MM / RISERS;
/** The tread of the default type, and its width of run. */
const TREAD_MM = 250;
const WIDTH_MM = 1000;
/** The riser and the tread of the other type, which differ from those of the default type in every number. */
const OTHER_TREAD_MM = 220;
const OTHER_RISERS = 14;
/** Between the axes of two runs side by side: their width and a gap of 100. */
const RUN_PITCH_MM = WIDTH_MM + 100;
/** Just above the 30000 feet the API allows a run. Revit took every width up to there, however silly, and threw above it. */
const WIDTH_PAST_THE_LIMIT_MM = 9_144_001;
/**
 * A hair under half a tread past 15 treads. Live Revit makes 16 risers of it, while its tread depth, 249.99999999999997, makes the
 * check before the scope count 17. It is the one length known to pass that check and come out wrong, so it is what reaches the check inside the scope.
 */
const LENGTH_THE_CHECK_MISJUDGES_MM = 3874.9999999999995;
const SNAPSHOT_WIDTH_PX = 1200;
/** Other stairs, floors and views stand far from these, so nothing of theirs gets into the picture. */
const PICTURE_SCENE_Y_MM = 500000;

const stamp = new Date().toTimeString().slice(0, 8).replaceAll(":", "");
const name = `проверка-этап3-лестницы-${stamp}`;
const snapshotFolder = path.join(homedir(), "Documents", "RevitMCP", "task8-stairs");

/** What the tests share: the levels, the default type of stairs and the other one, and a wall and a floor type. */
interface World {
  ground: Level;
  upper: Level;
  top: Level;
  stairsType: TypeRow;
  otherType: TypeRow;
  wallType: TypeRow;
  floorType: TypeRow;
}

let world: World | undefined;
let nextSceneX = 0;

async function withClient<T>(body: (client: BridgeClient) => Promise<T>): Promise<T> {
  const client = new BridgeClient(defaultConnectionPath());
  try {
    return await body(client);
  } finally {
    client.close();
  }
}

const modelInfo = (client: BridgeClient): Promise<ModelInfo> => client.call("get_model_info", {}) as Promise<ModelInfo>;

const elementsOf = (client: BridgeClient, ids: string[]): Promise<ElementsAnswer> => client.call("get_elements", { ids }) as Promise<ElementsAnswer>;

const createStairs = (client: BridgeClient, item: StairsItem): Promise<Batch> => client.call("create_stairs", { items: [item] }) as Promise<Batch>;

const listTypes = (client: BridgeClient, category: string): Promise<TypeRow[]> => client.call("list_types", { category }) as Promise<TypeRow[]>;

function ready(): World {
  assert.ok(world, "the first test creates the project");
  return world;
}

/** The x of the next scene, so that no stairs touch. */
function scene(): number {
  const x = nextSceneX;
  nextSceneX += SCENE_PITCH_MM;
  return x;
}

/** A straight stairs of the default type from the ground to the storey above, its one run going up +y from (x, y). */
function straight(x: number, y = 0): StairsItem {
  const w = ready();

  return {
    baseLevelId: w.ground.id,
    topLevelId: w.upper.id,
    typeId: w.stairsType.id,
    runsMm: [{ startMm: { x, y }, endMm: { x, y: y + (RISERS - 1) * TREAD_MM } }],
    widthMm: WIDTH_MM,
    desiredRisers: RISERS,
  };
}

/** A U-shaped stairs: `first` risers going up +y, a landing behind them, and the rest coming back beside them. */
function uShaped(x: number, y = 0, first = RISERS / 2): StairsItem {
  const w = ready();
  const firstLength = (first - 1) * TREAD_MM;
  const secondLength = (RISERS - first - 1) * TREAD_MM;

  return {
    baseLevelId: w.ground.id,
    topLevelId: w.upper.id,
    typeId: w.stairsType.id,
    runsMm: [
      { startMm: { x, y }, endMm: { x, y: y + firstLength } },
      { startMm: { x: x + RUN_PITCH_MM, y: y + firstLength }, endMm: { x: x + RUN_PITCH_MM, y: y + firstLength - secondLength } },
    ],
    widthMm: WIDTH_MM,
    desiredRisers: RISERS,
  };
}

function assertNear(actual: unknown, expected: number, what: string, within = NEAR_MM): void {
  assert.equal(typeof actual, "number", what);
  assert.ok(Math.abs((actual as number) - expected) < within, `${what}: ${String(actual)}, expected ${expected}`);
}

/** The stairs landed with nothing to warn about, and the item is returned. */
function landed(batch: Batch): Item & { elementId: string; actual: StairsActual } {
  assert.equal(batch.committed, true, JSON.stringify(batch).slice(0, 1500));
  assert.deepEqual(batch.errors, []);
  assert.deepEqual(batch.dialogs, []);
  assert.deepEqual(batch.warnings, [], "nothing here should give Revit something to warn about");
  assert.equal(batch.items.length, 1);

  const [item] = batch.items;
  assert.ok(item?.elementId && item.actual, JSON.stringify(batch));
  assert.equal(item.status, "created");
  assert.deepEqual(item.warnings, []);

  return item as Item & { elementId: string; actual: StairsActual };
}

/** What a call can add to the model, to compare before and after one that must leave nothing. */
async function stairsCounts(client: BridgeClient): Promise<Record<string, number>> {
  const info = await modelInfo(client);
  const countOf = (category: string): number => info.categoryCounts.find((entry) => entry.category === category)?.count ?? 0;

  return {
    stairs: countOf("OST_Stairs"),
    runs: countOf("OST_StairsRuns"),
    landings: countOf("OST_StairsLandings"),
    railings: countOf("OST_StairsRailing"),
  };
}

/** Calls create_stairs where it must refuse before anything changes, and returns the refusal. */
async function refusedAndUnchanged(client: BridgeClient, params: object, pattern: RegExp, what: string): Promise<BridgeRpcError> {
  await client.call("save_project", {});
  const before = await stairsCounts(client);

  const error = await client.call("create_stairs", params).then(
    (result) => assert.fail(`${what}: should be refused, and returned ${JSON.stringify(result).slice(0, 500)}`),
    (reason: unknown) => reason,
  );

  assert.ok(error instanceof BridgeRpcError, `${what}: expected a plugin error, got ${String(error)}`);
  assert.equal(error.code, INVALID_PARAMS, error.message);
  assert.match(error.message, pattern, what);
  assert.deepEqual(await stairsCounts(client), before, `${what}: a refused call builds nothing`);
  assert.equal((await modelInfo(client)).activeDocument?.isModified, false, `${what}: a refused call changes nothing`);

  return error;
}

/** A call that must work if nothing of Revit is held up: an open edit mode would stop it, or make it wait until the client gives up. */
async function assertRevitIsFree(client: BridgeClient): Promise<string> {
  const w = ready();
  const y = scene();
  const walls = (await client.call("create_walls", {
    items: [{ startMm: { x: -8000, y }, endMm: { x: -5000, y }, typeId: w.wallType.id, levelId: w.ground.id, heightMm: STOREY_MM }],
  })) as Batch;
  assert.equal(walls.committed, true, JSON.stringify(walls));

  const id = walls.items[0]?.elementId;
  assert.ok(id);
  return id;
}

function boxAround(points: PlanPoint[]): { minX: number; maxX: number; minY: number; maxY: number } {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);

  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

/** Looks at stairs from the side and above, and keeps the picture. */
async function snapshot(client: BridgeClient, title: string, centre: { x: number; y: number }): Promise<void> {
  const view = (await client.call("create_3d_view", {
    name: `${title} ${stamp}`,
    kind: "perspective",
    displayStyle: "realistic",
    eyeMm: { x: centre.x + 7000, y: centre.y - 6000, z: 5000 },
    targetMm: { x: centre.x, y: centre.y, z: 1500 },
  })) as { committed: boolean; viewId: string };
  assert.equal(view.committed, true, JSON.stringify(view));

  const shot = (await client.call("get_view_snapshot", { viewId: view.viewId, widthPx: SNAPSHOT_WIDTH_PX })) as { path: string; dialogs: unknown[] };
  assert.deepEqual(shot.dialogs, []);

  await mkdir(snapshotFolder, { recursive: true });
  const kept = path.join(snapshotFolder, `${title}-${stamp}.png`);
  await copyFile(shot.path, kept);
  console.log(`# snapshot: ${kept}`);
}

describe("stage 3 live checks: stairs", { timeout: 180_000 }, () => {
  it("creates a project for this run", async () => {
    await withClient(async (client) => {
      await client.call("create_project", { name });

      const levels = (await client.call("create_levels", { items: [{ name: `Этаж 2 ${stamp}`, elevationMm: STOREY_MM }] })) as Batch;
      assert.equal(levels.committed, true, JSON.stringify(levels));

      const sorted = [...(await modelInfo(client)).levels].sort((a, b) => a.elevationMm - b.elevationMm);
      const [ground, upper, top] = sorted;
      assert.ok(ground && upper && top);
      assert.equal(upper.elevationMm, STOREY_MM);
      assert.ok(top.elevationMm > upper.elevationMm);

      const stairsTypes = await listTypes(client, "stairs");
      const stairsType = stairsTypes.find((type) => type.name.includes("190") && type.name.includes("250"));
      const otherType = stairsTypes.find((type) => type.name.includes("Частные"));
      const [wallType] = await listTypes(client, "walls");
      const [floorType] = await listTypes(client, "floors");
      assert.ok(stairsType && otherType && wallType && floorType, JSON.stringify(stairsTypes));

      world = { ground, upper, top, stairsType, otherType, wallType, floorType };
      console.log(`# types: ${JSON.stringify({ stairsType, otherType })}`);
    });
  });

  it("every type list_types offers for stairs builds real stairs", async () => {
    await withClient(async (client) => {
      const w = ready();
      const rows = await listTypes(client, "stairs");
      console.log(`# stairs types: ${JSON.stringify(rows)}`);
      assert.ok(rows.length > 0, "the template holds stairs types");

      // The types of the Stair family share the category with the stairs types, and create_stairs refuses them.
      assert.ok(rows.every((row) => row.family !== "Stair"), JSON.stringify(rows));

      for (const row of rows) {
        const x = scene();
        const item = (length: number) => ({
          baseLevelId: w.ground.id,
          topLevelId: w.upper.id,
          typeId: row.id,
          runsMm: [{ startMm: { x, y: 0 }, endMm: { x, y: length } }],
          widthMm: WIDTH_MM,
          desiredRisers: RISERS,
        });

        // The run for RISERS risers depends on the tread depth of the type, which a refusal of a run too short for it states.
        const probe = await refusedAndUnchanged(client, { items: [item(1000)] }, /needs a run of [\d.]+ mm/, `${row.family}: ${row.name}`);
        const needed = /needs a run of ([\d.]+) mm/.exec(probe.message)?.[1];
        assert.ok(needed, probe.message);

        const batch = await createStairs(client, item(Number(needed)));
        console.log(`# ${row.family}: ${row.name} (${row.id}), run ${needed} mm: ${JSON.stringify(batch).slice(0, 1500)}`);
        assert.equal(batch.committed, true, `${row.family}: ${row.name}: ${JSON.stringify(batch).slice(0, 1500)}`);
        assert.deepEqual(batch.errors, []);
        assert.deepEqual(batch.dialogs, []);

        const [built] = batch.items;
        assert.ok(built?.elementId && built.actual, JSON.stringify(batch));
        assert.equal(built.status, "created", JSON.stringify(built));
        assert.equal(built.actual.risers, RISERS);
        assertNear(built.actual.topElevationMm, STOREY_MM, `${row.name}: top`);

        // The type read back from the model is the row asked for.
        assert.equal((await elementsOf(client, [built.elementId])).elements[0]?.typeName, row.name, `${row.family}: ${row.name}`);
      }
    });
  });

  it("straight stairs connect two levels", async () => {
    await withClient(async (client) => {
      const w = ready();
      const x = scene();
      const before = await stairsCounts(client);

      const item = landed(await createStairs(client, straight(x)));

      console.log(`# straight: ${JSON.stringify(item.actual)}`);
      assert.equal(item.actual.risers, RISERS);
      assertNear(item.actual.riserHeightMm, RISER_MM, "riser");
      assertNear(item.actual.treadDepthMm, TREAD_MM, "tread");
      assertNear(item.actual.topElevationMm, STOREY_MM, "top");

      const box = boxAround(item.actual.footprintMm);
      assertNear(box.minX, x - WIDTH_MM / 2, "west side");
      assertNear(box.maxX, x + WIDTH_MM / 2, "east side");
      assertNear(box.minY, 0, "foot");
      assertNear(box.maxY, (RISERS - 1) * TREAD_MM, "head");

      const { elements } = await elementsOf(client, [item.elementId]);
      assert.equal(elements[0]?.category, "stairs");
      assert.equal(elements[0]?.typeName, w.stairsType.name);
      assertNear(elements[0]?.boundingBoxMm?.max.z, STOREY_MM, "the box reaches the storey above", 200);

      // Revit adds the railings itself when the scope closes.
      assert.equal(item.actual.railingIds.length, 2);
      assert.deepEqual(
        (await elementsOf(client, item.actual.railingIds)).elements.map((row) => row.category),
        ["railings", "railings"],
      );

      const after = await stairsCounts(client);
      assert.equal(after["stairs"], (before["stairs"] ?? 0) + 1);
      assert.equal(after["runs"], (before["runs"] ?? 0) + 1);
      assert.equal(after["landings"], before["landings"]);
    });
  });

  it("U-shaped stairs have two runs and a landing", async () => {
    await withClient(async (client) => {
      const x = scene();
      const before = await stairsCounts(client);

      const item = landed(await createStairs(client, uShaped(x)));

      console.log(`# U-shaped: ${JSON.stringify(item.actual)}`);
      assert.equal(item.actual.risers, RISERS);
      assertNear(item.actual.topElevationMm, STOREY_MM, "top");

      const after = await stairsCounts(client);
      assert.equal(after["stairs"], (before["stairs"] ?? 0) + 1);
      assert.equal(after["runs"], (before["runs"] ?? 0) + 2);
      assert.equal(after["landings"], (before["landings"] ?? 0) + 1);

      // The landing lies behind the ends of the runs and is as deep as they are wide.
      const runLength = (RISERS / 2 - 1) * TREAD_MM;
      const box = boxAround(item.actual.footprintMm);
      assertNear(box.minX, x - WIDTH_MM / 2, "west side");
      assertNear(box.maxX, x + RUN_PITCH_MM + WIDTH_MM / 2, "east side");
      assertNear(box.minY, 0, "foot");
      assertNear(box.maxY, runLength + WIDTH_MM, "back of the landing");
      assert.equal(item.actual.railingIds.length, 2);
    });
  });

  it("the footprint goes straight into a floor opening over the stairs", async () => {
    await withClient(async (client) => {
      const w = ready();
      const x = scene();
      const item = landed(await createStairs(client, uShaped(x)));
      const corners = [
        { x: x - 3000, y: -3000 },
        { x: x + 5000, y: -3000 },
        { x: x + 5000, y: 6000 },
        { x: x - 3000, y: 6000 },
      ];
      const floors = (await client.call("create_floors", { items: [{ boundaryMm: corners, typeId: w.floorType.id, levelId: w.upper.id }] })) as Batch;
      assert.equal(floors.committed, true, JSON.stringify(floors));

      const opening = (await client.call("create_floor_openings", { items: [{ floorId: floors.items[0]?.elementId, boundaryMm: item.actual.footprintMm }] })) as Batch;

      assert.equal(opening.committed, true, JSON.stringify(opening));
      assert.equal(opening.items[0]?.status, "created", JSON.stringify(opening));
    });
  });

  it("riser count is reported and matches", async () => {
    await withClient(async (client) => {
      const w = ready();

      // More risers than the default, so a lower riser.
      const many = 18;
      const taller = straight(scene());
      const [run] = taller.runsMm;
      assert.ok(run);
      const lower = landed(
        await createStairs(client, { ...taller, desiredRisers: many, runsMm: [{ startMm: run.startMm, endMm: { x: run.startMm.x, y: (many - 1) * TREAD_MM } }] }),
      );
      assert.equal(lower.actual.risers, many);
      assertNear(lower.actual.riserHeightMm, STOREY_MM / many, "riser of 18");
      assertNear(lower.actual.topElevationMm, STOREY_MM, "top of 18");

      // An unequal split: the second run must start at the height of ten risers.
      const split = landed(await createStairs(client, uShaped(scene(), 0, 10)));
      assert.equal(split.actual.risers, RISERS);
      assertNear(split.actual.topElevationMm, STOREY_MM, "top of 10 + 6");

      // Stairs that start above the origin: the run goes in at the height of its level.
      const upperRisers = 6;
      const upperX = scene();
      const upperStairs = landed(
        await createStairs(client, {
          ...straight(upperX),
          baseLevelId: w.upper.id,
          topLevelId: w.top.id,
          runsMm: [{ startMm: { x: upperX, y: 0 }, endMm: { x: upperX, y: (upperRisers - 1) * TREAD_MM } }],
          desiredRisers: upperRisers,
        }),
      );
      assert.equal(upperStairs.actual.risers, upperRisers);
      assertNear(upperStairs.actual.topElevationMm, w.top.elevationMm, "top on the upper storey");
      assertNear(upperStairs.actual.riserHeightMm, (w.top.elevationMm - w.upper.elevationMm) / upperRisers, "riser on the upper storey");
    });
  });

  it("a new stairs takes the type asked for, and not the type used last", async () => {
    await withClient(async (client) => {
      const w = ready();
      const x = scene();
      const item = await createStairs(client, {
        ...straight(x),
        typeId: w.otherType.id,
        runsMm: [{ startMm: { x, y: 0 }, endMm: { x, y: (OTHER_RISERS - 1) * OTHER_TREAD_MM } }],
        desiredRisers: OTHER_RISERS,
      });
      const other = landed(item);
      assertNear(other.actual.treadDepthMm, OTHER_TREAD_MM, "tread of the other type");
      assert.equal((await elementsOf(client, [other.elementId])).elements[0]?.typeName, w.otherType.name);

      const next = landed(await createStairs(client, straight(scene())));
      assertNear(next.actual.treadDepthMm, TREAD_MM, "tread after the other type");
      assert.equal((await elementsOf(client, [next.elementId])).elements[0]?.typeName, w.stairsType.name);
    });
  });

  it("stairs that cannot reach the top level are not reported as success", async () => {
    await withClient(async (client) => {
      const x = scene();
      const short = straight(x);
      const [run] = short.runsMm;
      assert.ok(run);

      await refusedAndUnchanged(
        client,
        { items: [{ ...short, runsMm: [{ startMm: run.startMm, endMm: { x, y: 1750 } }] }] },
        /8 risers.*desiredRisers is 16/,
        "half a flight",
      );

      const two = uShaped(x);
      const [first, second] = two.runsMm;
      assert.ok(first && second);
      await refusedAndUnchanged(
        client,
        { items: [{ ...two, runsMm: [first, { startMm: second.startMm, endMm: { x: second.endMm.x, y: second.endMm.y + TREAD_MM } }] }] },
        /8 \+ 7 = 15 risers.*desiredRisers is 16/,
        "one riser short over two runs",
      );

      // What passes the check and still comes out short is found on the stairs, inside the scope.
      await client.call("save_project", {});
      const before = await stairsCounts(client);

      const missed = await createStairs(client, { ...short, runsMm: [{ startMm: run.startMm, endMm: { x, y: LENGTH_THE_CHECK_MISJUDGES_MM } }], desiredRisers: 17 });

      console.log(`# one riser short, found inside the scope: ${JSON.stringify(missed).slice(0, 900)}`);
      assert.equal(missed.committed, false, JSON.stringify(missed));
      assert.equal(missed.items[0]?.status, "failed");
      assert.equal(missed.items[0]?.elementId, null);
      assert.equal(missed.items[0]?.actual, null);
      assert.match(missed.items[0]?.error ?? "", /16 risers of the 17/);
      assert.match(missed.items[0]?.error ?? "", /needs a run of 4000 mm/);
      assert.deepEqual(await stairsCounts(client), before, "the scope took its run with it");
    });
  });

  it("run length that gives the wrong risers fails with the needed length", async () => {
    await withClient(async (client) => {
      const x = scene();
      const item = straight(x);
      const [run] = item.runsMm;
      assert.ok(run);

      const tooLong = await refusedAndUnchanged(
        client,
        { items: [{ ...item, runsMm: [{ startMm: run.startMm, endMm: { x, y: 4500 } }] }] },
        /needs a run of 3750 mm/,
        "a run past the top",
      );
      console.log(`# refusal: ${tooLong.message}`);
      assert.match(tooLong.message, /create_stairs item 0/);
      assert.match(tooLong.message, /250 mm/);

      const two = uShaped(x);
      const [first, second] = two.runsMm;
      assert.ok(first && second);
      const split = await refusedAndUnchanged(
        client,
        { items: [{ ...two, runsMm: [first, { startMm: second.startMm, endMm: { x: second.endMm.x, y: second.endMm.y + 2 * TREAD_MM } }] }] },
        /need 3500 mm together/,
        "two runs",
      );
      console.log(`# refusal: ${split.message}`);
    });
  });

  it("a length Revit rounds to the right risers is taken, and the footprint says what came of it", async () => {
    await withClient(async (client) => {
      const x = scene();
      const item = straight(x);
      const [run] = item.runsMm;
      assert.ok(run);

      const fitted = landed(await createStairs(client, { ...item, runsMm: [{ startMm: run.startMm, endMm: { x, y: 3740 } }] }));

      assert.equal(fitted.actual.risers, RISERS);
      assertNear(boxAround(fitted.actual.footprintMm).maxY, 3750, "the head of the run");
    });
  });

  it("refuses what cannot be built, naming the item", async () => {
    await withClient(async (client) => {
      const w = ready();
      const x = scene();
      const good = straight(x);
      const [run] = good.runsMm;
      assert.ok(run);

      for (const [params, pattern, what] of [
        [{ items: [good, good] }, /one stairs in one call/, "two items"],
        [{ items: [{ ...good, typeId: w.wallType.id }] }, /is not a type of stairs/, "a wall type"],
        [{ items: [{ ...good, baseLevelId: "1" }] }, /is not a level/, "no level"],
        [{ items: [{ ...good, topLevelId: good.baseLevelId }] }, /must lie above/, "one level"],
        [{ items: [{ ...good, baseLevelId: w.upper.id, topLevelId: w.ground.id }] }, /must lie above/, "levels the wrong way round"],
        [{ items: [{ ...good, widthMm: 0 }] }, /widthMm/, "no width"],
        [{ items: [{ ...good, widthMm: WIDTH_PAST_THE_LIMIT_MM }] }, /create_stairs item 0: widthMm must be above 0 and at most 9144000.*not 9144001/, "wider than Revit takes"],
        [{ items: [{ ...good, desiredRisers: 1.5 }] }, /desiredRisers/, "half a riser"],
        [{ items: [{ ...good, desiredRisers: 0 }] }, /desiredRisers/, "no risers"],
        [{ items: [{ ...uShaped(x), desiredRisers: 3 }] }, /2 runs take at least 4/, "fewer risers than two runs take"],
        [{ items: [{ ...good, runsMm: [] }] }, /one or two runs/, "no run"],
        [{ items: [{ ...good, runsMm: [run, run, run] }] }, /one or two runs/, "three runs"],
        [{ items: [{ ...good, runsMm: [{ startMm: run.startMm, endMm: run.startMm }] }] }, /shorter than/, "a run of no length"],
      ] as const) {
        await refusedAndUnchanged(client, params, pattern, what);
      }
    });
  });

  it("a run narrower than its type lands with Revit's warning", async () => {
    await withClient(async (client) => {
      const batch = await createStairs(client, { ...straight(scene()), widthMm: 800 });

      assert.equal(batch.committed, true, JSON.stringify(batch));
      assert.equal(batch.items[0]?.status, "created");
      assert.match(batch.warnings.join(" "), /Minimum Run Width/);
    });
  });

  it("a warning from the end of the scope comes back and stops nothing", async () => {
    await withClient(async (client) => {
      const x = scene();
      const before = await stairsCounts(client);

      // Two risers of 1500 are far above the type, and the balusters of the railings Revit adds at the end cannot follow them.
      const batch = await createStairs(client, { ...straight(x), runsMm: [{ startMm: { x, y: 0 }, endMm: { x, y: TREAD_MM } }], desiredRisers: 2 });

      console.log(`# warnings of two risers: ${JSON.stringify(batch.warnings)}`);
      assert.equal(batch.committed, true, JSON.stringify(batch));
      assert.equal(batch.items[0]?.status, "created");
      assert.deepEqual(batch.dialogs, []);
      assert.match(batch.warnings.join(" "), /Maximum Riser Height/);
      assert.match(batch.warnings.join(" "), /automatically resolved/);
      assert.equal((await stairsCounts(client))["stairs"], (before["stairs"] ?? 0) + 1);
    });
  });

  it("failed stairs leave nothing and no open scope", async (t) => {
    await withClient(async (client) => {
      const wallId = await assertRevitIsFree(client);
      await client.call("save_project", {});
      const before = await stairsCounts(client);
      const x = scene();
      const two = uShaped(x);
      const [first] = two.runsMm;
      assert.ok(first);

      // Two runs climbing side by side the same way: nothing before the scope can tell, and Revit says so on the runs it made.
      const apart = await createStairs(client, {
        ...two,
        runsMm: [first, { startMm: { x: x + RUN_PITCH_MM, y: first.startMm.y }, endMm: { x: x + RUN_PITCH_MM, y: first.endMm.y } }],
      });

      console.log(`# no landing: ${JSON.stringify(apart)}`);
      assert.equal(apart.committed, false, JSON.stringify(apart));
      assert.equal(apart.items[0]?.status, "failed", JSON.stringify(apart));
      assert.equal(apart.items[0]?.elementId, null);
      assert.equal(apart.items[0]?.actual, null);
      assert.match(apart.items[0]?.error ?? "", /cannot join the two runs/);
      assert.ok(apart.errors.length > 0, "the reason is in errors too");
      assert.deepEqual(apart.dialogs, []);
      assert.deepEqual(await stairsCounts(client), before, "the scope took its runs with it");

      // Revit is free: both a transaction and a new scope can start, and a good stairs lands at the same place.
      await assertRevitIsFree(client);
      landed(await createStairs(client, straight(x)));

      // Neither failure left a step: what comes off now is that good stairs, then the wall, then the wall before the failures.
      const stairs = await undoWithOneRetry(t, client);
      assert.equal(stairs.transactionName, "MCP: create_stairs");
      await undoWithOneRetry(t, client);
      const wall = await undoWithOneRetry(t, client);
      assert.equal(wall.transactionName, "MCP: create_walls");
      assert.deepEqual((await elementsOf(client, [wallId])).notFound, [wallId]);
    });
  });

  it("one call is one undo step", async (t) => {
    await withClient(async (client) => {
      const wallId = await assertRevitIsFree(client);
      const before = await stairsCounts(client);
      const item = landed(await createStairs(client, uShaped(scene())));

      const stairs = await undoWithOneRetry(t, client);

      console.log(`# undo: ${JSON.stringify({ ...stairs, createdIds: stairs.createdIds.length })}`);
      assert.equal(stairs.transactionName, "MCP: create_stairs");
      assert.ok(stairs.createdIds.includes(item.elementId), "the stairs is named as created");
      for (const id of item.actual.railingIds) {
        assert.ok(stairs.createdIds.includes(id), `railing ${id} comes from the last commit of the scope and is named too`);
      }
      assert.deepEqual((await elementsOf(client, [item.elementId])).notFound, [item.elementId]);
      assert.deepEqual(await stairsCounts(client), before, "runs, landing and railings went with it");
      assert.deepEqual((await elementsOf(client, [wallId])).notFound, [], "the operation below is still there");

      const wall = await undoWithOneRetry(t, client);

      assert.equal(wall.transactionName, "MCP: create_walls");
      assert.deepEqual((await elementsOf(client, [wallId])).notFound, [wallId]);
    });
  });

  it("undo_last_operation reverts the stairs or refuses honestly", async () => {
    await withClient(async (client) => {
      const before = await stairsCounts(client);
      const item = landed(await createStairs(client, straight(scene())));

      const outcome = await undoLastOperation(client).catch((error: unknown) => error);

      if (outcome instanceof BridgeRpcError || outcome instanceof UndoNotConfirmedError) {
        // A refusal is honest only if the stairs really stand.
        console.log(`# undo refused: ${outcome.message}`);
        assert.match(outcome.message, /^(undo_refused: |Not undone: )/);
        assert.deepEqual((await elementsOf(client, [item.elementId])).notFound, []);
      } else {
        assert.ok(!(outcome instanceof Error), String(outcome));
        assert.equal((outcome as { state: string }).state, "undone");
        assert.deepEqual((await elementsOf(client, [item.elementId])).notFound, [item.elementId]);
        assert.deepEqual(await stairsCounts(client), before);
      }
    });
  });

  it("stairs can be looked at, straight and U-shaped", async () => {
    await withClient(async (client) => {
      const straightItem = landed(await createStairs(client, straight(0, PICTURE_SCENE_Y_MM)));
      assert.equal(straightItem.actual.risers, RISERS);
      const u = landed(await createStairs(client, uShaped(SCENE_PITCH_MM, PICTURE_SCENE_Y_MM)));
      assert.equal(u.actual.risers, RISERS);

      await snapshot(client, "лестница-прямая", { x: 0, y: PICTURE_SCENE_Y_MM + 1800 });
      await snapshot(client, "лестница-п-образная", { x: SCENE_PITCH_MM + RUN_PITCH_MM / 2, y: PICTURE_SCENE_Y_MM + 1200 });
    });
  });

  it("leaves Revit in a state the close rule accepts", async () => {
    await withClient(async (client) => {
      await client.call("save_project", {});

      assert.deepEqual(checkCanClose((await modelInfo(client)).openDocuments), { ok: true, reasons: [] });
    });
  });
});
