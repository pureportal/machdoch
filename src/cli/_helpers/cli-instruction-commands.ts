import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { loadRuntimeConfig } from "../../core/config.js";
import {
  createInstructionProfile,
  createLocalInstruction,
  deleteInstructionProfile,
  deleteLocalInstruction,
  discoverLocalInstructions,
  duplicateInstructionProfile,
  explainInstructionResolution,
  exportInstructionLibrary,
  exportInstructionLibraryRecoveryBackup,
  importInstructionLibrary,
  inspectInstructionLibraryRecovery,
  loadInstructionLibrary,
  registerInstructionWorkspace,
  recoverInstructionLibraryFromBackup,
  resetCorruptInstructionLibrary,
  relinkInstructionWorkspaceScope,
  relinkInstructionWorkspace,
  resolveInstructionSet,
  setDefaultInstructionProfiles,
  setWorkspaceInstructionScope,
  showLocalInstruction,
  unregisterInstructionWorkspace,
  updateInstructionProfile,
  updateInstructionWorkspace,
  instructionTagRuleMatches,
  normalizeInstructionTagRule,
  normalizeInstructionTags,
  updateLocalInstruction,
  profileNameKey,
  sha256,
  utf8ByteLength,
  MAX_INSTRUCTION_SOURCE_BYTES,
  type InstructionLibrary,
  type InstructionDiagnostic,
  InstructionSystemError,
  type LocalInstructionRecord,
  type InstructionLibraryImportChoices,
  type InstructionTagRule,
} from "../../core/instruction-system/index.js";
import { isAgentCliProvider } from "../../core/_helpers/agent-cli-providers.js";
import { createInstructionDeliveryPlanForRuntime } from "../../core/provider-enrollment/instruction-delivery-preflight.js";
import { readRalphFlow } from "../../core/ralph.js";
import type {
  ConfiguredModelProvider,
  ReasoningMode,
} from "../../core/runtime-contract.generated.js";
import type { InstructionCliOptions, ParsedCliArgs } from "./cli-args.js";
import { writeStdoutLine } from "./cli-io.js";

const fail = (message: string): never => {
  throw new Error(message);
};

const printJson = (value: unknown): void => {
  writeStdoutLine(JSON.stringify(value, null, 2));
};

const resolveInputPath = (workspaceRoot: string, path: string): string =>
  isAbsolute(path) ? path : resolve(workspaceRoot, path);

const MAX_INSTRUCTION_CLI_JSON_BYTES = 64 * 1024 * 1024;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

interface InstructionProfileMetadataInput {
  enabled?: boolean;
  global?: boolean;
  tags?: string[];
  match?: InstructionTagRule | null;
}

const parseInstructionProfileMetadata = (
  raw: string | undefined,
): InstructionProfileMetadataInput => {
  if (raw === undefined) return {};
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return fail("--metadata-json must contain valid JSON.");
  }
  if (!isRecord(value)) return fail("--metadata-json must contain an object.");
  const unsupported = Object.keys(value).filter(
    (key) => !["enabled", "global", "tags", "match"].includes(key),
  );
  if (unsupported.length > 0) {
    return fail(`Unsupported profile metadata: ${unsupported.join(", ")}.`);
  }
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
    return fail("Profile metadata enabled must be a boolean.");
  }
  if (value.global !== undefined && typeof value.global !== "boolean") {
    return fail("Profile metadata global must be a boolean.");
  }
  return {
    ...(value.enabled === undefined ? {} : { enabled: value.enabled }),
    ...(value.global === undefined ? {} : { global: value.global }),
    ...(value.tags === undefined
      ? {}
      : { tags: normalizeInstructionTags(value.tags, "metadata.tags") }),
    ...(value.match === undefined
      ? {}
      : value.match === null
        ? { match: null }
        : { match: normalizeInstructionTagRule(value.match) }),
  };
};

const parseInstructionWorkspaceTags = (
  raw: string | undefined,
): string[] | undefined => {
  if (raw === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return fail("--metadata-json must contain valid JSON.");
  }
  if (!isRecord(value)) return fail("--metadata-json must contain an object.");
  const unsupported = Object.keys(value).filter((key) => key !== "tags");
  if (unsupported.length > 0) {
    return fail(`Unsupported workspace metadata: ${unsupported.join(", ")}.`);
  }
  return value.tags === undefined
    ? undefined
    : normalizeInstructionTags(value.tags, "metadata.tags");
};

const readBoundedUtf8InputFile = async (
  path: string,
  maxBytes: number,
  label: string,
): Promise<string> => {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink()) {
    fail(`${label} must be a regular, unlinked file.`);
  }
  if (before.size > maxBytes) {
    fail(`${label} exceeds the ${maxBytes}-byte input limit.`);
  }
  const bytes = await readFile(path);
  const after = await lstat(path);
  if (
    !after.isFile() ||
    after.isSymbolicLink() ||
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs
  ) {
    fail(`${label} changed while it was being read.`);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return fail(`${label} is not valid UTF-8.`);
  }
};

const readBody = async (
  args: ParsedCliArgs,
  options: InstructionCliOptions,
  required = true,
  maxFileBytes = MAX_INSTRUCTION_SOURCE_BYTES + 3,
): Promise<string | undefined> => {
  if (options.promptFile) {
    return readBoundedUtf8InputFile(
      resolveInputPath(args.workspaceRoot, options.promptFile),
      maxFileBytes,
      "Instruction input",
    );
  }
  if (options.prompt !== undefined) return options.prompt;
  return required
    ? fail("Provide Markdown with --prompt or --prompt-file.")
    : undefined;
};

const mutationOptions = (
  options: InstructionCliOptions,
): { expectedRevision?: number } =>
  options.expectedRevision === undefined
    ? {}
    : { expectedRevision: options.expectedRevision };

const profileReferenceCounts = (
  library: InstructionLibrary,
): Map<string, number> => {
  const counts = new Map(library.profiles.map((profile) => [profile.id, 0]));
  for (const id of library.defaults.profiles) {
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  for (const workspace of library.workspaces) {
    for (const scope of workspace.scopes) {
      for (const id of scope.profiles) {
        counts.set(id, (counts.get(id) ?? 0) + 1);
      }
    }
  }
  return counts;
};

const createLocalMetadata = (
  file: LocalInstructionRecord,
  includeBody = false,
): Omit<LocalInstructionRecord, "body" | "identity"> & { body?: string } => ({
  id: file.id,
  relativePath: file.relativePath,
  scopePath: file.scopePath,
  digest: file.digest,
  byteLength: file.byteLength,
  lineCount: file.lineCount,
  ...(includeBody ? { body: file.body } : {}),
});

const createLibraryOverview = (
  library: InstructionLibrary,
  includeBodies = false,
): unknown => {
  const references = profileReferenceCounts(library);
  return {
    schemaVersion: library.schemaVersion,
    revision: library.revision,
    profiles: library.profiles.map((profile) => ({
      id: profile.id,
      name: profile.name,
      ...(profile.description === undefined
        ? {}
        : { description: profile.description }),
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
      byteLength: utf8ByteLength(profile.body),
      lineCount: profile.body.split("\n").length,
      digest: sha256(profile.body),
      assignmentCount: references.get(profile.id) ?? 0,
      manualAssignmentCount: library.workspaces.reduce(
        (count, workspace) =>
          count +
          workspace.scopes.filter((scope) =>
            scope.profiles.includes(profile.id),
          ).length,
        0,
      ),
      automaticWorkspaceIds:
        profile.enabled === false ||
        profile.global === true ||
        profile.match === undefined
          ? []
          : library.workspaces
              .filter((workspace) =>
                instructionTagRuleMatches(profile.match!, workspace.tags ?? []),
              )
              .map((workspace) => workspace.id),
      enabled: profile.enabled !== false,
      global: library.defaults.profiles.includes(profile.id),
      tags: [...(profile.tags ?? [])],
      ...(profile.match === undefined
        ? {}
        : { match: structuredClone(profile.match) }),
      ...(includeBodies ? { body: profile.body } : {}),
    })),
    defaults: { profiles: [...library.defaults.profiles] },
    workspaces: library.workspaces.map((workspace) => ({
      ...workspace,
      scopes: workspace.scopes.map((scope) => ({
        path: scope.path,
        profiles: [...scope.profiles],
      })),
    })),
  };
};

const printProfileList = (library: InstructionLibrary): void => {
  const overview = createLibraryOverview(library) as {
    profiles: Array<Record<string, unknown>>;
  };
  writeStdoutLine(`instruction profiles: ${overview.profiles.length}`);
  for (const profile of overview.profiles) {
    writeStdoutLine(
      `  - ${String(profile.name)} (${String(profile.id)}) assignments=${String(
        profile.assignmentCount,
      )} bytes=${String(profile.byteLength)} digest=${String(profile.digest)}`,
    );
    if (profile.description) {
      writeStdoutLine(`    ${String(profile.description)}`);
    }
  }
};

const requireProfile = (library: InstructionLibrary, idOrName: string) => {
  const key = profileNameKey(idOrName);
  const matches = library.profiles.filter(
    (profile) =>
      profile.id === idOrName || profileNameKey(profile.name) === key,
  );
  if (matches.length === 0) {
    return fail(`Instruction profile \`${idOrName}\` was not found.`);
  }
  if (matches.length > 1) {
    return fail(
      `Instruction profile \`${idOrName}\` is ambiguous; use its UUID.`,
    );
  }
  return matches[0] as NonNullable<(typeof matches)[number]>;
};

const resolveProvider = async (
  args: ParsedCliArgs,
): Promise<{
  providerId: ConfiguredModelProvider;
  model: string;
  reasoning: ReasoningMode;
}> => {
  if (args.runtimeProvider) {
    return {
      providerId: args.runtimeProvider,
      model: args.model ?? "",
      reasoning: args.reasoning ?? "default",
    };
  }
  const config = await loadRuntimeConfig(
    args.workspaceRoot,
    args.mode,
    args.model,
    args.runtimeProvider,
    args.agentLimits,
    args.reasoning,
  );
  return {
    providerId: config.provider === "unconfigured" ? "openai" : config.provider,
    model: config.model,
    reasoning: config.reasoning,
  };
};

const validateInstructionSystem = async (
  args: ParsedCliArgs,
): Promise<unknown> => {
  const [{ providerId, model, reasoning }, library, locals] = await Promise.all(
    [
      resolveProvider(args),
      loadInstructionLibrary(),
      discoverLocalInstructions(args.workspaceRoot),
    ],
  );
  const diagnostics: InstructionDiagnostic[] = [...locals.diagnostics];
  let explanation: ReturnType<typeof explainInstructionResolution> | undefined;
  let deliveryPlan:
    | Awaited<ReturnType<typeof createInstructionDeliveryPlanForRuntime>>
    | undefined;
  try {
    const resolution = await resolveInstructionSet({
      workspaceRoot: args.workspaceRoot,
      providerId,
      surface: isAgentCliProvider(providerId) ? "cli" : "api",
      ...(model ? { model } : {}),
    });
    explanation = explainInstructionResolution(resolution);
    deliveryPlan = await createInstructionDeliveryPlanForRuntime(resolution, {
      workspaceRoot: args.workspaceRoot,
      reasoning,
    });
    if (
      deliveryPlan.grade === "unsupported" ||
      deliveryPlan.blockingReasons.length > 0
    ) {
      diagnostics.push({
        code: "INSTRUCTION_DELIVERY_UNSUPPORTED",
        severity: "error",
        message:
          deliveryPlan.blockingReasons.join(" ") ||
          "The selected provider surface cannot safely deliver the resolved instruction set.",
        details: {
          planId: deliveryPlan.planId,
          providerId,
          model,
        },
      });
    } else if (deliveryPlan.grade === "compatible") {
      diagnostics.push({
        code: "INSTRUCTION_DELIVERY_COMPATIBLE",
        severity: "warning",
        message:
          "The selected provider surface has explicit delivery limitations; execution remains available through the canonical Machdoch prompt.",
        details: {
          planId: deliveryPlan.planId,
          providerId,
          model,
        },
      });
    }
  } catch (error) {
    diagnostics.push({
      code:
        error instanceof InstructionSystemError
          ? error.code
          : "INSTRUCTION_VALIDATION_FAILED",
      severity: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
  return {
    valid: !diagnostics.some((diagnostic) => diagnostic.severity === "error"),
    libraryRevision: library.revision,
    profiles: library.profiles.length,
    workspaces: library.workspaces.length,
    localFiles: locals.files.map((file) => createLocalMetadata(file)),
    ...(explanation === undefined ? {} : { explanation }),
    ...(deliveryPlan === undefined ? {} : { deliveryPlan }),
    diagnostics,
  };
};

export const printInstructionSummary = async (
  args: ParsedCliArgs,
): Promise<void> => {
  const options =
    args.instructions ?? fail("No instruction command was provided.");
  switch (options.action) {
    case "profile-list": {
      const library = await loadInstructionLibrary();
      if (args.json) {
        printJson(
          createLibraryOverview(library, options.includeContent === true),
        );
      } else printProfileList(library);
      return;
    }
    case "profile-show": {
      const library = await loadInstructionLibrary();
      const profile = requireProfile(
        library,
        options.subject ?? fail("Profile show requires an id or name."),
      );
      if (args.json) printJson(profile);
      else {
        writeStdoutLine(`${profile.name} (${profile.id})`);
        if (profile.description) writeStdoutLine(profile.description);
        writeStdoutLine("");
        writeStdoutLine(profile.body);
      }
      return;
    }
    case "profile-create": {
      const metadata = parseInstructionProfileMetadata(options.metadataJson);
      const { match, ...createMetadata } = metadata;
      const result = await createInstructionProfile(
        {
          name:
            options.name ??
            options.subject ??
            fail("Profile create requires --name or a positional name."),
          ...(options.description === undefined ||
          options.description.length === 0
            ? {}
            : { description: options.description }),
          body: (await readBody(args, options)) as string,
          ...createMetadata,
          ...(match === undefined || match === null ? {} : { match }),
        },
        mutationOptions(options),
      );
      if (args.json) printJson(result);
      else
        writeStdoutLine(
          `created profile ${result.profile.name} (${result.profile.id}), revision ${result.library.revision}`,
        );
      return;
    }
    case "profile-edit": {
      const library = await loadInstructionLibrary();
      const profile = requireProfile(
        library,
        options.subject ?? fail("Profile edit requires an id or name."),
      );
      const body = await readBody(args, options, false);
      const metadata = parseInstructionProfileMetadata(options.metadataJson);
      if (
        body === undefined &&
        options.name === undefined &&
        options.description === undefined &&
        options.metadataJson === undefined
      ) {
        fail(
          "Profile edit requires --name, --description, --prompt, or --prompt-file.",
        );
      }
      const result = await updateInstructionProfile(
        profile.id,
        {
          ...(options.name === undefined ? {} : { name: options.name }),
          ...(options.description === undefined
            ? {}
            : {
                description:
                  options.description.length === 0 ? null : options.description,
              }),
          ...(body === undefined ? {} : { body }),
          ...metadata,
        },
        mutationOptions(options),
      );
      if (args.json) printJson(result);
      else
        writeStdoutLine(
          `updated profile ${profile.id}, revision ${result.library.revision}`,
        );
      return;
    }
    case "profile-duplicate": {
      const library = await loadInstructionLibrary();
      const profile = requireProfile(
        library,
        options.subject ?? fail("Profile duplicate requires an id or name."),
      );
      const result = await duplicateInstructionProfile(
        profile.id,
        options.name,
        mutationOptions(options),
      );
      if (args.json) printJson(result);
      else
        writeStdoutLine(
          `duplicated profile as ${result.profile.name} (${result.profile.id})`,
        );
      return;
    }
    case "profile-delete": {
      const library = await loadInstructionLibrary();
      const profile = requireProfile(
        library,
        options.subject ?? fail("Profile delete requires an id or name."),
      );
      const result = await deleteInstructionProfile(
        profile.id,
        mutationOptions(options),
      );
      if (args.json) printJson(result);
      else
        writeStdoutLine(
          `deleted profile ${profile.id}, revision ${result.library.revision}`,
        );
      return;
    }
    case "assignment-list": {
      const library = await loadInstructionLibrary();
      const value = {
        revision: library.revision,
        defaults: library.defaults,
        workspaces: library.workspaces,
      };
      if (args.json) printJson(value);
      else {
        writeStdoutLine(
          `defaults: ${library.defaults.profiles.join(", ") || "none"}`,
        );
        for (const workspace of library.workspaces) {
          writeStdoutLine(`${workspace.id}: ${workspace.root}`);
          for (const scope of workspace.scopes) {
            writeStdoutLine(`  ${scope.path}: ${scope.profiles.join(", ")}`);
          }
        }
      }
      return;
    }
    case "assignment-set-defaults": {
      const result = await setDefaultInstructionProfiles(
        options.profileIds ?? [],
        mutationOptions(options),
      );
      if (args.json) printJson(result);
      else
        writeStdoutLine(
          `updated default order, revision ${result.library.revision}`,
        );
      return;
    }
    case "assignment-set":
    case "assignment-remove": {
      const workspaceId =
        options.subject ?? fail(`${options.action} requires a workspace UUID.`);
      const scopePath =
        options.path ??
        options.secondarySubject ??
        fail(`${options.action} requires --path <relative-folder>.`);
      const result = await setWorkspaceInstructionScope(
        workspaceId,
        scopePath,
        options.action === "assignment-remove"
          ? []
          : (options.profileIds ?? []),
        mutationOptions(options),
      );
      if (args.json) printJson(result);
      else
        writeStdoutLine(
          `updated ${workspaceId}:${scopePath}, revision ${result.library.revision}`,
        );
      return;
    }
    case "assignment-relink": {
      const workspaceId =
        options.subject ?? fail("Assignment relink requires a workspace UUID.");
      const currentPath =
        options.secondarySubject ??
        fail("Assignment relink requires the current relative folder.");
      const nextPath =
        options.path ??
        fail("Assignment relink requires --path <new-relative-folder>.");
      const result = await relinkInstructionWorkspaceScope(
        workspaceId,
        currentPath,
        nextPath,
        mutationOptions(options),
      );
      if (args.json) printJson(result);
      else {
        writeStdoutLine(
          `relinked ${workspaceId}:${currentPath} to ${nextPath}, revision ${result.library.revision}`,
        );
      }
      return;
    }
    case "local-list": {
      const discovery = await discoverLocalInstructions(args.workspaceRoot);
      const value = {
        files: discovery.files.map((file) =>
          createLocalMetadata(file, options.includeContent === true),
        ),
        diagnostics: discovery.diagnostics,
        visitedDirectories: discovery.visitedDirectories,
      };
      if (args.json) printJson(value);
      else {
        writeStdoutLine(
          `project-local AGENTS.md files: ${discovery.files.length}`,
        );
        for (const file of discovery.files) {
          writeStdoutLine(
            `  - ${file.relativePath} bytes=${file.byteLength} digest=${file.digest}`,
          );
        }
      }
      return;
    }
    case "local-show": {
      const record = await showLocalInstruction(
        args.workspaceRoot,
        options.subject ?? options.path ?? ".",
      );
      if (args.json) printJson(record);
      else writeStdoutLine(record.body);
      return;
    }
    case "local-create": {
      const record = await createLocalInstruction(
        args.workspaceRoot,
        options.subject ?? options.path ?? ".",
        (await readBody(args, options)) as string,
      );
      if (args.json) printJson(record);
      else
        writeStdoutLine(
          `created ${record.relativePath} digest=${record.digest}`,
        );
      return;
    }
    case "local-edit": {
      const record = await updateLocalInstruction(
        args.workspaceRoot,
        options.subject ?? options.path ?? ".",
        (await readBody(args, options)) as string,
        options.expectedDigest ??
          fail("Local edit requires --expected-digest for compare-and-swap."),
      );
      if (args.json) printJson(record);
      else
        writeStdoutLine(
          `updated ${record.relativePath} digest=${record.digest}`,
        );
      return;
    }
    case "local-delete": {
      await deleteLocalInstruction(
        args.workspaceRoot,
        options.subject ?? options.path ?? ".",
        options.expectedDigest ??
          fail("Local delete requires --expected-digest for compare-and-swap."),
      );
      if (args.json) printJson({ deleted: true });
      else writeStdoutLine("deleted project-local AGENTS.md");
      return;
    }
    case "workspace-list": {
      const library = await loadInstructionLibrary();
      if (args.json)
        printJson({
          revision: library.revision,
          workspaces: library.workspaces,
        });
      else {
        for (const workspace of library.workspaces) {
          writeStdoutLine(`${workspace.id}: ${workspace.root}`);
        }
      }
      return;
    }
    case "workspace-register": {
      const tags = parseInstructionWorkspaceTags(options.metadataJson);
      const result = await registerInstructionWorkspace(
        options.subject ?? options.path ?? args.workspaceRoot,
        {
          ...(options.name === undefined ? {} : { displayName: options.name }),
          ...(tags === undefined ? {} : { tags }),
        },
        mutationOptions(options),
      );
      if (args.json) printJson(result);
      else
        writeStdoutLine(
          `registered ${result.workspace.id}: ${result.workspace.root}`,
        );
      return;
    }
    case "workspace-update": {
      const workspaceId =
        options.subject ?? fail("Workspace update requires a workspace UUID.");
      const tags = parseInstructionWorkspaceTags(options.metadataJson);
      if (options.name === undefined && tags === undefined) {
        fail("Workspace update requires --name or --metadata-json.");
      }
      const result = await updateInstructionWorkspace(
        workspaceId,
        {
          ...(options.name === undefined
            ? {}
            : { displayName: options.name.length === 0 ? null : options.name }),
          ...(tags === undefined ? {} : { tags }),
        },
        mutationOptions(options),
      );
      if (args.json) printJson(result);
      else
        writeStdoutLine(
          `updated workspace ${workspaceId}, revision ${result.library.revision}`,
        );
      return;
    }
    case "workspace-relink": {
      const result = await relinkInstructionWorkspace(
        options.subject ?? fail("Workspace relink requires a workspace UUID."),
        options.path ??
          options.secondarySubject ??
          fail("Workspace relink requires --path <absolute-root>."),
        mutationOptions(options),
      );
      if (args.json) printJson(result);
      else
        writeStdoutLine(
          `relinked workspace, revision ${result.library.revision}`,
        );
      return;
    }
    case "workspace-unregister": {
      const result = await unregisterInstructionWorkspace(
        options.subject ??
          fail("Workspace unregister requires a workspace UUID."),
        {
          ...mutationOptions(options),
          confirmAssignedRemoval: options.confirmAssignmentRemoval === true,
        },
      );
      if (args.json) printJson(result);
      else
        writeStdoutLine(
          `unregistered workspace, revision ${result.library.revision}`,
        );
      return;
    }
    case "recovery-status": {
      printJson(await inspectInstructionLibraryRecovery());
      return;
    }
    case "recovery-restore": {
      const expectedDigest =
        options.expectedDigest ??
        fail(
          "Instruction recovery restore requires --expected-digest from the validated recovery status.",
        );
      const status = await inspectInstructionLibraryRecovery();
      if (!status.backupValid) {
        fail("No validated instruction-library backup is available.");
      }
      const library = await recoverInstructionLibraryFromBackup(expectedDigest);
      if (args.json) printJson({ recovered: true, library, status });
      else {
        writeStdoutLine(
          `recovered instruction library revision ${library.revision} from ${status.backupPath}`,
        );
      }
      return;
    }
    case "recovery-export": {
      if (options.includeContent !== true) {
        fail(
          "Recovery export contains sensitive instruction bodies. Review recovery status, then repeat with --include-content and the validated backup digest.",
        );
      }
      const expectedDigest =
        options.expectedDigest ??
        fail(
          "Instruction recovery export requires --expected-digest from the validated recovery status.",
        );
      printJson(await exportInstructionLibraryRecoveryBackup(expectedDigest));
      return;
    }
    case "recovery-reset": {
      const expectedDigest =
        options.expectedDigest ??
        fail(
          "Instruction recovery reset requires the reviewed corrupt primary --expected-digest.",
        );
      const result = await resetCorruptInstructionLibrary(expectedDigest);
      if (args.json) {
        printJson({ reset: true, ...result });
      } else {
        writeStdoutLine(
          `reset instruction library to revision ${result.library.revision}; corrupt bytes preserved at ${result.corruptCopy}`,
        );
      }
      return;
    }
    case "resolve": {
      const { providerId, model, reasoning } = await resolveProvider(args);
      const surface =
        options.surface ?? (isAgentCliProvider(providerId) ? "cli" : "api");
      const flow =
        options.ralphFlow === undefined
          ? undefined
          : await readRalphFlow(args.workspaceRoot, options.ralphFlow, {
              scope: options.ralphFlowScope ?? "workspace",
            });
      const resolution = await resolveInstructionSet({
        workspaceRoot: args.workspaceRoot,
        providerId,
        surface,
        ...(model ? { model } : {}),
        ...(flow === undefined
          ? {}
          : {
              flow: {
                id: flow.id,
                ...(flow.guidance === undefined
                  ? {}
                  : { guidance: flow.guidance }),
              },
            }),
      });
      const plan = await createInstructionDeliveryPlanForRuntime(resolution, {
        workspaceRoot: args.workspaceRoot,
        reasoning,
      });
      const value = {
        explanation: explainInstructionResolution(resolution, {
          includeBodies: options.includeContent === true,
          ...(options.path === undefined ? {} : { previewPath: options.path }),
        }),
        deliveryPlan: plan,
      };
      if (args.json) printJson(value);
      else {
        writeStdoutLine(`canonical digest: ${resolution.canonicalDigest}`);
        writeStdoutLine(`environment digest: ${resolution.environmentDigest}`);
        writeStdoutLine(`sources: ${resolution.selectedSources.length}`);
        writeStdoutLine(`delivery: ${plan.grade} via ${plan.route}`);
        for (const source of resolution.selectedSources) {
          writeStdoutLine(
            `  ${source.precedence}. ${source.id} (${source.digest})`,
          );
        }
      }
      return;
    }
    case "validate": {
      const validation = await validateInstructionSystem(args);
      if (args.json) printJson(validation);
      else printJson(validation);
      return;
    }
    case "transfer-export": {
      const library = await loadInstructionLibrary();
      printJson(
        exportInstructionLibrary(library, options.includeWorkspaces === true),
      );
      return;
    }
    case "transfer-import": {
      const path =
        options.promptFile ??
        fail("Transfer import requires --prompt-file <export.json>.");
      const payload = JSON.parse(
        (
          await readBoundedUtf8InputFile(
            resolveInputPath(args.workspaceRoot, path),
            MAX_INSTRUCTION_CLI_JSON_BYTES,
            "Instruction library import",
          )
        ).replace(/^\uFEFF/u, ""),
      ) as Parameters<typeof importInstructionLibrary>[0];
      let choices: InstructionLibraryImportChoices | undefined;
      if (options.decisionsFile) {
        const parsed = JSON.parse(
          (
            await readBoundedUtf8InputFile(
              resolveInputPath(args.workspaceRoot, options.decisionsFile),
              MAX_INSTRUCTION_CLI_JSON_BYTES,
              "Instruction import choices",
            )
          ).replace(/^\uFEFF/u, ""),
        ) as unknown;
        if (
          typeof parsed !== "object" ||
          parsed === null ||
          Array.isArray(parsed)
        ) {
          fail("Transfer import choices must be a JSON object.");
        }
        choices = parsed as InstructionLibraryImportChoices;
      }
      const result = await importInstructionLibrary(payload, {
        ...mutationOptions(options),
        includeWorkspaceBindings: options.includeWorkspaces === true,
        ...(choices === undefined ? {} : { choices }),
      });
      printJson(result);
      return;
    }
  }
};
