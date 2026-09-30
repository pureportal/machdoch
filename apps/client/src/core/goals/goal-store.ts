import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { getUserConfigPath } from "../env.js";
import { withCooperativeFileLock } from "../_helpers/with-cooperative-file-lock.helper.js";
import { writeJsonAtomically } from "../_helpers/write-file-atomically.helper.js";
import {
  isSessionGoal,
  type GoalMode,
  type SessionGoal,
} from "../../shared/goals.js";

export interface GoalRecord {
  version: 1;
  mode: GoalMode;
  goal: SessionGoal | null;
}

class InvalidGoalRecordError extends Error {
  constructor(options?: ErrorOptions) {
    super("The saved goal is invalid.", options);
    this.name = "InvalidGoalRecordError";
  }
}

export const getGoalPath = (
  workspaceRoot: string,
  sessionId: string,
): string => {
  const key = createHash("sha256")
    .update(JSON.stringify([resolve(workspaceRoot), sessionId]))
    .digest("hex");
  return join(dirname(getUserConfigPath()), "goals", `${key}.json`);
};

export const readGoalRecord = async (path: string): Promise<GoalRecord> => {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      !("version" in value) ||
      value.version !== 1 ||
      !("mode" in value) ||
      (value.mode !== "machdoch" && value.mode !== "native") ||
      !("goal" in value) ||
      (value.goal !== null && !isSessionGoal(value.goal))
    ) {
      throw new InvalidGoalRecordError();
    }
    return { version: value.version, mode: value.mode, goal: value.goal };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { version: 1, mode: "machdoch", goal: null };
    if (error instanceof SyntaxError)
      throw new InvalidGoalRecordError({ cause: error });
    throw error;
  }
};

export const updateGoalRecord = async (
  path: string,
  update: (record: GoalRecord) => GoalRecord,
): Promise<GoalRecord> =>
  withCooperativeFileLock(path, async () => {
    const record = update(await readGoalRecord(path));
    await writeJsonAtomically(path, record, { mode: 0o600 });
    return record;
  });

export const clearGoalRecord = async (
  path: string,
  mode?: GoalMode,
): Promise<GoalRecord> =>
  withCooperativeFileLock(path, async () => {
    let savedMode: GoalMode = "machdoch";
    try {
      savedMode = (await readGoalRecord(path)).mode;
    } catch (error) {
      if (!(error instanceof InvalidGoalRecordError)) throw error;
    }
    const record: GoalRecord = {
      version: 1,
      mode: mode ?? savedMode,
      goal: null,
    };
    await writeJsonAtomically(path, record, { mode: 0o600 });
    return record;
  });
