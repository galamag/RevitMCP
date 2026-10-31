import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

import { PROTOCOL_VERSION } from "../src/client.ts";
import { tools } from "../src/registry.ts";

interface Contract {
  protocolVersion: number;
  methods: string[];
}

async function loadContract(): Promise<Contract> {
  const file = path.resolve(import.meta.dirname, "../../contract/protocol.json");
  return JSON.parse(await readFile(file, "utf8")) as Contract;
}

describe("contract with the plugin", () => {
  it("contract: every registered tool is in protocol.json", async () => {
    const contract = await loadContract();

    for (const tool of tools) {
      assert.ok(contract.methods.includes(tool.name), `tool ${tool.name} is not a method in protocol.json`);
    }
  });

  it("contract: every method in protocol.json is a registered tool", async () => {
    const contract = await loadContract();
    const names = new Set(tools.map((tool) => tool.name));

    for (const method of contract.methods) {
      assert.ok(names.has(method), `method ${method} has no tool`);
    }
  });

  it("registers each tool once", () => {
    const names = tools.map((tool) => tool.name);

    assert.equal(new Set(names).size, names.length);
  });

  it("speaks the protocol version the contract states", async () => {
    const contract = await loadContract();

    assert.equal(PROTOCOL_VERSION, contract.protocolVersion);
  });

  it("describes every tool for the model in English", () => {
    for (const tool of tools) {
      assert.ok(tool.description.length >= 80, `${tool.name} needs a real description`);
      assert.doesNotMatch(tool.description, /[Ѐ-ӿ]/, `${tool.name} description must be English`);
    }
  });
});
