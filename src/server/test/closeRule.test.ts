import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { checkCanClose, isInsideFolder } from "../src/cli/closeRule.ts";

const FOLDER = "C:\\Users\\Test User\\Documents\\RevitMCP";

describe("can-close path rule", () => {
  it("passes when no document is open", () => {
    assert.deepEqual(checkCanClose([], FOLDER), { ok: true, reasons: [] });
  });

  it("passes for saved documents inside the test folder, in any letter case", () => {
    const documents = [
      { title: "a", path: `${FOLDER}\\a.rvt`, isModified: false },
      { title: "b", path: "c:\\users\\test user\\documents\\revitmcp\\sub\\b.rvt", isModified: false },
      { title: "c", path: "C:/Users/Test User/Documents/RevitMCP/c.rvt", isModified: false },
    ];
    assert.equal(checkCanClose(documents, FOLDER).ok, true);
  });

  it("refuses a modified document", () => {
    const verdict = checkCanClose([{ title: "a", path: `${FOLDER}\\a.rvt`, isModified: true }], FOLDER);
    assert.equal(verdict.ok, false);
    assert.match(verdict.reasons.join("\n"), /unsaved/);
  });

  it("refuses a document that was never saved", () => {
    assert.equal(checkCanClose([{ title: "Project1", path: "", isModified: false }], FOLDER).ok, false);
  });

  it("refuses a sibling folder with the same prefix", () => {
    assert.equal(isInsideFolder(`${FOLDER}2\\a.rvt`, FOLDER), false);
    assert.equal(isInsideFolder(`${FOLDER}-old\\a.rvt`, FOLDER), false);
  });

  it("refuses a path that climbs out of the folder with ..", () => {
    assert.equal(isInsideFolder(`${FOLDER}\\..\\Other\\a.rvt`, FOLDER), false);
    assert.equal(isInsideFolder(`${FOLDER}\\sub\\..\\a.rvt`, FOLDER), true);
  });

  it("refuses a document outside the folder, and the folder itself", () => {
    assert.equal(checkCanClose([{ title: "a", path: "D:\\Work\\a.rvt", isModified: false }], FOLDER).ok, false);
    assert.equal(isInsideFolder(FOLDER, FOLDER), false);
  });

  it("refuses when one document of several is not acceptable", () => {
    const documents = [
      { title: "ok", path: `${FOLDER}\\ok.rvt`, isModified: false },
      { title: "bad", path: "D:\\Work\\bad.rvt", isModified: false },
    ];
    const verdict = checkCanClose(documents, FOLDER);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.reasons.length, 1);
  });

  it("refuses a project template left open as a document, saved or not, in any letter case", () => {
    for (const extension of [".rte", ".RTE", ".Rte"]) {
      const verdict = checkCanClose([{ title: "шаблон", path: `${FOLDER}\\шаблон${extension}`, isModified: false }], FOLDER);

      assert.equal(verdict.ok, false, extension);
      assert.equal(verdict.reasons.length, 1, extension);
      assert.match(verdict.reasons.join("\n"), /template/, extension);
      assert.match(verdict.reasons.join("\n"), /шаблон/, extension);
    }
  });

  it("names a modified template once for each problem it has", () => {
    const verdict = checkCanClose([{ title: "шаблон", path: `${FOLDER}\\шаблон.rte`, isModified: true }], FOLDER);

    assert.equal(verdict.ok, false);
    assert.equal(verdict.reasons.length, 2);
  });

  it("still passes a project whose name only contains .rte", () => {
    const documents = [{ title: "a", path: `${FOLDER}\\a.rte-копия.rvt`, isModified: false }];

    assert.equal(checkCanClose(documents, FOLDER).ok, true);
  });

  it("refuses an answer it cannot read", () => {
    assert.equal(checkCanClose(undefined, FOLDER).ok, false);
    assert.equal(checkCanClose([{ title: "a", path: `${FOLDER}\\a.rvt` }], FOLDER).ok, false);
  });
});
