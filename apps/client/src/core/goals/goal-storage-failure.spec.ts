import * as filesystem from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readGoalRecord,
  updateGoalRecord,
  type GoalRecord,
} from "./goal-store.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    mkdir: vi.fn(original.mkdir),
    open: vi.fn(original.open),
    rename: vi.fn(original.rename),
  };
});

const saved: GoalRecord = {
  version: 1,
  mode: "machdoch",
  goal: {
    id: "interrupted-goal",
    objective: "Verify every recovery path",
    mode: "machdoch",
    status: "active",
    turns: 4,
    tokensUsed: 850,
    elapsedMs: 12_000,
    tokenBudget: 4_000,
    timeBudgetMs: 60_000,
    reason: "",
    createdAt: 1,
    updatedAt: 2,
  },
};

let directory: string | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  if (directory)
    await filesystem.rm(directory, { recursive: true, force: true });
  directory = undefined;
});

describe("goal recovery after disk exhaustion", () => {
  it.each(["lock-owner", "open", "partial-write", "flush", "replace"])(
    "preserves the goal and consumed budget when %s fails",
    async (failure) => {
      directory = await filesystem.mkdtemp(
        join(tmpdir(), "machdoch-goal-disk-full-"),
      );
      const path = join(directory, "goal.json");
      await filesystem.writeFile(path, JSON.stringify(saved));
      const originalBytes = await filesystem.readFile(path);
      const error = Object.assign(new Error("no space left on device"), {
        code: "ENOSPC",
      });
      const original =
        await vi.importActual<typeof import("node:fs/promises")>(
          "node:fs/promises",
        );

      if (failure === "lock-owner") {
        vi.mocked(filesystem.mkdir).mockImplementation(async (...args) => {
          if (String(args[0]).includes("owner.")) throw error;
          return original.mkdir(...args);
        });
      } else if (failure === "replace") {
        vi.mocked(filesystem.rename).mockImplementation(
          async (source, destination) => {
            if (String(destination) === path) throw error;
            return original.rename(source, destination);
          },
        );
      } else {
        vi.mocked(filesystem.open).mockImplementation(async (...args) => {
          if (!String(args[0]).endsWith(".tmp")) return original.open(...args);
          if (failure === "open") throw error;
          const handle = await original.open(...args);
          if (failure === "partial-write") {
            vi.spyOn(handle, "writeFile").mockImplementationOnce(async () => {
              await handle.write('{"version":1,');
              throw error;
            });
          } else {
            vi.spyOn(handle, "sync").mockRejectedValueOnce(error);
          }
          return handle;
        });
      }

      const update = vi.fn(
        (current: GoalRecord): GoalRecord => ({
          ...current,
          goal: { ...current.goal!, tokensUsed: 1_000, updatedAt: 3 },
        }),
      );
      await expect(updateGoalRecord(path, update)).rejects.toBe(error);
      expect(await filesystem.readFile(path)).toEqual(originalBytes);
      expect(await readGoalRecord(path)).toEqual(saved);
      expect(await filesystem.readdir(directory)).toEqual(["goal.json"]);
      expect(update).toHaveBeenCalledTimes(failure === "lock-owner" ? 0 : 1);

      vi.mocked(filesystem.mkdir).mockImplementation(original.mkdir);
      vi.mocked(filesystem.open).mockImplementation(original.open);
      vi.mocked(filesystem.rename).mockImplementation(original.rename);
      const resumed = await updateGoalRecord(path, (current) => ({
        ...current,
        goal: { ...current.goal!, status: "active", updatedAt: 4 },
      }));
      expect(resumed.goal).toEqual({ ...saved.goal, updatedAt: 4 });
      expect(await filesystem.readdir(directory)).toEqual(["goal.json"]);
    },
  );
});
