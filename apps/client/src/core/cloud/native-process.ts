import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

export interface BoundedProcessResult {
  pid: number | null;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  aborted: boolean;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

export interface BoundedProcessOptions {
  command: string;
  args?: string[];
  shell?: boolean;
  cwd: string;
  env: NodeJS.ProcessEnv;
  input?: string;
  timeoutMs: number;
  signal: AbortSignal;
  outputLimitBytes: number;
  onSpawn?: (pid: number) => Promise<void>;
}

export function taskEnvironment(
  additions: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const { MACHDOCH_CLOUD_RUNNER_TOKEN: _, ...environment } = process.env;
  return { ...environment, ...additions };
}

export function stopProcessTree(pid: number): void {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH"))
      throw error;
  }
}

export function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

class BoundedOutput {
  private readonly chunks: Buffer[] = [];
  private size = 0;
  truncated = false;
  constructor(private readonly limit: number) {}
  append(chunk: Buffer): void {
    const remaining = this.limit - this.size;
    if (remaining <= 0) {
      this.truncated = true;
      return;
    }
    const accepted = chunk.subarray(0, remaining);
    if (accepted.length < chunk.length) this.truncated = true;
    this.chunks.push(accepted);
    this.size += accepted.length;
  }
  text(): string {
    return Buffer.concat(this.chunks, this.size).toString("utf8");
  }
}

export async function runBoundedProcess(
  options: BoundedProcessOptions,
): Promise<BoundedProcessResult> {
  options.signal.throwIfAborted();
  const child = spawn(options.command, options.args ?? [], {
    cwd: options.cwd,
    env: options.env,
    shell: options.shell ?? false,
    windowsHide: true,
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdout = new BoundedOutput(options.outputLimitBytes);
  const stderr = new BoundedOutput(options.outputLimitBytes);
  child.stdout.on("data", (chunk: Buffer) => stdout.append(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.append(chunk));
  child.stdin.on("error", () => undefined);
  const closed = once(child, "close").catch(() => undefined);
  const exited = new Promise<{ code: number | null; signal: string | null }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    },
  );
  let timedOut = false;
  let aborted = false;
  const stop = () => {
    if (child.pid && child.exitCode === null && child.signalCode === null)
      stopProcessTree(child.pid);
  };
  const timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, options.timeoutMs);
  const abort = () => {
    aborted = true;
    stop();
  };
  options.signal.addEventListener("abort", abort, { once: true });
  try {
    if (child.pid) await options.onSpawn?.(child.pid);
    child.stdin.end(options.input ?? "");
    const exit = await exited;
    if (child.pid && process.platform !== "win32") stopProcessTree(child.pid);
    await Promise.race([closed, delay(5000)]);
    child.stdout.destroy();
    child.stderr.destroy();
    return {
      pid: child.pid ?? null,
      exitCode: exit.code,
      signal: exit.signal,
      timedOut,
      aborted,
      stdout: stdout.text(),
      stderr: stderr.text(),
      truncated: stdout.truncated || stderr.truncated,
    };
  } catch (error) {
    stop();
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener("abort", abort);
  }
}
