import { normalizeOptionalString } from "../../helpers/normalize-optional-string.helper.js";
import type { CliTokenValues } from "./cli-token-options.js";
import {
  RALPH_ACTIONS,
  RALPH_ACTIONS_REQUIRING_SUBJECT,
  RALPH_GENERATION_MODES,
  RALPH_GENERATION_TARGETS,
  RALPH_SCOPES,
  RALPH_WATCH_ACTIONS,
} from "./cli-args-constants.js";
import type {
  RalphCliAction,
  RalphCliGenerationMode,
  RalphCliGenerationTarget,
  RalphCliOptions,
  RalphCliScope,
  RalphWatchCliAction,
} from "./cli-args-types.js";
import {
  fail,
  parseOptionalPositiveInteger,
} from "./parse-cli-primitive.helper.js";

export const createRalphCliOptions = ({
  rest,
  quickRunRequested,
  rawTask,
  values,
}: {
  rest: string[];
  quickRunRequested: boolean;
  rawTask: string | undefined;
  values:
    | Partial<
        Pick<
          CliTokenValues,
          | "prompt"
          | "prompt-file"
          | "flow-json"
          | "flow-json-file"
          | "expected-fingerprint"
          | "watch-json"
          | "watch-json-file"
          | "existing-flow-json"
          | "existing-flow-json-file"
          | "revision"
          | "flow-target"
          | "generation-mode"
          | "param"
          | "params-file"
          | "isolated"
          | "retry-current"
          | "input-json"
          | "input-json-file"
          | "max-rounds"
          | "max-transitions"
          | "instruction-boundary-policy"
          | "trace"
          | "scope"
          | "name"
        >
      >
    | undefined;
}): RalphCliOptions => {
  const rawSchedulerPrompt = normalizeOptionalString(values?.prompt);
  const rawSchedulerPromptFile = normalizeOptionalString(
    values?.["prompt-file"],
  );
  const rawRalphFlowJson = normalizeOptionalString(values?.["flow-json"]);
  const rawRalphFlowJsonFile = normalizeOptionalString(
    values?.["flow-json-file"],
  );
  const rawRalphExpectedFingerprint = normalizeOptionalString(
    values?.["expected-fingerprint"],
  );
  const rawRalphWatchJson = normalizeOptionalString(values?.["watch-json"]);
  const rawRalphWatchJsonFile = normalizeOptionalString(
    values?.["watch-json-file"],
  );
  const rawRalphExistingFlowJson = normalizeOptionalString(
    values?.["existing-flow-json"],
  );
  const rawRalphExistingFlowJsonFile = normalizeOptionalString(
    values?.["existing-flow-json-file"],
  );
  const rawRalphRevision = normalizeOptionalString(values?.revision);
  const rawRalphFlowTarget = normalizeOptionalString(values?.["flow-target"]);
  const rawRalphGenerationMode = normalizeOptionalString(
    values?.["generation-mode"],
  );
  const rawRalphParams = values?.param
    ?.map((entry) => normalizeOptionalString(entry))
    .filter((entry): entry is string => Boolean(entry));
  const rawRalphParamsFile = normalizeOptionalString(values?.["params-file"]);
  const rawRalphIsolated = values?.isolated === true;
  const rawRalphRetryCurrent = values?.["retry-current"] === true;
  const rawRalphInputJson = normalizeOptionalString(values?.["input-json"]);
  const rawRalphInputJsonFile = normalizeOptionalString(
    values?.["input-json-file"],
  );
  const rawRalphMaxRounds = normalizeOptionalString(values?.["max-rounds"]);
  const rawRalphMaxTransitions = normalizeOptionalString(
    values?.["max-transitions"],
  );
  const rawRalphInstructionBoundaryPolicy = normalizeOptionalString(
    values?.["instruction-boundary-policy"],
  );
  const rawRalphTrace = values?.trace === true;
  const rawRalphScope = normalizeOptionalString(values?.scope);
  const rawSchedulerName = normalizeOptionalString(values?.name);
  if (quickRunRequested || rawTask) {
    fail("`machdoch ralph` cannot be combined with --quick or --task.");
  }

  const [rawAction, rawSubject, ...extraPositionals] = rest;
  const actionText = normalizeOptionalString(rawAction) ?? "list";

  if (!RALPH_ACTIONS.has(actionText as RalphCliAction)) {
    fail(
      `Expected \`machdoch ralph\` action to be one of ${Array.from(
        RALPH_ACTIONS,
      ).join(", ")}.`,
    );
  }

  const action = actionText as RalphCliAction;
  const isWatchCommand = action === "watches";
  const isJsonValidationCommand = action === "validate-json";

  if (!isWatchCommand && extraPositionals.length > 0) {
    fail(
      `Command \`ralph ${action}\` does not accept positional arguments: ${extraPositionals.join(" ")}`,
    );
  }

  if (isWatchCommand && extraPositionals.length > 1) {
    fail(
      `Command \`ralph watches\` accepts at most a watch action and watch id: ${[
        rawSubject,
        ...extraPositionals,
      ]
        .filter(Boolean)
        .join(" ")}`,
    );
  }

  if (
    RALPH_ACTIONS_REQUIRING_SUBJECT.has(action) &&
    !normalizeOptionalString(rawSubject)
  ) {
    fail(
      action === "log" || action === "run-detail" || action === "resume"
        ? `Expected a run id after \`machdoch ralph ${action}\`.`
        : `Expected a flow id after \`machdoch ralph ${action}\`.`,
    );
  }

  if (isJsonValidationCommand && normalizeOptionalString(rawSubject)) {
    fail("`machdoch ralph validate-json` does not accept a flow id.");
  }

  const isGenerationCommand = action === "create" || action === "interview";

  if (isGenerationCommand && !rawSchedulerPrompt && !rawSchedulerPromptFile) {
    fail(`\`machdoch ralph ${action}\` expects --prompt or --prompt-file.`);
  }

  if (!isGenerationCommand && (rawSchedulerPrompt || rawSchedulerPromptFile)) {
    fail(
      "--prompt and --prompt-file are only valid for `machdoch ralph create` or `machdoch ralph interview`.",
    );
  }

  if (
    (action === "save" || isJsonValidationCommand) &&
    !rawRalphFlowJson &&
    !rawRalphFlowJsonFile
  ) {
    fail(
      `\`machdoch ralph ${action}\` expects --flow-json. Use --flow-json-file for large payloads.`,
    );
  }

  if (
    (action === "save" || isJsonValidationCommand) &&
    rawRalphFlowJson &&
    rawRalphFlowJsonFile
  ) {
    fail(
      `Use either --flow-json or --flow-json-file for \`machdoch ralph ${action}\`, not both.`,
    );
  }

  if (action !== "save" && !isJsonValidationCommand && rawRalphFlowJson) {
    fail(
      "--flow-json is only valid for `machdoch ralph save` or `machdoch ralph validate-json`.",
    );
  }

  if (action !== "save" && !isJsonValidationCommand && rawRalphFlowJsonFile) {
    fail(
      "--flow-json-file is only valid for `machdoch ralph save` or `machdoch ralph validate-json`.",
    );
  }

  if (action !== "save" && action !== "delete" && rawRalphExpectedFingerprint) {
    fail(
      "--expected-fingerprint is only valid for `machdoch ralph save` or `machdoch ralph delete`.",
    );
  }

  if (action !== "watches" && rawRalphWatchJson) {
    fail("--watch-json is only valid for `machdoch ralph watches create`.");
  }

  if (action !== "watches" && rawRalphWatchJsonFile) {
    fail(
      "--watch-json-file is only valid for `machdoch ralph watches create`.",
    );
  }

  if (
    isGenerationCommand &&
    rawRalphExistingFlowJson &&
    rawRalphExistingFlowJsonFile
  ) {
    fail(
      `Use either --existing-flow-json or --existing-flow-json-file for \`machdoch ralph ${action}\`, not both.`,
    );
  }

  if (
    !isGenerationCommand &&
    (rawRalphExistingFlowJson || rawRalphExistingFlowJsonFile)
  ) {
    if (rawRalphExistingFlowJson) {
      fail(
        "--existing-flow-json is only valid for `machdoch ralph create` or `machdoch ralph interview`.",
      );
    }

    fail(
      "--existing-flow-json-file is only valid for `machdoch ralph create` or `machdoch ralph interview`.",
    );
  }

  if (action === "restore" && !rawRalphRevision) {
    fail("`machdoch ralph restore` expects --revision.");
  }

  if (action !== "restore" && rawRalphRevision) {
    fail("--revision is only valid for `machdoch ralph restore`.");
  }

  if (!isGenerationCommand && rawRalphFlowTarget) {
    fail(
      "--flow-target is only valid for `machdoch ralph create` or `machdoch ralph interview`.",
    );
  }

  if (
    rawRalphFlowTarget &&
    !RALPH_GENERATION_TARGETS.has(
      rawRalphFlowTarget as RalphCliGenerationTarget,
    )
  ) {
    fail(
      "Expected --flow-target to be followed by flow, prompt-block, or refactor.",
    );
  }

  if (action !== "create" && rawRalphGenerationMode) {
    fail("--generation-mode is only valid for `machdoch ralph create`.");
  }

  if (
    rawRalphGenerationMode &&
    !RALPH_GENERATION_MODES.has(
      rawRalphGenerationMode as RalphCliGenerationMode,
    )
  ) {
    fail("Expected --generation-mode to be followed by do-it or interview.");
  }

  if (action !== "run" && rawRalphParams && rawRalphParams.length > 0) {
    fail("--param is only valid for `machdoch ralph run`.");
  }

  if (action !== "run" && rawRalphParamsFile) {
    fail("--params-file is only valid for `machdoch ralph run`.");
  }

  if (action !== "run" && rawRalphIsolated) {
    fail("--isolated is only valid for `machdoch ralph run`.");
  }

  if (
    action === "resume" &&
    !rawRalphRetryCurrent &&
    !rawRalphInputJson &&
    !rawRalphInputJsonFile
  ) {
    fail(
      "`machdoch ralph resume` expects --input-json, --input-json-file, or --retry-current.",
    );
  }

  if (
    action === "resume" &&
    rawRalphRetryCurrent &&
    (rawRalphInputJson || rawRalphInputJsonFile)
  ) {
    fail(
      "Use either --retry-current or an input response for `machdoch ralph resume`, not both.",
    );
  }

  if (
    (action === "resume" || action === "interview") &&
    rawRalphInputJson &&
    rawRalphInputJsonFile
  ) {
    fail(
      `Use either --input-json or --input-json-file for \`machdoch ralph ${action}\`, not both.`,
    );
  }

  if (action !== "resume" && rawRalphRetryCurrent) {
    fail("--retry-current is only valid for `machdoch ralph resume`.");
  }

  if (action !== "resume" && action !== "interview" && rawRalphInputJson) {
    fail(
      "--input-json is only valid for `machdoch ralph resume` or `machdoch ralph interview`.",
    );
  }

  if (action !== "resume" && action !== "interview" && rawRalphInputJsonFile) {
    fail(
      "--input-json-file is only valid for `machdoch ralph resume` or `machdoch ralph interview`.",
    );
  }

  if (!isGenerationCommand && rawRalphMaxRounds) {
    fail(
      "--max-rounds is only valid for `machdoch ralph create` or `machdoch ralph interview`.",
    );
  }

  if (action !== "run" && action !== "resume" && rawRalphMaxTransitions) {
    fail(
      "--max-transitions is only valid for `machdoch ralph run` or `machdoch ralph resume`.",
    );
  }

  if (
    rawRalphInstructionBoundaryPolicy &&
    !["require-match", "original-boundary", "new-boundary"].includes(
      rawRalphInstructionBoundaryPolicy,
    )
  ) {
    fail(
      "--instruction-boundary-policy must be require-match, original-boundary, or new-boundary.",
    );
  }

  if (action !== "resume" && rawRalphInstructionBoundaryPolicy) {
    fail(
      "--instruction-boundary-policy is only valid for `machdoch ralph resume`.",
    );
  }

  if (action !== "log" && rawRalphTrace) {
    fail("--trace is only valid for `machdoch ralph log`.");
  }

  if (rawRalphScope && !RALPH_SCOPES.has(rawRalphScope as RalphCliScope)) {
    fail("Expected Ralph --scope to be followed by user or workspace.");
  }

  const watchActionText = isWatchCommand
    ? (normalizeOptionalString(rawSubject) ?? "list")
    : undefined;

  if (
    watchActionText &&
    !RALPH_WATCH_ACTIONS.has(watchActionText as RalphWatchCliAction)
  ) {
    fail(
      "Expected `machdoch ralph watches` action to be one of list, create, delete, sync, or run.",
    );
  }

  if (
    isWatchCommand &&
    watchActionText === "create" &&
    !rawRalphWatchJson &&
    !rawRalphWatchJsonFile
  ) {
    fail(
      "`machdoch ralph watches create` expects --watch-json or --watch-json-file.",
    );
  }

  if (
    isWatchCommand &&
    watchActionText !== "create" &&
    (rawRalphWatchJson || rawRalphWatchJsonFile)
  ) {
    fail(
      "--watch-json and --watch-json-file are only valid for `machdoch ralph watches create`.",
    );
  }

  if (isWatchCommand && rawRalphWatchJson && rawRalphWatchJsonFile) {
    fail(
      "Use either --watch-json or --watch-json-file for `machdoch ralph watches create`, not both.",
    );
  }

  if (
    isWatchCommand &&
    watchActionText === "delete" &&
    !normalizeOptionalString(extraPositionals[0])
  ) {
    fail("Expected a watch id after `machdoch ralph watches delete`.");
  }

  const ralphSubject = normalizeOptionalString(rawSubject);
  const watchSubject = isWatchCommand
    ? normalizeOptionalString(extraPositionals[0])
    : undefined;
  const ralphMaxRounds = parseOptionalPositiveInteger(
    rawRalphMaxRounds,
    "--max-rounds",
  );
  const ralphMaxTransitions = parseOptionalPositiveInteger(
    rawRalphMaxTransitions,
    "--max-transitions",
  );

  return {
    action,
    ...(isWatchCommand
      ? watchSubject
        ? { subject: watchSubject }
        : {}
      : ralphSubject
        ? { subject: ralphSubject }
        : {}),
    ...(rawRalphScope ? { scope: rawRalphScope as RalphCliScope } : {}),
    ...(rawSchedulerName ? { name: rawSchedulerName } : {}),
    ...(rawSchedulerPrompt ? { prompt: rawSchedulerPrompt } : {}),
    ...(rawSchedulerPromptFile ? { promptFile: rawSchedulerPromptFile } : {}),
    ...(rawRalphFlowJson ? { flowJson: rawRalphFlowJson } : {}),
    ...(rawRalphFlowJsonFile ? { flowJsonFile: rawRalphFlowJsonFile } : {}),
    ...(rawRalphExpectedFingerprint
      ? { expectedFingerprint: rawRalphExpectedFingerprint }
      : {}),
    ...(rawRalphWatchJson ? { watchJson: rawRalphWatchJson } : {}),
    ...(rawRalphWatchJsonFile ? { watchJsonFile: rawRalphWatchJsonFile } : {}),
    ...(rawRalphExistingFlowJson
      ? { existingFlowJson: rawRalphExistingFlowJson }
      : {}),
    ...(rawRalphExistingFlowJsonFile
      ? { existingFlowJsonFile: rawRalphExistingFlowJsonFile }
      : {}),
    ...(rawRalphRevision ? { revision: rawRalphRevision } : {}),
    ...(rawRalphFlowTarget
      ? { target: rawRalphFlowTarget as RalphCliGenerationTarget }
      : {}),
    ...(rawRalphGenerationMode
      ? {
          generationMode: rawRalphGenerationMode as RalphCliGenerationMode,
        }
      : {}),
    ...(rawRalphParams && rawRalphParams.length > 0
      ? { params: rawRalphParams }
      : {}),
    ...(rawRalphParamsFile ? { paramsFile: rawRalphParamsFile } : {}),
    ...(rawRalphInputJson ? { inputJson: rawRalphInputJson } : {}),
    ...(rawRalphInputJsonFile ? { inputJsonFile: rawRalphInputJsonFile } : {}),
    ...(rawRalphRetryCurrent ? { retryCurrent: true } : {}),
    ...(rawRalphIsolated ? { isolated: true } : {}),
    ...(ralphMaxRounds !== undefined ? { maxRounds: ralphMaxRounds } : {}),
    ...(ralphMaxTransitions !== undefined
      ? { maxTransitions: ralphMaxTransitions }
      : {}),
    ...(rawRalphInstructionBoundaryPolicy
      ? {
          instructionBoundaryPolicy: rawRalphInstructionBoundaryPolicy as
            | "require-match"
            | "original-boundary"
            | "new-boundary",
        }
      : {}),
    ...(rawRalphTrace ? { trace: true } : {}),
    ...(watchActionText
      ? { watchAction: watchActionText as RalphWatchCliAction }
      : {}),
  };
};
