import { existsSync } from "node:fs";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  MAX_RALPH_SIMPLE_LOG_CHARS,
  capLogText,
  createLogTimestamp,
  createRalphLogLine,
  normalizeRunId,
  sanitizeTraceValue,
} from "../ralph.js";
import {
  getRalphStorageDirectory,
  type RalphFlowScope,
} from "./create-ralph-storage-paths.helper.js";
import type {
  RalphFlowGenerationResult,
  RalphGenerationEvent,
  RalphGenerationLogPaths,
} from "../ralph-generation.js";

const RALPH_GENERATION_SUBDIRECTORY = "generations";

export const getRalphGenerationDirectory = (
  workspaceRoot: string,
  scope: RalphFlowScope = "workspace",
): string => {
  return join(
    getRalphStorageDirectory(workspaceRoot, scope),
    RALPH_GENERATION_SUBDIRECTORY,
  );
};

export const createRalphGenerationArtifactPaths = (
  generationDirectory: string,
  timestamp: string,
  preferredId?: string,
): RalphGenerationLogPaths => {
  const baseName = preferredId
    ? normalizeRunId(preferredId)
    : timestamp.replace(/[:.]/gu, "-");
  let id = baseName;
  let candidateDirectory = join(generationDirectory, id);
  let suffix = 1;

  while (existsSync(candidateDirectory)) {
    id = `${baseName}-${suffix}`;
    candidateDirectory = join(generationDirectory, id);
    suffix += 1;
  }

  return {
    id,
    directory: candidateDirectory,
    recordPath: join(candidateDirectory, "generation.json"),
    simpleMarkdownPath: join(candidateDirectory, "simple.md"),
    traceJsonlPath: join(candidateDirectory, "trace.jsonl"),
  };
};

export const formatRalphGenerationMarkdownEntry = (
  event: RalphGenerationEvent,
): string => {
  const round = event.round ? ` round ${event.round}` : "";
  const actor = event.actor ? ` ${event.actor}` : "";
  const counts =
    event.blockCount !== undefined || event.edgeCount !== undefined
      ? ` (${event.blockCount ?? 0} blocks, ${event.edgeCount ?? 0} edges)`
      : "";

  return `- ${event.createdAt}${round}${actor} ${event.message}${counts}`;
};

export class RalphFileGenerationLogger {
  private pending: Promise<void> = Promise.resolve();
  private failed = false;

  public constructor(public readonly paths: RalphGenerationLogPaths) {}

  public event(event: RalphGenerationEvent): void {
    const safeEvent: RalphGenerationEvent = {
      ...event,
      message: capLogText(event.message, MAX_RALPH_SIMPLE_LOG_CHARS),
    };

    this.enqueue(async () => {
      await appendFile(this.paths.traceJsonlPath, createRalphLogLine(safeEvent), "utf8");
      await appendFile(
        this.paths.simpleMarkdownPath,
        `${formatRalphGenerationMarkdownEntry(safeEvent)}\n`,
        "utf8",
      );
    });
  }

  public async record(result: RalphFlowGenerationResult): Promise<void> {
    await this.flush();
    await writeFile(
      this.paths.recordPath,
      `${JSON.stringify(sanitizeTraceValue(result), null, 2)}\n`,
      "utf8",
    );
  }

  public async flush(): Promise<void> {
    await this.pending.catch(() => undefined);
  }

  private enqueue(write: () => Promise<void>): void {
    if (this.failed) {
      return;
    }

    this.pending = this.pending
      .then(write)
      .catch(() => {
        this.failed = true;
      });
  }
}

export const createRalphGenerationLogger = async (
  workspaceRoot: string,
  options: {
    runId: string;
    flowPath: string;
    generationFlowPath: string;
    prompt: string;
    scope?: RalphFlowScope;
  },
): Promise<RalphFileGenerationLogger> => {
  const createdAt = createLogTimestamp();
  const paths = createRalphGenerationArtifactPaths(
    getRalphGenerationDirectory(workspaceRoot, options.scope ?? "workspace"),
    createdAt,
    options.runId,
  );
  const logger = new RalphFileGenerationLogger(paths);

  await mkdir(paths.directory, { recursive: true });
  await writeFile(
    paths.simpleMarkdownPath,
    [
      `# Ralph Generation ${paths.id}`,
      "",
      `Started: ${createdAt}`,
      `Flow path: ${options.flowPath}`,
      `Temporary flow path base: ${options.generationFlowPath}`,
      "Per-round temporary flow paths append `-round-N` before the file extension.",
      "",
      "## Prompt",
      "",
      capLogText(options.prompt, MAX_RALPH_SIMPLE_LOG_CHARS),
      "",
      "## Activity",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(paths.traceJsonlPath, "", "utf8");

  return logger;
};
