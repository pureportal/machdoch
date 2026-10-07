import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { join, resolve, relative, isAbsolute } from "node:path";
import { createInterface } from "node:readline";
import {
  ralphRequestSchema,
  type RalphRequest,
  type OperationResponse,
  type ProductSnapshot,
} from "@machdoch/fleet-protocol";
import { FleetOperationStore } from "../../core/fleet-operations.js";
import { loadUserInternalTaskModelSettings } from "../../core/env.js";
import { terminateProcessTree } from "../../core/_helpers/process-tree.js";
import type {
  ActiveDesktopTaskSummary,
  RecentDesktopTaskResult,
} from "../../shared/task-run-state.js";

export class FleetRalphEditor {
  private readonly operations = new FleetOperationStore();
  private readonly active = new Map<
    string,
    {
      summary: ActiveDesktopTaskSummary;
      cancel: () => Promise<void>;
      settled: Promise<unknown>;
    }
  >();
  private readonly completed = new Map<
    string,
    { result: RecentDesktopTaskResult; bytes: number }
  >();
  private completedBytes = 0;
  private readonly children = new Set<{
    cancel: () => Promise<void>;
    settled: Promise<unknown>;
  }>();
  private readonly claimedTaskIds = new Set<string>();
  private stopped = false;

  constructor(
    private readonly assertWorkspace: (workspace: string) => Promise<string>,
  ) {}

  getActiveTasks(): ActiveDesktopTaskSummary[] {
    return [...this.active.values()].map(({ summary }) => summary);
  }

  isWorkspaceBusy(workspace: string): boolean {
    return this.getActiveTasks().some(
      (task) =>
        task.workspaceRoot === workspace &&
        ["run", "resume"].includes(task.arguments[0]!) &&
        !task.arguments.includes("--isolated"),
    );
  }

  async cancel(taskId: string): Promise<void> {
    await this.active.get(taskId)?.cancel();
  }

  getTaskSnapshots(): ProductSnapshot["sessions"] {
    return this.getActiveTasks().map((task) => {
      const latest = task.progressEvents?.at(-1);
      const subject = task.arguments[1]?.startsWith("--")
        ? task.arguments[task.arguments.indexOf("--name") + 1]
        : task.arguments[1];
      const title =
        subject && subject !== task.arguments[0]
          ? `RALPH: ${subject}`
          : "RALPH";
      return {
        taskId: task.id,
        task: title.slice(0, 12_000),
        mode: "machdoch",
        state: "running",
        message: (latest?.progress.message ?? "RALPH running").slice(0, 12_000),
        cancellable: true,
        startedAt: task.startedAt,
        updatedAt: latest?.timestamp ?? task.startedAt,
        progressCount: task.progressEvents?.length ?? 0,
        logs: [],
        timeline: [],
      };
    });
  }

  async request(input: RalphRequest): Promise<OperationResponse> {
    const request = ralphRequestSchema.parse(input);
    if (this.stopped)
      return { state: "failed", error: "Fleet service is stopping." };
    return this.operations.handle(
      request,
      async () => {
        if (request.kind !== "invoke")
          throw new Error("Expected RALPH operation.");
        switch (request.command) {
          case "get_active_desktop_tasks":
            return this.getActiveTasks();
          case "get_user_internal_task_model_settings":
            return loadUserInternalTaskModelSettings();
          case "get_recent_desktop_task_results":
            return request.args.taskIds.flatMap((id) =>
              this.completed.has(id) ? [this.completed.get(id)!.result] : [],
            );
          case "cancel_desktop_task":
            await this.cancel(request.args.taskId);
            return null;
          case "run_ralph_command":
            return this.execute(request.args.request);
        }
      },
      request.kind === "invoke" && request.command !== "run_ralph_command",
    );
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    const children = [...this.children];
    await Promise.all(children.map((entry) => entry.cancel()));
    await Promise.allSettled(children.map((entry) => entry.settled));
  }

  private async execute(request: {
    workspaceRoot: string;
    arguments: string[];
    taskId?: string | undefined;
  }): Promise<unknown> {
    const taskId = request.taskId;
    if (taskId && this.claimedTaskIds.has(taskId))
      throw new Error("RALPH task ID is already in use.");
    if (taskId) this.claimedTaskIds.add(taskId);
    try {
      return await this.executeClaimed(request);
    } finally {
      if (taskId && !this.completed.has(taskId))
        this.claimedTaskIds.delete(taskId);
    }
  }

  private async executeClaimed(request: {
    workspaceRoot: string;
    arguments: string[];
    taskId?: string | undefined;
  }): Promise<unknown> {
    const taskId = request.taskId;
    const workspaceRoot = await this.assertWorkspace(request.workspaceRoot);
    const resolvedWorkspace = await realpath(workspaceRoot);
    const temporaryRoot = join(
      resolvedWorkspace,
      ".machdoch",
      "local",
      "cache",
      "fleet-payloads",
    );
    await mkdir(temporaryRoot, { recursive: true });
    const resolvedTemporaryRoot = await realpath(temporaryRoot);
    const relativeTemporaryRoot = relative(
      resolvedWorkspace,
      resolvedTemporaryRoot,
    );
    if (
      relativeTemporaryRoot.startsWith("..") ||
      isAbsolute(relativeTemporaryRoot)
    )
      throw new Error("RALPH payload directory is outside the workspace.");
    const directory = await mkdtemp(join(temporaryRoot, "ralph-"));
    const relativePath = relative(resolve(temporaryRoot), resolve(directory));
    if (
      !relativePath ||
      relativePath.startsWith("..") ||
      isAbsolute(relativePath)
    )
      throw new Error("Invalid RALPH payload directory.");
    const cancelPath = join(directory, "cancel.request");
    const args = [...request.arguments];
    try {
      for (let index = 0; index < args.length; index += 1) {
        const fileFlag = new Map([
          ["--flow-json", "--flow-json-file"],
          ["--existing-flow-json", "--existing-flow-json-file"],
          ["--input-json", "--input-json-file"],
          ["--prompt", "--prompt-file"],
        ]).get(args[index]!);
        if (!fileFlag) continue;
        const filename = join(directory, `payload-${index}.json`);
        await writeFile(filename, args[index + 1]!, {
          encoding: "utf8",
          mode: 0o600,
        });
        args[index] = fileFlag;
        args[++index] = filename;
      }
      const parameters: string[] = [];
      for (let index = 0; index < args.length; index += 1) {
        if (args[index] !== "--param") continue;
        parameters.push(args[index + 1]!);
        args.splice(index, 2);
        index -= 1;
      }
      if (parameters.length) {
        const path = join(directory, "parameters.json");
        await writeFile(path, JSON.stringify(parameters), {
          encoding: "utf8",
          mode: 0o600,
        });
        args.push("--params-file", path);
      }
      const summary: ActiveDesktopTaskSummary = {
        id: taskId ?? directory,
        kind: "ralph",
        workspaceRoot,
        arguments: request.arguments,
        startedAt: Date.now(),
        progressEvents: [],
      };
      const commandArgs = [
        ...process.execArgv.filter((value) => !value.startsWith("--inspect")),
        resolve(process.argv[1]!),
        "--json",
        "--cwd",
        workspaceRoot,
        "ralph",
        ...args,
      ];
      if (this.stopped) throw new Error("Fleet service is stopping.");
      const child = spawn(process.execPath, commandArgs, {
        cwd: process.cwd(),
        windowsHide: true,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, MACHDOCH_RALPH_CANCEL_PATH: cancelPath },
      });
      let stdout = "";
      let stderr = "";
      let bytes = 0;
      let overflow = false;
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 48 * 1024 * 1024) {
          overflow = true;
          void terminateProcessTree(child, true);
        } else stdout += chunk;
      });
      const lines = createInterface({ input: child.stderr });
      lines.on("line", (line) => {
        if (line.startsWith("machdoch-progress: ")) {
          if (line.length > 65_536) {
            stderr = "RALPH progress exceeded the limit.";
            return;
          }
          try {
            const progress = JSON.parse(
              line.slice("machdoch-progress: ".length),
            );
            if (taskId) {
              const timestamp = Date.now();
              summary.progressEvents!.push({ timestamp, progress });
              if (summary.progressEvents!.length > 160)
                summary.progressEvents!.shift();
              this.operations.recordProgress({ taskId, timestamp, progress });
            }
          } catch {
            stderr = "RALPH returned invalid progress.";
          }
        } else stderr = `${stderr}\n${line}`.slice(-12_000);
      });
      let cancelTimer: ReturnType<typeof setTimeout> | undefined;
      const settled = new Promise<unknown>((resolveResult, reject) => {
        child.once("error", reject);
        child.once("close", (code) => {
          clearTimeout(cancelTimer);
          lines.close();
          if (overflow)
            return reject(
              new Error(
                "RALPH response exceeded the limit. Inspect the saved run on the device.",
              ),
            );
          try {
            resolveResult(JSON.parse(stdout));
          } catch {
            reject(
              new Error(
                `RALPH command failed (${code ?? "terminated"}). ${stderr}`,
              ),
            );
          }
        });
      });
      const cancel = async (): Promise<void> => {
        await writeFile(cancelPath, "RALPH cancelled from Fleet.");
        cancelTimer ??= setTimeout(() => {
          void terminateProcessTree(child, true);
        }, 30_000);
        cancelTimer.unref();
      };
      const running = { cancel, settled };
      this.children.add(running);
      if (taskId) this.active.set(taskId, { summary, cancel, settled });
      try {
        const response = await settled;
        if (taskId) this.remember(summary, { status: "succeeded", response });
        return response;
      } catch (error) {
        if (taskId)
          this.remember(summary, {
            status: "failed",
            failure: {
              kind: "runtime",
              message: error instanceof Error ? error.message : String(error),
            },
          });
        throw error;
      } finally {
        this.children.delete(running);
        if (taskId) this.active.delete(taskId);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  private remember(
    summary: ActiveDesktopTaskSummary,
    outcome: RecentDesktopTaskResult["outcome"],
  ): void {
    const result: RecentDesktopTaskResult = {
      id: summary.id,
      kind: summary.kind,
      workspaceRoot: summary.workspaceRoot,
      arguments: summary.arguments,
      startedAt: summary.startedAt,
      finishedAt: Date.now(),
      outcome,
    };
    const bytes = Buffer.byteLength(JSON.stringify(result));
    this.completed.set(summary.id, { result, bytes });
    this.completedBytes += bytes;
    while (
      this.completed.size > 160 ||
      this.completedBytes > 64 * 1024 * 1024
    ) {
      const id = this.completed.keys().next().value!;
      this.completedBytes -= this.completed.get(id)!.bytes;
      this.completed.delete(id);
      this.claimedTaskIds.delete(id);
    }
  }
}
