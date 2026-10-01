import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readRalphIntegrationState } from "./ralph-integration-state.helper.js";

const baseCommit = "a".repeat(40);
const result = {
  status: "merged",
  mergedAt: "2026-10-01T00:00:00.000Z",
  changedPaths: ["source.txt"],
};
const pending = {
  sourceHead: baseCommit,
  sourceTree: baseCommit,
  runTree: baseCommit,
  mergedTree: baseCommit,
  mergedCommit: baseCommit,
  result,
};

let directory: string;
let path: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "ralph-merge-state-"));
  path = join(directory, "state.json");
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("RALPH integration journal", () => {
  it("starts from the run baseline when no journal exists", async () => {
    expect(await readRalphIntegrationState(path, baseCommit)).toEqual({
      baseCommit,
    });
  });

  it("reads an interrupted integration and its previous result", async () => {
    const state = { baseCommit, pending, last: result };
    await writeFile(path, JSON.stringify(state));
    expect(await readRalphIntegrationState(path, baseCommit)).toEqual(state);
  });

  it.each([
    null,
    false,
    [],
    { baseCommit, pending: null },
    { baseCommit, pending: false },
    { baseCommit, pending: [] },
    { baseCommit, pending: { ...pending, result: undefined } },
    { baseCommit, pending: { ...pending, mergedTree: "a".repeat(41) } },
    { baseCommit, last: "merged" },
    { baseCommit, last: { ...result, mergedAt: "invalid" } },
    { baseCommit, last: { ...result, changedPaths: [false] } },
  ])("rejects invalid stored state without modifying it: %j", async (state) => {
    const contents = JSON.stringify(state);
    await writeFile(path, contents);
    await expect(readRalphIntegrationState(path, baseCommit)).rejects.toThrow(
      "integration record is invalid",
    );
    expect(await readFile(path, "utf8")).toBe(contents);
  });

  it("surfaces corrupt JSON", async () => {
    await writeFile(path, "{");
    await expect(readRalphIntegrationState(path, baseCommit)).rejects.toThrow(
      SyntaxError,
    );
  });
});
