import { randomUUID } from "node:crypto";
import { isAbsolute, sep } from "node:path";
import { createFilesystemToolDefinitions } from "./filesystem-tool-definitions.js";
import { createGitToolDefinitions } from "./git-tool-definitions.js";
import { createShellNetworkToolDefinitions } from "./shell-network-tool-definitions.js";
import {
  createToolErrorResult,
  resolveWorkspaceTarget,
  type AgentToolDefinition,
} from "./agent-tools-shared.js";
import type {
  ParallelWorkerPlan,
  ValidatedWorker,
  ParallelAgentSessionOptions,
} from "./parallel-agent-types.js";
import {
  WorkerBoundaryError,
  WORKER_WRITE_TOOLS as WRITE_TOOLS,
} from "./parallel-agent-worker-state.js";

const READ_TOOLS = new Set([
  "list_directory",
  "read_file",
  "search_workspace",
  "get_git_status",
  "get_git_diff_summary",
  "get_git_log",
  "fetch_url",
  "search_web",
]);
const SCOPED_TOOLS = new Set(["read_file", "create_file", "replace_in_file"]);
const canonicalPath = (path: string): string =>
  process.platform === "win32" ? path.toLocaleLowerCase("en-US") : path;

const pathsOverlap = (first: string, second: string): boolean =>
  first === second ||
  first.startsWith(`${second}${sep}`) ||
  second.startsWith(`${first}${sep}`);

export const normalizePlan = (
  value: unknown,
  maxWorkers: number,
): ParallelWorkerPlan[] => {
  if (!Array.isArray(value) || value.length < 2 || value.length > maxWorkers) {
    throw new Error(
      `Choose ${maxWorkers === 2 ? "two" : "two or three"} independent workers.`,
    );
  }
  const ids = new Set<string>();
  return value.map((entry: unknown) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("Every worker needs an objective and path claims.");
    }
    const worker = entry as Record<string, unknown>;
    const id = typeof worker.id === "string" ? worker.id.trim() : "";
    const objective =
      typeof worker.objective === "string" ? worker.objective.trim() : "";
    if (
      !/^[a-z][a-z0-9_-]{0,31}$/u.test(id) ||
      ids.has(id) ||
      !objective ||
      objective.length > 2_000
    ) {
      throw new Error(
        "Worker ids must be unique and objectives must be self-contained.",
      );
    }
    if (worker.access !== "read-only" && worker.access !== "write") {
      throw new Error(`Worker ${id} has an invalid access mode.`);
    }
    if (
      !Array.isArray(worker.readPaths) ||
      !Array.isArray(worker.writePaths) ||
      [...worker.readPaths, ...worker.writePaths].some(
        (path) =>
          typeof path !== "string" || !path.trim() || path.length > 1_000,
      ) ||
      worker.readPaths.length > 32 ||
      worker.writePaths.length > 32
    ) {
      throw new Error(`Worker ${id} has invalid path claims.`);
    }
    if (worker.access === "read-only" && worker.writePaths.length > 0) {
      throw new Error(`Read-only worker ${id} cannot claim write paths.`);
    }
    if (worker.access === "write" && worker.writePaths.length === 0) {
      throw new Error(`Write worker ${id} needs explicit file paths.`);
    }
    ids.add(id);
    return {
      id,
      objective,
      access: worker.access,
      readPaths: worker.readPaths as string[],
      writePaths: worker.writePaths as string[],
    };
  });
};

export const validatePlans = async (
  workers: ParallelWorkerPlan[],
  options: ParallelAgentSessionOptions,
): Promise<ValidatedWorker[]> => {
  if (options.mode === "disabled" || options.mode === "native") {
    throw new Error("Parallel agents are disabled for this session.");
  }
  if (
    workers.some((worker) => worker.access === "write") &&
    (options.mode !== "machdoch" || options.config.mode !== "machdoch")
  ) {
    throw new Error(
      "Write workers require Full Mode and Machdoch execution mode.",
    );
  }
  const validated = await Promise.all(
    workers.map(async (worker) => {
      const resolveClaims = async (paths: string[]): Promise<string[]> => {
        const claims = await Promise.all(
          paths.map(async (path) => {
            const target = await resolveWorkspaceTarget(
              options.config.workspaceRoot,
              path,
            );
            if (
              !target.insideWorkspace ||
              !target.workspacePath ||
              isAbsolute(path)
            ) {
              throw new Error(
                `Worker ${worker.id} claims a path outside the workspace or its root.`,
              );
            }
            return canonicalPath(target.resolvedPath);
          }),
        );
        return [...new Set(claims)];
      };
      return {
        ...worker,
        canonicalReadPaths: await resolveClaims(worker.readPaths),
        canonicalWritePaths: await resolveClaims(worker.writePaths),
      };
    }),
  );

  for (let index = 0; index < validated.length; index += 1) {
    const current = validated[index]!;
    for (const other of validated.slice(index + 1)) {
      if (
        (current.canonicalWritePaths.length > 0 &&
          other.access === "read-only" &&
          other.canonicalReadPaths.length === 0) ||
        (other.canonicalWritePaths.length > 0 &&
          current.access === "read-only" &&
          current.canonicalReadPaths.length === 0)
      ) {
        throw new Error(
          "A worker with unrestricted reads cannot run alongside a write worker.",
        );
      }
      const conflicts =
        current.canonicalWritePaths.some((path) =>
          [...other.canonicalWritePaths, ...other.canonicalReadPaths].some(
            (claim) => pathsOverlap(path, claim),
          ),
        ) ||
        other.canonicalWritePaths.some((path) =>
          current.canonicalReadPaths.some((claim) => pathsOverlap(path, claim)),
        );
      if (conflicts) {
        throw new Error(
          `Workers ${current.id} and ${other.id} have overlapping paths.`,
        );
      }
    }
  }
  return validated;
};

export const createWorkerTools = (
  options: ParallelAgentSessionOptions,
  worker: ValidatedWorker,
  scopedReads: boolean,
): AgentToolDefinition[] => {
  const definitions = [
    ...createFilesystemToolDefinitions(),
    ...createGitToolDefinitions(),
    ...createShellNetworkToolDefinitions(options.config),
  ];
  const allowed =
    worker.access === "write"
      ? SCOPED_TOOLS
      : scopedReads
        ? new Set(["read_file"])
        : READ_TOOLS;
  return definitions
    .filter((definition) => allowed.has(definition.spec.name))
    .map((definition) => ({
      ...definition,
      execute: async (args, context) => {
        context.signal?.throwIfAborted();
        const path = args.path;
        if (scopedReads && typeof path !== "string") {
          return createToolErrorResult(
            randomUUID(),
            definition.spec.name,
            "This worker can only use scoped file paths.",
          );
        }
        if (typeof path === "string" && scopedReads) {
          const target = await resolveWorkspaceTarget(
            context.workspaceRoot,
            path,
          );
          context.signal?.throwIfAborted();
          const claim = canonicalPath(target.resolvedPath);
          const allowedPaths = WRITE_TOOLS.has(definition.spec.name)
            ? worker.canonicalWritePaths
            : [...worker.canonicalReadPaths, ...worker.canonicalWritePaths];
          const claimed = WRITE_TOOLS.has(definition.spec.name)
            ? allowedPaths.includes(claim)
            : allowedPaths.some(
                (path) => claim === path || claim.startsWith(`${path}${sep}`),
              );
          if (!target.insideWorkspace || !claimed) {
            throw new WorkerBoundaryError(
              `Worker ${worker.id} attempted to access an unclaimed path.`,
            );
          }
        }
        return definition.execute(args, context);
      },
    }));
};
