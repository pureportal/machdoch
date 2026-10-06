import { normalizeOptionalString } from "../../helpers/normalize-optional-string.helper.js";
import type { CliTokenValues } from "./cli-token-options.js";
import { INSTRUCTION_ACTIONS, RALPH_SCOPES } from "./cli-args-constants.js";
import type {
  InstructionCliAction,
  InstructionCliGroup,
  InstructionCliOptions,
  RalphCliScope,
} from "./cli-args-types.js";
import { fail, parseOptionalInteger } from "./parse-cli-primitive.helper.js";

const assertInstructionOptionAllowed = (
  provided: boolean,
  option: string,
  action: InstructionCliAction,
  allowedActions: readonly InstructionCliAction[],
): void => {
  if (!provided || allowedActions.includes(action)) return;
  fail(
    `${option} is not valid for \`machdoch instructions ${action.replace("-", " ")}\`.`,
  );
};

export const createInstructionCliOptions = ({
  rest,
  quickRunRequested,
  rawTask,
  values,
  suppliedOptionNames,
}: {
  rest: string[];
  quickRunRequested: boolean;
  rawTask: string | undefined;
  values:
    | Partial<
        Pick<
          CliTokenValues,
          | "surface"
          | "name"
          | "prompt-file"
          | "path"
          | "expected-revision"
          | "expected-digest"
          | "decisions-file"
          | "metadata-json"
          | "profile"
          | "description"
          | "ralph-flow"
          | "flow-scope"
          | "prompt"
          | "include-content"
          | "include-workspaces"
          | "confirm-assignment-removal"
          | "runtime-provider"
          | "model"
          | "reasoning"
        >
      >
    | undefined;
  suppliedOptionNames: string[];
}): InstructionCliOptions => {
  const rawInstructionSurface = normalizeOptionalString(values?.surface);
  const rawSchedulerName = normalizeOptionalString(values?.name);
  const rawSchedulerPromptFile = normalizeOptionalString(
    values?.["prompt-file"],
  );
  const rawInstructionPath = normalizeOptionalString(values?.path);
  const rawInstructionExpectedRevision = normalizeOptionalString(
    values?.["expected-revision"],
  );
  const rawInstructionExpectedDigest = normalizeOptionalString(
    values?.["expected-digest"],
  );
  const rawInstructionDecisionsFile = normalizeOptionalString(
    values?.["decisions-file"],
  );
  const rawInstructionMetadataJson = normalizeOptionalString(
    values?.["metadata-json"],
  );
  const rawInstructionProfileIds = values?.profile
    ?.map((entry) => normalizeOptionalString(entry))
    .filter((entry): entry is string => Boolean(entry));
  const rawInstructionDescription =
    typeof values?.description === "string" ? values.description : undefined;
  const rawInstructionRalphFlow = normalizeOptionalString(
    values?.["ralph-flow"],
  );
  const rawInstructionRalphFlowScope = normalizeOptionalString(
    values?.["flow-scope"],
  );
  if (quickRunRequested || rawTask) {
    fail("`machdoch instructions` cannot be combined with --quick or --task.");
  }

  const instructionGroups = new Set<InstructionCliGroup>([
    "profiles",
    "assignments",
    "workspaces",
    "transfer",
    "recovery",
  ]);
  const [rawFirst, rawSecond, rawThird, rawFourth, ...extraPositionals] = rest;
  const firstInstructionWord = normalizeOptionalString(rawFirst) ?? "profiles";
  const group = instructionGroups.has(
    firstInstructionWord as InstructionCliGroup,
  )
    ? (firstInstructionWord as InstructionCliGroup)
    : undefined;
  if (
    group === undefined &&
    firstInstructionWord !== "resolve" &&
    firstInstructionWord !== "validate"
  ) {
    fail(
      `Unknown instruction command \`${firstInstructionWord}\`. Use profiles, assignments, workspaces, transfer, recovery, resolve, or validate.`,
    );
  }
  const groupAction = normalizeOptionalString(rawSecond);
  const instructionGroupPrefix: Record<InstructionCliGroup, string> = {
    profiles: "profile",
    assignments: "assignment",
    workspaces: "workspace",
    transfer: "transfer",
    recovery: "recovery",
  };
  const actionText = group
    ? `${instructionGroupPrefix[group]}-${
        groupAction ?? (group === "recovery" ? "status" : "list")
      }`
    : firstInstructionWord;
  const action = actionText as InstructionCliAction;
  if (!INSTRUCTION_ACTIONS.has(action)) {
    fail(
      `Unknown instruction command \`${[firstInstructionWord, groupAction]
        .filter(Boolean)
        .join(
          " ",
        )}\`. Use profiles, assignments, workspaces, transfer, recovery, resolve, or validate.`,
    );
  }
  const instructionOptionNames = new Set([
    "json",
    "verbose",
    "help",
    "cwd",
    "runtime-provider",
    "model",
    "reasoning",
    "name",
    "description",
    "profile",
    "expected-revision",
    "expected-digest",
    "surface",
    "include-content",
    "include-workspaces",
    "decisions-file",
    "confirm-assignment-removal",
    "metadata-json",
    "prompt",
    "prompt-file",
    "path",
    "ralph-flow",
    "flow-scope",
  ]);
  const unsupportedInstructionOption = suppliedOptionNames.find(
    (name) => !instructionOptionNames.has(name),
  );
  if (unsupportedInstructionOption) {
    fail(
      `--${unsupportedInstructionOption} is not valid for \`machdoch instructions\`.`,
    );
  }
  const rawSubject = group ? rawThird : rawSecond;
  const rawSecondarySubject = group ? rawFourth : rawThird;
  const unexpected = [
    ...(group ? [] : rawFourth ? [rawFourth] : []),
    ...extraPositionals,
  ].filter((entry): entry is string => typeof entry === "string");
  if (unexpected.length > 0) {
    fail(
      `Command \`instructions ${firstInstructionWord}\` has unexpected positional arguments: ${unexpected.join(" ")}`,
    );
  }
  if (
    rawInstructionSurface &&
    rawInstructionSurface !== "api" &&
    rawInstructionSurface !== "cli"
  ) {
    fail("Expected --surface to be followed by api or cli.");
  }
  if (values?.prompt !== undefined && values?.["prompt-file"] !== undefined) {
    fail("Use either --prompt or --prompt-file, not both.");
  }
  if (values?.name !== undefined && !rawSchedulerName) {
    fail("Expected --name to contain a non-empty name.");
  }
  if (values?.["prompt-file"] !== undefined && !rawSchedulerPromptFile) {
    fail("Expected --prompt-file to contain a file path.");
  }
  if (values?.path !== undefined && !rawInstructionPath) {
    fail("Expected --path to contain a path.");
  }
  if (
    values?.["expected-revision"] !== undefined &&
    !rawInstructionExpectedRevision
  ) {
    fail("Expected --expected-revision to contain a revision number.");
  }
  if (
    values?.["expected-digest"] !== undefined &&
    !rawInstructionExpectedDigest
  ) {
    fail("Expected --expected-digest to contain a SHA-256 digest.");
  }
  if (
    rawInstructionExpectedDigest &&
    !/^[0-9a-f]{64}$/iu.test(rawInstructionExpectedDigest)
  ) {
    fail("--expected-digest must be a 64-character SHA-256 digest.");
  }
  if (values?.surface !== undefined && !rawInstructionSurface) {
    fail("Expected --surface to be followed by api or cli.");
  }
  if (
    values?.["decisions-file"] !== undefined &&
    !rawInstructionDecisionsFile
  ) {
    fail("Expected --decisions-file to contain a file path.");
  }
  if (values?.["metadata-json"] !== undefined && !rawInstructionMetadataJson) {
    fail("Expected --metadata-json to contain a JSON object.");
  }
  if (
    values?.profile !== undefined &&
    (rawInstructionProfileIds?.length ?? 0) === 0
  ) {
    fail("Expected --profile to contain a profile UUID.");
  }

  assertInstructionOptionAllowed(values?.name !== undefined, "--name", action, [
    "profile-create",
    "profile-edit",
    "profile-duplicate",
    "workspace-configure",
  ]);
  assertInstructionOptionAllowed(
    values?.description !== undefined,
    "--description",
    action,
    ["profile-create", "profile-edit"],
  );
  assertInstructionOptionAllowed(
    values?.profile !== undefined,
    "--profile",
    action,
    ["assignment-set"],
  );
  assertInstructionOptionAllowed(
    values?.["expected-revision"] !== undefined,
    "--expected-revision",
    action,
    [
      "profile-create",
      "profile-edit",
      "profile-duplicate",
      "profile-delete",
      "assignment-set",
      "assignment-relink",
      "assignment-remove",
      "workspace-configure",
      "workspace-relink",
      "workspace-remove",
      "transfer-import",
    ],
  );
  assertInstructionOptionAllowed(
    values?.["expected-digest"] !== undefined,
    "--expected-digest",
    action,
    ["recovery-restore", "recovery-export", "recovery-reset"],
  );
  assertInstructionOptionAllowed(
    values?.surface !== undefined,
    "--surface",
    action,
    ["resolve"],
  );
  assertInstructionOptionAllowed(
    values?.["include-content"] === true,
    "--include-content",
    action,
    ["profile-list", "resolve", "recovery-export"],
  );
  assertInstructionOptionAllowed(
    values?.["include-workspaces"] === true,
    "--include-workspaces",
    action,
    ["transfer-export", "transfer-import"],
  );
  assertInstructionOptionAllowed(
    values?.["decisions-file"] !== undefined,
    "--decisions-file",
    action,
    ["transfer-import"],
  );
  assertInstructionOptionAllowed(
    values?.["confirm-assignment-removal"] === true,
    "--confirm-assignment-removal",
    action,
    ["workspace-remove"],
  );
  assertInstructionOptionAllowed(
    values?.["ralph-flow"] !== undefined,
    "--ralph-flow",
    action,
    ["resolve"],
  );
  assertInstructionOptionAllowed(
    values?.["flow-scope"] !== undefined,
    "--flow-scope",
    action,
    ["resolve"],
  );
  assertInstructionOptionAllowed(
    values?.prompt !== undefined,
    "--prompt",
    action,
    ["profile-create", "profile-edit"],
  );
  assertInstructionOptionAllowed(
    values?.["prompt-file"] !== undefined,
    "--prompt-file",
    action,
    ["profile-create", "profile-edit", "transfer-import"],
  );
  assertInstructionOptionAllowed(values?.path !== undefined, "--path", action, [
    "resolve",
    "assignment-set",
    "assignment-relink",
    "assignment-remove",
    "workspace-relink",
  ]);
  assertInstructionOptionAllowed(
    values?.["metadata-json"] !== undefined,
    "--metadata-json",
    action,
    ["profile-create", "profile-edit", "workspace-configure"],
  );
  for (const [provided, option] of [
    [values?.["runtime-provider"] !== undefined, "--runtime-provider"],
    [values?.model !== undefined, "--model"],
    [values?.reasoning !== undefined, "--reasoning"],
  ] as const) {
    if (provided && action !== "resolve" && action !== "validate") {
      fail(
        `${option} is only valid for \`machdoch instructions resolve\` or \`machdoch instructions validate\`.`,
      );
    }
  }
  const instructionSubject = normalizeOptionalString(rawSubject);
  const instructionSecondarySubject =
    normalizeOptionalString(rawSecondarySubject);
  const actionsWithoutSubjects = new Set<InstructionCliAction>([
    "profile-list",
    "assignment-list",
    "workspace-list",
    "transfer-export",
    "transfer-import",
    "recovery-status",
    "recovery-restore",
    "recovery-export",
    "recovery-reset",
    "resolve",
    "validate",
  ]);
  if (
    actionsWithoutSubjects.has(action) &&
    (instructionSubject || instructionSecondarySubject)
  ) {
    fail(
      `\`machdoch instructions ${group ? `${firstInstructionWord} ${groupAction ?? ""}`.trim() : action}\` does not accept positional arguments.`,
    );
  }
  if (instructionSecondarySubject && action !== "assignment-relink") {
    fail(
      `\`machdoch instructions ${firstInstructionWord} ${groupAction ?? ""}\` has an unexpected positional argument: ${instructionSecondarySubject}`,
    );
  }
  const actionsRequiringSubject = new Set<InstructionCliAction>([
    "profile-show",
    "profile-edit",
    "profile-duplicate",
    "profile-delete",
    "assignment-set",
    "assignment-relink",
    "assignment-remove",
    "workspace-relink",
    "workspace-remove",
  ]);
  if (actionsRequiringSubject.has(action) && !instructionSubject) {
    fail(
      `\`machdoch instructions ${action.replace("-", " ")}\` requires a subject.`,
    );
  }
  if (action === "assignment-relink" && !instructionSecondarySubject) {
    fail("Assignment relink requires the current relative folder.");
  }
  if (
    [
      "assignment-set",
      "assignment-relink",
      "assignment-remove",
      "workspace-relink",
    ].includes(action) &&
    !rawInstructionPath
  ) {
    fail(
      `\`machdoch instructions ${action.replace("-", " ")}\` requires --path.`,
    );
  }
  if (action === "profile-create" && instructionSubject && rawSchedulerName) {
    fail("Use either a positional profile name or --name, not both.");
  }
  const instructionExpectedRevision = parseOptionalInteger(
    rawInstructionExpectedRevision,
    "--expected-revision",
  );
  if (
    instructionExpectedRevision !== undefined &&
    instructionExpectedRevision < 0
  ) {
    fail("--expected-revision must be zero or greater.");
  }

  return {
    action,
    ...(group ? { group } : {}),
    ...(instructionSubject ? { subject: instructionSubject } : {}),
    ...(instructionSecondarySubject
      ? { secondarySubject: instructionSecondarySubject }
      : {}),
    ...(rawSchedulerName ? { name: rawSchedulerName } : {}),
    ...(rawInstructionDescription !== undefined
      ? { description: rawInstructionDescription }
      : {}),
    ...(rawInstructionProfileIds && rawInstructionProfileIds.length > 0
      ? { profileIds: rawInstructionProfileIds }
      : {}),
    ...(instructionExpectedRevision === undefined
      ? {}
      : { expectedRevision: instructionExpectedRevision }),
    ...(rawInstructionExpectedDigest
      ? { expectedDigest: rawInstructionExpectedDigest }
      : {}),
    ...(rawInstructionSurface
      ? { surface: rawInstructionSurface as "api" | "cli" }
      : {}),
    ...(values?.["include-content"] === true ? { includeContent: true } : {}),
    ...(values?.["include-workspaces"] === true
      ? { includeWorkspaces: true }
      : {}),
    ...(rawInstructionDecisionsFile
      ? { decisionsFile: rawInstructionDecisionsFile }
      : {}),
    ...(values?.["confirm-assignment-removal"] === true
      ? { confirmAssignmentRemoval: true }
      : {}),
    ...(rawInstructionRalphFlow ? { ralphFlow: rawInstructionRalphFlow } : {}),
    ...(rawInstructionRalphFlowScope
      ? { ralphFlowScope: rawInstructionRalphFlowScope as RalphCliScope }
      : {}),
    ...(typeof values?.prompt === "string" ? { prompt: values.prompt } : {}),
    ...(rawSchedulerPromptFile ? { promptFile: rawSchedulerPromptFile } : {}),
    ...(rawInstructionPath ? { path: rawInstructionPath } : {}),
    ...(rawInstructionMetadataJson
      ? { metadataJson: rawInstructionMetadataJson }
      : {}),
  };
};

export const validateInstructionFlowOptions = (
  values:
    | Partial<Pick<CliTokenValues, "ralph-flow" | "flow-scope">>
    | undefined,
): void => {
  const rawInstructionRalphFlow = normalizeOptionalString(
    values?.["ralph-flow"],
  );
  const rawInstructionRalphFlowScope = normalizeOptionalString(
    values?.["flow-scope"],
  );
  if (values?.["ralph-flow"] !== undefined && !rawInstructionRalphFlow) {
    fail("Expected --ralph-flow to be followed by a Ralph flow id or alias.");
  }

  if (values?.["flow-scope"] !== undefined && !rawInstructionRalphFlowScope) {
    fail("Expected --flow-scope to be followed by user or workspace.");
  }

  if (
    rawInstructionRalphFlowScope &&
    !RALPH_SCOPES.has(rawInstructionRalphFlowScope as RalphCliScope)
  ) {
    fail("Expected --flow-scope to be followed by user or workspace.");
  }
};

export const validateInstructionCommand = (
  command: string,
  values:
    | Partial<Pick<CliTokenValues, "ralph-flow" | "flow-scope">>
    | undefined,
): void => {
  if (
    command !== "instructions" &&
    (normalizeOptionalString(values?.["ralph-flow"]) ||
      normalizeOptionalString(values?.["flow-scope"]))
  ) {
    fail(
      "--ralph-flow and --flow-scope are only valid for `machdoch instructions`.",
    );
  }
};
