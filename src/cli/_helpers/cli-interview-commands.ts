import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { loadRuntimeConfig } from "../../core/config.js";
import { discoverCustomizations } from "../../core/customizations.js";
import type { RalphInputValue } from "../../core/ralph.js";
import {
  createTaskInterviewWithAgent,
  type TaskInterviewSession,
} from "../../core/task-interview.js";
import { createDiscoveryOptions } from "./cli-output.js";
import {
  createVerboseProgressReporter,
  writeStderrLine,
  writeStdoutLine,
} from "./cli-io.js";
import type { ParsedCliArgs, TaskInterviewCliOptions } from "./cli-args.js";

const fail = (message: string): never => {
  throw new Error(message);
};

const printJson = (value: unknown): void => {
  writeStdoutLine(JSON.stringify(value, null, 2));
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
    throw new Error("Expected interview file path to be non-empty.");
  }

  const resolvedWorkspaceRoot = await realpath(workspaceRoot);
  const candidatePath = isAbsolute(normalizedPath)
    ? normalizedPath
    : resolve(resolvedWorkspaceRoot, normalizedPath);
  const resolvedPath = await realpath(candidatePath);

  if (!isPathInside(resolvedWorkspaceRoot, resolvedPath)) {
    throw new Error("Refusing to read interview file outside the workspace.");
  }

  const metadata = await stat(resolvedPath);

  if (!metadata.isFile()) {
    throw new Error("Expected interview file path to point to a file.");
  }

  return resolvedPath;
};

const readInterviewWorkspaceFile = async (
  workspaceRoot: string,
  path: string,
): Promise<string> => {
  const resolvedPath = await resolveWorkspaceFile(workspaceRoot, path);

  return await readFile(resolvedPath, "utf8");
};

const getInterviewPromptText = async (
  args: ParsedCliArgs,
  options: TaskInterviewCliOptions,
): Promise<string> => {
  if (options.prompt) {
    return options.prompt.trim();
  }

  if (options.promptFile) {
    return (await readInterviewWorkspaceFile(
      args.workspaceRoot,
      options.promptFile,
    )).trim();
  }

  return "";
};

const isTaskInterviewInputValue = (
  value: unknown,
): value is RalphInputValue => {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    (Array.isArray(value) && value.every((entry) => typeof entry === "string"))
  );
};

const parseTaskInterviewInputValues = (
  value: unknown,
): Record<string, RalphInputValue> => {
  if (!isRecord(value)) {
    throw new Error("Expected task interview input values to be a JSON object.");
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => {
      if (!isTaskInterviewInputValue(entry)) {
        throw new Error(
          `Expected task interview input value \`${key}\` to be a string, number, boolean, null, or string array.`,
        );
      }

      return [key, entry];
    }),
  );
};

const parseTaskInterviewAnswerComments = (
  value: Record<string, unknown>,
): Record<string, string> => {
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, entry]) =>
      typeof entry === "string" ? [[key, entry]] : [],
    ),
  );
};

const parseTaskInterviewContextNotes = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    if (typeof entry !== "string") {
      return [];
    }

    const normalizedEntry = entry.trim();

    return normalizedEntry ? [normalizedEntry] : [];
  });
};

interface TaskInterviewCliInput {
  session?: TaskInterviewSession;
  contextNotes?: string[];
  answers?: Record<string, RalphInputValue>;
  answerComments?: Record<string, string>;
}

const readTaskInterviewInput = async (
  args: ParsedCliArgs,
  options: TaskInterviewCliOptions,
): Promise<TaskInterviewCliInput> => {
  const raw =
    options.inputJson ??
    (options.inputJsonFile
      ? await readInterviewWorkspaceFile(args.workspaceRoot, options.inputJsonFile)
      : undefined);

  if (!raw) {
    return {};
  }

  const parsed = JSON.parse(raw) as unknown;

  if (!isRecord(parsed)) {
    throw new Error("Expected task interview input to be a JSON object.");
  }

  const answerComments = isRecord(parsed.answerComments)
    ? parseTaskInterviewAnswerComments(parsed.answerComments)
    : {};
  const contextNotes = parseTaskInterviewContextNotes(parsed.contextNotes);

  return {
    ...(isRecord(parsed.session)
      ? { session: parsed.session as unknown as TaskInterviewSession }
      : {}),
    ...(contextNotes.length > 0 ? { contextNotes } : {}),
    ...(isRecord(parsed.answers)
      ? { answers: parseTaskInterviewInputValues(parsed.answers) }
      : {}),
    ...(Object.keys(answerComments).length > 0
      ? { answerComments }
      : {}),
  };
};

const summarizeInterviewResult = (result: {
  status: string;
  summary: string;
  reason?: string;
  executedTools: string[];
}) => ({
  status: result.status,
  summary: result.summary,
  ...(result.reason ? { reason: result.reason } : {}),
  executedTools: result.executedTools,
});

export const printTaskInterviewSummary = async (
  args: ParsedCliArgs,
): Promise<void> => {
  const options = args.interview ?? fail("Expected interview options.");
  const prompt = await getInterviewPromptText(args, options);

  if (!prompt.trim()) {
    fail("Expected --prompt or --prompt-file for `machdoch interview`.");
  }

  const input = await readTaskInterviewInput(args, options);
  const config = await loadRuntimeConfig(
    args.workspaceRoot,
    args.mode,
    args.model,
    args.runtimeProvider,
    args.agentLimits,
    args.reasoning,
  );
  const customizations = await discoverCustomizations(
    args.workspaceRoot,
    createDiscoveryOptions(config.compatibility.discoverGithubCustomizations),
  );
  const result = await createTaskInterviewWithAgent(args.workspaceRoot, {
    prompt,
    config,
    customizations,
    ...(options.maxRounds ? { maxTurns: options.maxRounds } : {}),
    ...(input.session ? { session: input.session } : {}),
    ...(input.contextNotes ? { contextNotes: input.contextNotes } : {}),
    ...(input.answers ? { answers: input.answers } : {}),
    ...(input.answerComments ? { answerComments: input.answerComments } : {}),
    ...(args.verbose
      ? { onStateChange: createVerboseProgressReporter(writeStderrLine) }
      : {}),
  });

  if (args.json) {
    printJson({
      status: result.status,
      session: result.session,
      fields: result.fields,
      summary: result.summary,
      finalPrompt: result.finalPrompt ?? null,
      provider: result.provider ?? null,
      model: result.model ?? null,
      result: result.result ? summarizeInterviewResult(result.result) : null,
    });
    return;
  }

  writeStdoutLine(`interview: ${result.status}`);
  writeStdoutLine(result.summary);
  writeStdoutLine(`turn: ${result.session.turn}/${result.session.maxTurns}`);
  for (const field of result.fields) {
    writeStdoutLine(`- ${field.id} [${field.type}] ${field.label}`);
  }
};
