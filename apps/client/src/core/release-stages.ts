import {
  isReleaseStage,
  type ReleaseStage,
} from "./runtime-contract.generated.js";

export const RELEASE_STAGE_LABELS: Readonly<Record<ReleaseStage, string>> = {
  "early-alpha": "Early Alpha",
  beta: "Beta",
  production: "In Production",
};

const RELEASE_STAGE_GUIDANCE: Readonly<Record<ReleaseStage, string>> = {
  "early-alpha":
    "Nothing depends on this project being stable yet. Breaking changes are welcome when they improve the result: refactor broadly, redesign APIs, data models, and database schemas, and replace or reset existing data without migrations or backward compatibility.",
  beta: "Testers and their data may depend on this project. Make breaking changes only when they clearly pay off and keep them controlled: migrate existing data instead of discarding it, keep refactors within the task's scope, and name every breaking change in the final response.",
  production:
    "Real users and data depend on this project. Be cautious: prefer small, backward-compatible changes; never drop, reset, or destructively rewrite data or database schemas; use additive, reversible migrations; avoid broad refactors and changes to public APIs or data formats unless the current task explicitly requires them; and report any remaining risk to existing behavior or data in the final response.",
};

export const parseReleaseStage = (value: unknown): ReleaseStage | undefined => {
  const normalized =
    typeof value === "string" ? value.trim().toLowerCase() : value;
  return isReleaseStage(normalized) ? normalized : undefined;
};

export const resolveWorkspaceReleaseStage = (
  value: unknown,
): ReleaseStage | undefined => {
  if (value === undefined) {
    return undefined;
  }
  if (isReleaseStage(value)) {
    return value;
  }
  throw new Error(
    "workspace.releaseStage must be early-alpha, beta, or production.",
  );
};

export const createReleaseStagePromptSection = (stage: ReleaseStage): string =>
  [
    "<workspace_release_stage>",
    `Release stage: ${RELEASE_STAGE_LABELS[stage]}.`,
    RELEASE_STAGE_GUIDANCE[stage],
    "</workspace_release_stage>",
  ].join("\n");
