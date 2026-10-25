import { spawn } from "node:child_process";
import { GuestProcessStopError, stopGuestWorkload } from "./process-group.ts";
import { commandDirectory } from "./files.ts";

function readableOutput(chunks: Buffer[]) {
  return Buffer.concat(chunks)
    .toString("utf8")
    .replace(/[\p{Cc}--[\t\n\r]]/gv, "�");
}

interface ShellResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  truncated: boolean;
  stdout: string;
  stderr: string;
}

export async function runShell(
  input: Record<string, unknown>,
): Promise<ShellResult> {
  if (
    typeof input.command !== "string" ||
    !input.command.trim() ||
    Buffer.byteLength(input.command) > 32768
  )
    throw new Error("Invalid shell command");
  const timeout = input.timeoutMs ?? 30000;
  if (
    typeof timeout !== "number" ||
    !Number.isInteger(timeout) ||
    timeout < 1 ||
    timeout > 300000
  )
    throw new Error("Command timeout must be between 1 and 300000 ms");
  const cwd = await commandDirectory(input.directory);
  const command = input.command;
  return new Promise<ShellResult>((resolve, reject) => {
    const child = spawn(
      "/usr/bin/python3",
      [
        "-I",
        "/opt/machdoch/exec.py",
        "/bin/bash",
        "--noprofile",
        "--norc",
        "-c",
        command,
      ],
      {
        cwd,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          HOME: "/workspace",
          PATH: "/usr/local/bin:/usr/bin:/bin",
          LANG: "C.UTF-8",
          TERM: "dumb",
          CI: "true",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_SYSTEM: "/dev/null",
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "safe.directory",
          GIT_CONFIG_VALUE_0: "/workspace",
        },
      },
    );
    const stdout: Buffer[] = [],
      stderr: Buffer[] = [];
    let size = 0,
      truncated = false,
      timedOut = false,
      closed = false;
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    let failure: Error | undefined;
    let stopping: Promise<void> | undefined;
    let drain: ReturnType<typeof setTimeout> | undefined;
    function capture(target: Buffer[], chunk: Buffer) {
      const remaining = 262144 - size;
      if (chunk.length > remaining) truncated = true;
      if (remaining > 0) {
        const part = chunk.subarray(0, remaining);
        target.push(part);
        size += part.length;
      }
    }
    function terminate() {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !("code" in error) ||
          error.code !== "ESRCH"
        )
          throw error;
      }
    }
    function finish() {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      clearTimeout(drain);
      child.stdout.destroy();
      child.stderr.destroy();
      stopping ??= stopGuestWorkload();
      void stopping
        .then(() => {
          if (failure) {
            reject(failure);
            return;
          }
          resolve({
            exitCode,
            signal: exitSignal,
            timedOut,
            truncated,
            stdout: readableOutput(stdout),
            stderr: readableOutput(stderr),
          });
        })
        .catch(reject);
    }
    child.stdout.on("data", (chunk) => capture(stdout, chunk));
    child.stderr.on("data", (chunk) => capture(stderr, chunk));
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        terminate();
        stopping ??= stopGuestWorkload();
        void stopping.then(finish, reject);
      } catch (error) {
        reject(new GuestProcessStopError(error));
      }
    }, timeout);
    child.once("error", (error) => {
      failure = error;
      clearTimeout(timer);
      finish();
    });
    child.once("exit", (code, signal) => {
      if (closed) return;
      exitCode = code;
      exitSignal = signal;
      try {
        terminate();
        stopping ??= stopGuestWorkload();
        void stopping.catch(reject);
      } catch (error) {
        clearTimeout(timer);
        reject(new GuestProcessStopError(error));
        return;
      }
      drain = setTimeout(() => {
        truncated = true;
        finish();
      }, 500);
    });
    child.once("close", finish);
  });
}
