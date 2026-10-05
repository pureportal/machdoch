import { lstat, readFile } from "node:fs/promises";
import { readRalphUtilityValuePath } from "./evaluate-ralph-utility-condition.helper.js";
import { writeFileAtomically } from "./write-file-atomically.helper.js";

export const recoverRalphArchivedWorkJournal = async (input: {
  path: string;
  archivePath: string;
  jsonPath: string;
  taskIds: readonly string[];
  runId: string;
}): Promise<unknown> => {
  const raw = await readFile(input.archivePath, "utf8");
  const json: unknown = JSON.parse(raw);
  const value = readRalphUtilityValuePath(json, input.jsonPath);
  const tasks: readonly unknown[] = Array.isArray(value) ? value : [];
  if (input.taskIds.length === 0)
    throw new Error("Archive recovery requires selected task identities.");
  for (const id of input.taskIds) {
    const task = tasks.find(
      (candidate) =>
        typeof candidate === "object" &&
        candidate !== null &&
        (candidate as Record<string, unknown>).id === id,
    ) as Record<string, unknown> | undefined;
    if (
      !task ||
      task.runId !== input.runId ||
      !Array.isArray(task.stateHistory) ||
      task.stateHistory.at(-1)?.runId !== input.runId
    ) {
      throw new Error(
        "Archived selected work does not belong to the checkpoint run.",
      );
    }
  }
  await writeFileAtomically(input.path, raw, "utf8", {
    beforeCommit: async () => {
      try {
        await lstat(input.path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      throw new Error(
        "The canonical work journal reappeared during archive recovery.",
      );
    },
  });
  return json;
};
