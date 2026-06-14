import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { loadRuntimeConfig } from "../../core/config.js";
import { discoverCustomizations } from "../../core/customizations.js";
import {
  createRalphFlowWithAgent,
  deleteRalphFlow,
  listRalphFlowRevisions,
  listRalphFlows,
  parseRalphFlowJson,
  readRalphFlow,
  resolveRalphFlowReference,
  restoreRalphFlowRevision,
  runRalphFlow,
  validateRalphFlow,
  writeRalphRunRecord,
  writeRalphFlow,
  type RalphFlow,
  type RalphRunEvent,
  type RalphRunResult,
} from "../../core/ralph.js";
import type { TaskExecutionProgress } from "../../core/types.js";
import { createDiscoveryOptions } from "./cli-output.js";
import {
  createVerboseProgressReporter,
  printExecutionSummary,
  writeStderrLine,
  writeStdoutLine,
} from "./cli-io.js";
import type { ParsedCliArgs, RalphCliOptions } from "./cli-args.js";

const fail = (message: string): never => {
  throw new Error(message);
};

const isPathInside = (root: string, candidate: string): boolean => {
  const relativePath = relative(root, candidate);

  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !isAbsolute(relativePath))
  );
};

const resolveWorkspaceFile = async (
  workspaceRoot: string,
  path: string,
): Promise<string> => {
  const normalizedPath = path.trim();

  if (!normalizedPath) {
    throw new Error("Expected Ralph prompt file path to be non-empty.");
  }

  const resolvedWorkspaceRoot = await realpath(workspaceRoot);
  const candidatePath = isAbsolute(normalizedPath)
    ? normalizedPath
    : resolve(resolvedWorkspaceRoot, normalizedPath);
  const resolvedPath = await realpath(candidatePath);

  if (!isPathInside(resolvedWorkspaceRoot, resolvedPath)) {
    throw new Error("Refusing to read Ralph prompt file outside the workspace.");
  }

  const metadata = await stat(resolvedPath);

  if (!metadata.isFile()) {
    throw new Error("Expected Ralph prompt file path to point to a file.");
  }

  return resolvedPath;
};

export const readRalphPromptFile = async (
  workspaceRoot: string,
  path: string,
): Promise<string> => {
  const resolvedPath = await resolveWorkspaceFile(workspaceRoot, path);

  return (await readFile(resolvedPath, "utf8")).trim();
};

const readRalphWorkspaceFile = async (
  workspaceRoot: string,
  path: string,
): Promise<string> => {
  const resolvedPath = await resolveWorkspaceFile(workspaceRoot, path);

  return await readFile(resolvedPath, "utf8");
};

const readRalphParamsFile = async (
  workspaceRoot: string,
  path: string,
): Promise<string[]> => {
  const contents = await readRalphWorkspaceFile(workspaceRoot, path);
  const parsed = JSON.parse(contents) as unknown;

  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
    throw new Error("Expected --params-file to contain a JSON array of name=value strings.");
  }

  return parsed;
};

const parseVariableValues = (
  params: string[] | undefined,
): Record<string, string> => {
  const values: Record<string, string> = {};

  for (const param of params ?? []) {
    const separatorIndex = param.indexOf("=");

    if (separatorIndex <= 0) {
      throw new Error("Expected --param to use name=value syntax.");
    }

    const key = param.slice(0, separatorIndex).trim();
    const value = param.slice(separatorIndex + 1);

    if (!key) {
      throw new Error("Expected --param to include a non-empty name.");
    }

    values[key] = value;
  }

  return values;
};

const summarizeFlow = (flow: RalphFlow): Record<string, unknown> => {
  return {
    schemaVersion: flow.schemaVersion,
    id: flow.id,
    alias: flow.alias ?? null,
    name: flow.name,
    description: flow.description ?? null,
    variables: flow.variables ?? [],
    blocks: flow.blocks,
    edges: flow.edges,
    createdAt: flow.createdAt ?? null,
    updatedAt: flow.updatedAt ?? null,
  };
};

const summarizeRun = (result: RalphRunResult): Record<string, unknown> => {
  return {
    flow: result.flow,
    status: result.status,
    summary: result.summary,
    missingVariables: result.missingVariables,
    unknownVariables: result.unknownVariables,
    events: result.events,
    blockResults: result.blockResults.map((blockResult) => ({
      blockId: blockResult.blockId,
      output: blockResult.output,
      status: blockResult.status,
      attempt: blockResult.attempt,
      summary: blockResult.summary,
      error: blockResult.error ?? null,
      execution: blockResult.result
        ? {
            status: blockResult.result.status,
            summary: blockResult.result.summary,
            reason: blockResult.result.reason ?? null,
          }
        : null,
    })),
  };
};

const getRalphEventBlockId = (event: RalphRunEvent): string | undefined => {
  switch (event.type) {
    case "block-start":
    case "block-output":
    case "retry":
    case "crash":
    case "end":
      return event.blockId;
    case "edge-route":
      return event.from;
  }
};

const getRalphEventActiveBlockId = (event: RalphRunEvent): string | undefined => {
  return event.type === "edge-route" ? event.to : getRalphEventBlockId(event);
};

const createRalphEventProgressMessage = (
  event: RalphRunEvent,
  blockTitleById: Map<string, string>,
): string => {
  const blockId = getRalphEventBlockId(event);
  const title = blockId ? blockTitleById.get(blockId) ?? blockId : "unknown block";

  switch (event.type) {
    case "block-start":
      return `Running Ralph block \`${title}\`.`;
    case "block-output":
      return `Ralph block \`${title}\` returned ${event.output}.`;
    case "edge-route":
      return `Routing ${event.output} from \`${title}\` to \`${blockTitleById.get(event.to) ?? event.to}\`.`;
    case "retry":
      return `Retrying Ralph block \`${title}\`: ${event.reason}`;
    case "crash":
      return `Ralph flow crashed at \`${title}\`: ${event.reason}`;
    case "end":
      return event.summary;
  }
};

const createRalphEventTimeline = (
  event: RalphRunEvent,
  blockTitleById: Map<string, string>,
): NonNullable<TaskExecutionProgress["timelineEvent"]> => {
  const blockId = getRalphEventBlockId(event);
  const activeBlockId = getRalphEventActiveBlockId(event);
  const activeBlockTitle = activeBlockId
    ? blockTitleById.get(activeBlockId) ?? activeBlockId
    : undefined;
  const metadata: NonNullable<
    NonNullable<TaskExecutionProgress["timelineEvent"]>["metadata"]
  > = {
    ralphEventType: event.type,
  };

  if (blockId) {
    metadata.ralphBlockId = blockId;
    metadata.ralphBlockTitle = blockTitleById.get(blockId) ?? blockId;
  }

  if (activeBlockId) {
    metadata.ralphActiveBlockId = activeBlockId;
    metadata.ralphActiveBlockTitle = activeBlockTitle ?? activeBlockId;
  }

  if (event.type === "block-start" || event.type === "retry") {
    metadata.ralphAttempt = event.attempt;
  }

  if (
    event.type === "block-output" ||
    event.type === "edge-route" ||
    event.type === "crash"
  ) {
    metadata.ralphOutput = event.output;
  }

  if (event.type === "edge-route") {
    metadata.ralphNextBlockId = event.to;
    metadata.ralphNextBlockTitle = blockTitleById.get(event.to) ?? event.to;
  }

  return {
    kind: event.type === "block-output" ? "output" : "state",
    phase:
      event.type === "crash"
        ? "failed"
        : event.type === "end" || event.type === "block-output"
          ? "completed"
          : "started",
    label: createRalphEventProgressMessage(event, blockTitleById),
    ...(event.type === "retry" || event.type === "crash"
      ? { detail: event.reason }
      : {}),
    tone:
      event.type === "crash"
        ? "danger"
        : event.type === "retry"
          ? "warning"
          : "info",
    metadata,
  };
};

const createRalphEventProgressReporter = (
  flow: RalphFlow,
  mode: TaskExecutionProgress["mode"],
): ((event: RalphRunEvent) => void) => {
  const blockTitleById = new Map(
    flow.blocks.map((block) => [block.id, block.title] as const),
  );
  const report = createVerboseProgressReporter(writeStderrLine, {
    structured: true,
  });

  return (event): void => {
    const progress: TaskExecutionProgress = {
      task: `Ralph flow \`${flow.name}\``,
      mode,
      state: "executing",
      message: createRalphEventProgressMessage(event, blockTitleById),
      executedTools: [],
      outputSections: [],
      cancellable: true,
      timelineEvent: createRalphEventTimeline(event, blockTitleById),
    };

    void report(progress);
  };
};

const printJson = (value: unknown): void => {
  writeStdoutLine(JSON.stringify(value, null, 2));
};

const printFlowLines = (flow: RalphFlow, path: string): void => {
  writeStdoutLine(`flow: ${flow.id}`);
  if (flow.alias) {
    writeStdoutLine(`alias: ${flow.alias}`);
  }
  writeStdoutLine(`name: ${flow.name}`);
  writeStdoutLine(`path: ${path}`);

  if (flow.description) {
    writeStdoutLine(`description: ${flow.description}`);
  }

  writeStdoutLine(`variables: ${flow.variables?.length ?? 0}`);
  for (const variable of flow.variables ?? []) {
    writeStdoutLine(
      `- ${variable.name}:${variable.type}${variable.default !== undefined ? `=${variable.default}` : ""}`,
    );
  }

  writeStdoutLine(`blocks: ${flow.blocks.length}`);
  for (const block of flow.blocks) {
    writeStdoutLine(`- ${block.id} [${block.type}] ${block.title}`);
  }

  writeStdoutLine(`edges: ${flow.edges.length}`);
  for (const edge of flow.edges) {
    writeStdoutLine(`- ${edge.from}.${edge.fromOutput} -> ${edge.to}`);
  }
};

const getPromptText = async (
  args: ParsedCliArgs,
  options: RalphCliOptions,
): Promise<string> => {
  if (options.prompt && options.promptFile) {
    fail("Use either --prompt or --prompt-file for `machdoch ralph create`, not both.");
  }

  if (options.promptFile) {
    return readRalphPromptFile(args.workspaceRoot, options.promptFile);
  }

  return options.prompt ?? "";
};

export const printRalphSummary = async (
  args: ParsedCliArgs,
): Promise<void> => {
  const options = args.ralph ?? fail("No Ralph action was provided.");

  switch (options.action) {
    case "list": {
      const flows = await listRalphFlows(args.workspaceRoot);

      if (args.json) {
        printJson({ workspaceRoot: args.workspaceRoot, flows });
        return;
      }

      writeStdoutLine(`ralph flows: ${flows.length}`);
      for (const flow of flows) {
        writeStdoutLine(
          `- ${flow.id}${flow.alias ? ` alias=${flow.alias}` : ""} blocks=${flow.blockCount} edges=${flow.edgeCount} vars=${flow.variableCount}`,
        );
        if (flow.description) {
          writeStdoutLine(`  ${flow.description}`);
        }
      }
      return;
    }
    case "show": {
      const subject = options.subject ?? fail("Expected a flow id or alias after `machdoch ralph show`.");
      const resolution = await resolveRalphFlowReference(args.workspaceRoot, subject);
      const flow = await readRalphFlow(args.workspaceRoot, resolution.id, {
        allowInvalid: true,
      });

      if (args.json) {
        printJson({ flow: summarizeFlow(flow), path: resolution.path });
        return;
      }

      printFlowLines(flow, resolution.path);
      return;
    }
    case "validate": {
      const subject = options.subject ??
        fail("Expected a flow id or alias after `machdoch ralph validate`.");
      const resolution = await resolveRalphFlowReference(args.workspaceRoot, subject);
      const path = resolution.path;
      const flow = resolution.flow;
      const validation = validateRalphFlow(flow);

      if (args.json) {
        printJson({ path, validation });
        return;
      }

      writeStdoutLine(validation.valid ? "valid: true" : "valid: false");
      for (const error of validation.errors) {
        writeStdoutLine(`error: ${error}`);
      }
      for (const warning of validation.warnings) {
        writeStdoutLine(`warning: ${warning}`);
      }
      return;
    }
    case "delete": {
      const subject = options.subject ??
        fail("Expected a flow id or alias after `machdoch ralph delete`.");
      const result = await deleteRalphFlow(args.workspaceRoot, subject);

      if (args.json) {
        printJson(result);
        return;
      }

      writeStdoutLine(`ralph delete: ${result.id}`);
      writeStdoutLine(`path: ${result.path}`);
      if (result.deletedRevisions) {
        writeStdoutLine(`revisions: ${result.revisionDirectory}`);
      }
      return;
    }
    case "revisions": {
      const subject = options.subject ??
        fail("Expected a flow id or alias after `machdoch ralph revisions`.");
      const revisions = await listRalphFlowRevisions(args.workspaceRoot, subject);

      if (args.json) {
        printJson({ flow: subject, revisions });
        return;
      }

      writeStdoutLine(`ralph revisions: ${revisions.length}`);
      for (const revision of revisions) {
        writeStdoutLine(
          `- ${revision.id} ${revision.createdAt} blocks=${revision.blockCount} edges=${revision.edgeCount} valid=${revision.valid ? "true" : "false"}`,
        );
      }
      return;
    }
    case "restore": {
      const subject = options.subject ??
        fail("Expected a flow id or alias after `machdoch ralph restore`.");
      const revision = options.revision ??
        fail("Expected --revision for `machdoch ralph restore`.");
      const result = await restoreRalphFlowRevision(
        args.workspaceRoot,
        subject,
        revision,
      );

      if (args.json) {
        printJson({
          path: result.path,
          flow: summarizeFlow(result.flow),
          validation: result.validation,
          revision: result.revision,
        });
        return;
      }

      writeStdoutLine(`ralph restore: ${result.flow.id}`);
      writeStdoutLine(`revision: ${result.revision.id}`);
      writeStdoutLine(`path: ${result.path}`);
      for (const error of result.validation.errors) {
        writeStdoutLine(`error: ${error}`);
      }
      for (const warning of result.validation.warnings) {
        writeStdoutLine(`warning: ${warning}`);
      }
      return;
    }
    case "save": {
      const subject = options.subject ??
        fail("Expected a flow id or alias after `machdoch ralph save`.");
      const rawFlow = options.flowJson ??
        (options.flowJsonFile
          ? await readRalphWorkspaceFile(args.workspaceRoot, options.flowJsonFile)
          : fail("Expected --flow-json or --flow-json-file for `machdoch ralph save`."));
      const flow = parseRalphFlowJson(rawFlow);

      const normalizedSubject = subject.trim().toLowerCase();
      const subjectMatchesFlow =
        flow.id === normalizedSubject ||
        flow.alias?.trim().toLowerCase() === normalizedSubject;

      if (!subjectMatchesFlow) {
        fail(
          `Expected --flow-json to contain Ralph flow id or alias \`${subject}\`, got \`${flow.id}\`.`,
        );
      }

      const path = await writeRalphFlow(args.workspaceRoot, flow, {
        createRevision: true,
        reason: "manual-save",
        allowInvalid: true,
      });
      const storedFlow = await readRalphFlow(args.workspaceRoot, flow.id, {
        allowInvalid: true,
      });
      const validation = validateRalphFlow(storedFlow);

      if (args.json) {
        printJson({ path, flow: summarizeFlow(storedFlow), validation });
        return;
      }

      writeStdoutLine(`ralph save: ${storedFlow.id}`);
      writeStdoutLine(`path: ${path}`);
      for (const error of validation.errors) {
        writeStdoutLine(`error: ${error}`);
      }
      for (const warning of validation.warnings) {
        writeStdoutLine(`warning: ${warning}`);
      }
      return;
    }
    case "run": {
      const subject = options.subject ??
        fail("Expected a flow id or alias after `machdoch ralph run`.");
      const config = await loadRuntimeConfig(
        args.workspaceRoot,
        "machdoch",
        args.profile,
        args.model,
        args.runtimeProvider,
        args.agentLimits,
        args.reasoning,
      );
      const customizations = await discoverCustomizations(
        args.workspaceRoot,
        createDiscoveryOptions(config.compatibility.discoverGithubCustomizations),
      );
      const flow = await readRalphFlow(args.workspaceRoot, subject);
      const fileParams = options.paramsFile
        ? await readRalphParamsFile(args.workspaceRoot, options.paramsFile)
        : [];
      const variableValues = parseVariableValues([
        ...(options.params ?? []),
        ...fileParams,
      ]);
      const result = await runRalphFlow(flow, config, customizations, {
        variableValues,
        ...(options.maxTransitions !== undefined
          ? { maxTransitions: options.maxTransitions }
          : {}),
        ...(args.json
          ? {
              onEvent: createRalphEventProgressReporter(flow, config.mode),
            }
          : {}),
      });
      const runRecord = await writeRalphRunRecord(args.workspaceRoot, flow, result, {
        variableValues,
      });

      if (args.json) {
        printJson({ run: summarizeRun(result), runLogPath: runRecord.path });
        return;
      }

      writeStdoutLine(`ralph run: ${result.status}`);
      writeStdoutLine(result.summary);
      writeStdoutLine(`run log: ${runRecord.path}`);
      for (const event of result.events) {
        if (event.type === "edge-route") {
          writeStdoutLine(`- ${event.from}.${event.output} -> ${event.to}`);
        } else if (event.type === "crash") {
          writeStdoutLine(`- crash ${event.blockId}.${event.output}: ${event.reason}`);
        }
      }

      for (const blockResult of result.blockResults) {
        if (blockResult.result?.response || blockResult.result?.outputSections.length) {
          printExecutionSummary(blockResult.result);
        }
      }
      return;
    }
    case "create": {
      const name = options.name ?? options.subject ??
        fail("Expected --name or a flow alias for `machdoch ralph create`.");
      const prompt = await getPromptText(args, options);

      if (!prompt.trim()) {
        fail("Expected --prompt or --prompt-file for `machdoch ralph create`.");
      }

      const existingFlowJson = options.existingFlowJson ??
        (options.existingFlowJsonFile
          ? await readRalphWorkspaceFile(args.workspaceRoot, options.existingFlowJsonFile)
          : undefined);
      const existingFlow = existingFlowJson
        ? parseRalphFlowJson(existingFlowJson)
        : undefined;
      const config = await loadRuntimeConfig(
        args.workspaceRoot,
        "machdoch",
        args.profile,
        args.model,
        args.runtimeProvider,
        args.agentLimits,
        args.reasoning,
      );
      const customizations = await discoverCustomizations(
        args.workspaceRoot,
        createDiscoveryOptions(config.compatibility.discoverGithubCustomizations),
      );
      const result = await createRalphFlowWithAgent(args.workspaceRoot, {
        name,
        prompt,
        config,
        customizations,
        ...(existingFlow ? { existingFlow } : {}),
        ...(options.target ? { target: options.target } : {}),
        ...(options.generationMode ? { mode: options.generationMode } : {}),
        ...(options.maxRounds ? { maxRounds: options.maxRounds } : {}),
      });

      if (args.json) {
        printJson({
          status: result.status,
          flowPath: result.flowPath,
          rounds: result.rounds,
          validation: result.validation,
          summary: result.summary,
          flow: result.flow ? summarizeFlow(result.flow) : null,
        });
        return;
      }

      writeStdoutLine(`ralph create: ${result.status}`);
      writeStdoutLine(`path: ${result.flowPath}`);
      writeStdoutLine(`rounds: ${result.rounds}`);
      writeStdoutLine(result.summary);
      for (const error of result.validation.errors) {
        writeStdoutLine(`error: ${error}`);
      }
      for (const warning of result.validation.warnings) {
        writeStdoutLine(`warning: ${warning}`);
      }
      return;
    }
  }
};
