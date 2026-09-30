import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isSessionGoal, type SessionGoal } from "../../shared/goals.js";
import { clearGoalRecord, readGoalRecord } from "./goal-store.js";

let directory: string;
let path: string;

const goal: SessionGoal = {
  id: "test-goal",
  objective: "Fix auth",
  mode: "machdoch",
  status: "active",
  turns: 0,
  tokensUsed: 0,
  elapsedMs: 0,
  reason: "",
  createdAt: 0,
  updatedAt: 0,
};

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "machdoch-goal-store-test-"));
  path = join(directory, "goal.json");
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("saved goal validation", () => {
  it.each([
    null,
    [],
    "goal",
    1,
    {},
    { version: 1, mode: ["machdoch"], goal: null },
    { version: 1, mode: "machdoch" },
    { version: 1, mode: "machdoch", goal: { ...goal, mode: ["machdoch"] } },
    { version: 1, mode: "machdoch", goal: { ...goal, status: ["active"] } },
    { version: 1, mode: "machdoch", goal: { ...goal, objective: " \n " } },
  ])("rejects invalid saved state %j", async (record) => {
    await writeFile(path, JSON.stringify(record));
    await expect(readGoalRecord(path)).rejects.toThrow(
      "The saved goal is invalid.",
    );
  });

  it("reads the current goal format without coercion", async () => {
    const record = { version: 1, mode: "machdoch", goal };
    await writeFile(path, JSON.stringify(record));
    expect(await readGoalRecord(path)).toEqual(record);
    expect(isSessionGoal(goal)).toBe(true);
  });

  it("returns an empty record only when storage does not exist", async () => {
    expect(await readGoalRecord(path)).toEqual({
      version: 1,
      mode: "machdoch",
      goal: null,
    });
    await writeFile(path, "{invalid");
    await expect(readGoalRecord(path)).rejects.toThrow(
      "The saved goal is invalid.",
    );
  });

  it.each(["null", "{invalid", '{"version":1,"mode":"invalid","goal":null}'])(
    "clears damaged state only when explicitly requested: %s",
    async (content) => {
      await writeFile(path, content);
      await expect(readGoalRecord(path)).rejects.toThrow("invalid");
      expect(await clearGoalRecord(path, "native")).toEqual({
        version: 1,
        mode: "native",
        goal: null,
      });
      expect(await readGoalRecord(path)).toEqual({
        version: 1,
        mode: "native",
        goal: null,
      });
    },
  );

  it("preserves the selected mode when clearing a valid record", async () => {
    await writeFile(path, JSON.stringify({ version: 1, mode: "native", goal }));
    expect((await clearGoalRecord(path)).mode).toBe("native");
  });

  it("does not replace storage when clearing fails to read it", async () => {
    await mkdir(path);
    await expect(clearGoalRecord(path)).rejects.toMatchObject({
      code: "EISDIR",
    });
  });
});
