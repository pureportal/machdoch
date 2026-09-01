import { normalize } from "node:path";
import type { RalphBlockExecutionResult, RalphFlowBlock } from "../ralph.js";
import { isTerminalRalphWorkItemState } from "./transition-ralph-work-item-state.helper.js";

export interface RalphJsonTaskClaim {
  path: string;
  jsonPath?: string;
  taskIds: Set<string>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const normalizeClaimPath = (value: string): string => {
  const path = normalize(value);
  return process.platform === "win32" ? path.toLowerCase() : path;
};

const readStringList = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.flatMap((entry) =>
        typeof entry === "string" && entry.length > 0 ? [entry] : [],
      )
    : [];

export const collectActiveRalphJsonTaskClaims = (
  blocks: readonly RalphFlowBlock[],
  results: readonly RalphBlockExecutionResult[],
): RalphJsonTaskClaim[] => {
  const blocksById = new Map(blocks.map((block) => [block.id, block]));
  const claimsByPath = new Map<
    string,
    Map<string | undefined, RalphJsonTaskClaim>
  >();

  for (const result of results) {
    const block = blocksById.get(result.blockId);
    if (block?.type !== "UTILITY" || !isRecord(result.data)) {
      continue;
    }

    if (
      block.utility.type === "SELECT_JSON_TASK" &&
      result.output === "SELECTED" &&
      typeof result.data.path === "string"
    ) {
      const jsonPath =
        typeof result.data.jsonPath === "string"
          ? result.data.jsonPath
          : undefined;
      const normalizedPath = normalizeClaimPath(result.data.path);
      const pathClaims = claimsByPath.get(normalizedPath) ?? new Map();
      const claim = pathClaims.get(jsonPath) ?? {
        path: result.data.path,
        ...(jsonPath ? { jsonPath } : {}),
        taskIds: new Set<string>(),
      };
      for (const taskId of readStringList(result.data.taskIds)) {
        claim.taskIds.add(taskId);
      }
      pathClaims.set(jsonPath, claim);
      claimsByPath.set(normalizedPath, pathClaims);
      continue;
    }

    if (
      block.utility.type === "MARK_JSON_TASK" &&
      result.output === "SUCCESS" &&
      typeof result.data.path === "string" &&
      isTerminalRalphWorkItemState(result.data.status)
    ) {
      const jsonPath =
        typeof result.data.jsonPath === "string"
          ? result.data.jsonPath
          : undefined;
      const claim = claimsByPath
        .get(normalizeClaimPath(result.data.path))
        ?.get(jsonPath);
      if (!claim) {
        continue;
      }
      for (const taskId of readStringList(result.data.taskIds)) {
        claim.taskIds.delete(taskId);
      }
      continue;
    }

    if (
      block.utility.type === "ARCHIVE_FILE" &&
      result.output === "SUCCESS" &&
      typeof result.data.from === "string"
    ) {
      claimsByPath.delete(normalizeClaimPath(result.data.from));
    }
  }

  return [...claimsByPath.values()]
    .flatMap((pathClaims) => [...pathClaims.values()])
    .filter((claim) => claim.taskIds.size > 0);
};
