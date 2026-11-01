import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { getUserConfigPath } from "../env.js";
import {
  CooperativeFileLockTimeoutError,
  withCooperativeFileLock,
} from "../_helpers/with-cooperative-file-lock.helper.js";
import { writeJsonAtomically } from "../_helpers/write-file-atomically.helper.js";
import {
  isSessionGoal,
  type GoalMode,
  type SessionGoal,
} from "../../shared/goals.js";

export const GOAL_REQUIREMENT_STATUSES = [
  "verified",
  "missing",
  "failed",
] as const;
export type GoalRequirementStatus = (typeof GOAL_REQUIREMENT_STATUSES)[number];

export interface GoalRequirement {
  text: string;
  status: GoalRequirementStatus;
  evidence: string;
}

export interface GoalVerdict {
  turn: number;
  decision: "complete" | "continue" | "blocked";
  summary: string;
  requirements: GoalRequirement[];
  createdAt: number;
}

export interface GoalRecord {
  version: 1;
  mode: GoalMode;
  goal: SessionGoal | null;
  nextStep?: string;
  verdicts?: GoalVerdict[];
}

const MAX_SAVED_VERDICTS = 20;

class InvalidGoalRecordError extends Error {
  constructor(options?: ErrorOptions) {
    super("The saved goal is invalid.", options);
    this.name = "InvalidGoalRecordError";
  }
}

const getGoalsDirectory = (): string =>
  join(dirname(getUserConfigPath()), "goals");

export const getGoalPath = (
  workspaceRoot: string,
  sessionId: string,
): string => {
  const key = createHash("sha256")
    .update(JSON.stringify([resolve(workspaceRoot), sessionId]))
    .digest("hex");
  return join(getGoalsDirectory(), `${key}.json`);
};

const isGoalRequirement = (value: unknown): value is GoalRequirement => {
  if (typeof value !== "object" || value === null) return false;
  const requirement = value as Record<string, unknown>;
  return (
    typeof requirement.text === "string" &&
    typeof requirement.evidence === "string" &&
    GOAL_REQUIREMENT_STATUSES.includes(
      requirement.status as GoalRequirementStatus,
    )
  );
};

const isGoalVerdict = (value: unknown): value is GoalVerdict => {
  if (typeof value !== "object" || value === null) return false;
  const verdict = value as Record<string, unknown>;
  return (
    typeof verdict.turn === "number" &&
    typeof verdict.summary === "string" &&
    typeof verdict.createdAt === "number" &&
    ["complete", "continue", "blocked"].includes(String(verdict.decision)) &&
    Array.isArray(verdict.requirements) &&
    verdict.requirements.every(isGoalRequirement)
  );
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
    return {
      version: value.version,
      mode: value.mode,
      goal: value.goal,
      ...("nextStep" in value && typeof value.nextStep === "string"
        ? { nextStep: value.nextStep }
        : {}),
      ...("verdicts" in value &&
      Array.isArray(value.verdicts) &&
      value.verdicts.every(isGoalVerdict)
        ? { verdicts: value.verdicts }
        : {}),
    };
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

export const appendGoalVerdict = (
  record: GoalRecord,
  verdict: GoalVerdict,
): GoalRecord => ({
  ...record,
  verdicts: [...(record.verdicts ?? []), verdict].slice(-MAX_SAVED_VERDICTS),
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

export const INTERRUPTED_GOAL_REASON =
  "Execution interrupted. Resume to continue.";

/**
 * Pauses the active goal unless a live run holds it. Returns the current record.
 */
export const pauseGoalIfInterrupted = async (
  path: string,
  signal?: AbortSignal,
): Promise<GoalRecord> => {
  try {
    return await withCooperativeFileLock(
      `${path}.run`,
      () =>
        updateGoalRecord(path, (current) => ({
          ...current,
          goal:
            current.goal?.status === "active"
              ? {
                  ...current.goal,
                  status: "paused",
                  reason: INTERRUPTED_GOAL_REASON,
                  updatedAt: Date.now(),
                }
              : current.goal,
        })),
      { timeoutMs: 1_000, ...(signal ? { signal } : {}) },
    );
  } catch (error) {
    if (
      !(error instanceof CooperativeFileLockTimeoutError) ||
      !["active", "initializing"].includes(error.inspection.state)
    )
      throw error;
    return readGoalRecord(path);
  }
};

/** Goals left `active` by a run that died stay that way until something looks. */
export const pauseInterruptedGoals = async (): Promise<void> => {
  const directory = getGoalsDirectory();
  const names = await readdir(directory).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  });
  for (const name of names) {
    if (!/^[0-9a-f]{64}\.json$/u.test(name)) continue;
    const path = join(directory, name);
    try {
      if ((await readGoalRecord(path)).goal?.status === "active") {
        await pauseGoalIfInterrupted(path);
      }
    } catch (error) {
      if (!(error instanceof InvalidGoalRecordError)) {
        console.error(`Could not check saved goal ${name}`, error);
      }
    }
  }
};
