import { readFile } from "node:fs/promises";

export interface RalphRunIntegration {
  status: "merged" | "no-changes";
  mergedAt: string;
  changedPaths: string[];
}

interface PendingIntegration {
  sourceHead: string;
  sourceTree: string;
  runTree: string;
  mergedTree: string;
  mergedCommit: string;
  result: RalphRunIntegration;
}

export interface RalphIntegrationState {
  baseCommit: string;
  pending?: PendingIntegration;
  last?: RalphRunIntegration;
}

export const readRalphIntegrationState = async (
  path: string,
  baseCommit: string,
): Promise<RalphIntegrationState> => {
  let state: RalphIntegrationState;
  try {
    state = JSON.parse(await readFile(path, "utf8")) as RalphIntegrationState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { baseCommit };
    throw error;
  }
  if (
    typeof state !== "object" ||
    state === null ||
    Array.isArray(state) ||
    (state.pending !== undefined &&
      (typeof state.pending !== "object" ||
        state.pending === null ||
        Array.isArray(state.pending)))
  ) {
    throw new Error("RALPH integration record is invalid.");
  }
  const commits = [
    state.baseCommit,
    ...(state.pending
      ? [
          state.pending.sourceHead,
          state.pending.sourceTree,
          state.pending.runTree,
          state.pending.mergedTree,
          state.pending.mergedCommit,
        ]
      : []),
  ];
  const results = [state.last, state.pending?.result].filter(
    (result) => result !== undefined,
  );
  if (
    commits.some(
      (commit) =>
        typeof commit !== "string" ||
        !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(commit),
    ) ||
    results.some(
      (result) =>
        typeof result !== "object" ||
        result === null ||
        Array.isArray(result) ||
        (result.status !== "merged" && result.status !== "no-changes") ||
        typeof result.mergedAt !== "string" ||
        !Number.isFinite(Date.parse(result.mergedAt)) ||
        !Array.isArray(result.changedPaths) ||
        result.changedPaths.some((path) => typeof path !== "string"),
    ) ||
    (state.pending && !state.pending.result)
  ) {
    throw new Error("RALPH integration record is invalid.");
  }
  return state;
};
