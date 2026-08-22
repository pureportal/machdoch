import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { normalizeLocalCommandCwd } from "./process-execution.js";
import { resolveShellCommandInvocation } from "./shell-network-tool-definitions.js";
import { writeJsonAtomically } from "./write-file-atomically.helper.js";

export interface RalphManagedServerOwnership {
  ownerId: string;
  pid: number;
  commandFingerprint: string;
  command: string;
  cwd: string;
  startedAt: string;
}

export interface RalphManagedServerHandle {
  child: ChildProcess;
  pid?: number;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  hasExited(): boolean;
  registryPath?: string;
}

interface RalphManagedServerDependencies {
  platform: NodeJS.Platform;
  spawn: typeof spawn;
  killProcessGroup(pid: number, signal: NodeJS.Signals): void;
  shutdownTimeoutMs?: number;
}

const DEFAULT_DEPENDENCIES: RalphManagedServerDependencies = {
  platform: process.platform,
  spawn,
  killProcessGroup: (pid, signal) => {
    process.kill(-pid, signal);
  },
};

export const startRalphManagedServer = async (
  options: {
    command: string;
    cwd: string;
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    ownerId?: string;
    registryPath?: string;
  },
  dependencies: RalphManagedServerDependencies = DEFAULT_DEPENDENCIES,
): Promise<RalphManagedServerHandle> => {
  if (options.signal?.aborted) {
    throw new Error("Ralph run stopped before the managed server started.");
  }

  const invocation = resolveShellCommandInvocation(
    options.command,
    dependencies.platform,
  );
  const child = dependencies.spawn(
    invocation.shellExecutable,
    invocation.shellArgs,
    {
      cwd: normalizeLocalCommandCwd(options.cwd, dependencies.platform),
      ...(options.env ? { env: options.env } : {}),
      detached: dependencies.platform !== "win32",
      stdio: "ignore",
      windowsHide: true,
    },
  );
  const exited = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) => {
    child.once("exit", (code, signal) => {
      resolve({ code, signal });
    });
  });

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const settle = (callback: () => void): void => {
      if (settled) {
        return;
      }

      settled = true;
      child.off("spawn", handleSpawn);
      child.off("error", handleError);
      callback();
    };
    const handleSpawn = (): void => {
      settle(resolve);
    };
    const handleError = (error: Error): void => {
      settle(() => reject(error));
    };

    child.once("spawn", handleSpawn);
    child.once("error", handleError);
  });

  if (options.registryPath && options.ownerId && child.pid !== undefined) {
    await mkdir(dirname(options.registryPath), { recursive: true });
    await writeJsonAtomically(options.registryPath, {
      ownerId: options.ownerId,
      pid: child.pid,
      commandFingerprint: createRalphManagedServerCommandFingerprint(
        options.command,
        options.cwd,
      ),
      command: options.command,
      cwd: options.cwd,
      startedAt: new Date().toISOString(),
    } satisfies RalphManagedServerOwnership);
  }

  return {
    child,
    ...(child.pid !== undefined ? { pid: child.pid } : {}),
    exited,
    hasExited: () => child.exitCode !== null || child.signalCode !== null,
    ...(options.registryPath ? { registryPath: options.registryPath } : {}),
  };
};

export const createRalphManagedServerCommandFingerprint = (
  command: string,
  cwd: string,
): string => createHash("sha256").update(`${cwd}\0${command}`).digest("hex");

export const readRalphManagedServerOwnership = async (
  registryPath: string,
): Promise<RalphManagedServerOwnership | undefined> => {
  try {
    const value = JSON.parse(await readFile(registryPath, "utf8")) as unknown;
    if (
      typeof value === "object" && value !== null &&
      typeof (value as RalphManagedServerOwnership).ownerId === "string" &&
      typeof (value as RalphManagedServerOwnership).pid === "number" &&
      typeof (value as RalphManagedServerOwnership).commandFingerprint === "string"
    ) {
      return value as RalphManagedServerOwnership;
    }
  } catch {
    // Missing or partial ownership records are not reusable.
  }
  return undefined;
};

export const isRalphManagedServerOwnershipAlive = (
  ownership: RalphManagedServerOwnership,
  probe: (pid: number, signal: 0) => void = process.kill,
): boolean => {
  try {
    probe(ownership.pid, 0);
    return true;
  } catch {
    return false;
  }
};

export const stopRalphManagedServerOwnership = async (
  ownership: RalphManagedServerOwnership,
  registryPath: string,
  dependencies: Pick<RalphManagedServerDependencies, "platform" | "spawn" | "killProcessGroup"> =
    DEFAULT_DEPENDENCIES,
): Promise<void> => {
  try {
    if (dependencies.platform === "win32") {
      await new Promise<void>((resolve) => {
        const killer = dependencies.spawn(
          "taskkill",
          ["/PID", String(ownership.pid), "/T", "/F"],
          { stdio: "ignore", windowsHide: true },
        );
        const settle = (): void => resolve();
        killer.once("error", settle);
        killer.once("exit", settle);
      });
    } else {
      try {
        dependencies.killProcessGroup(ownership.pid, "SIGTERM");
      } catch {
        process.kill(ownership.pid, "SIGTERM");
      }
    }
  } finally {
    await rm(registryPath, { force: true });
  }
};

export const stopRalphManagedServer = async (
  handle: RalphManagedServerHandle,
  dependencies: RalphManagedServerDependencies = DEFAULT_DEPENDENCIES,
): Promise<void> => {
  if (handle.hasExited()) {
    if (handle.registryPath) {
      await rm(handle.registryPath, { force: true });
    }
    return;
  }

  const pid = handle.pid;
  if (pid === undefined) {
    handle.child.kill();
    if (handle.registryPath) {
      await rm(handle.registryPath, { force: true });
    }
    return;
  }

  const waitForExit = async (): Promise<boolean> => {
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const settle = (exited: boolean): void => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timeoutHandle);
        resolve(exited);
      };
      const timeoutHandle = setTimeout(
        () => settle(false),
        dependencies.shutdownTimeoutMs ?? 2_000,
      );

      void handle.exited.then(() => settle(true));
    });
  };

  if (dependencies.platform === "win32") {
    const taskkill = async (force: boolean): Promise<void> => new Promise((resolve) => {
      const killer = dependencies.spawn(
        "taskkill",
        ["/PID", String(pid), "/T", ...(force ? ["/F"] : [])],
        { stdio: "ignore", windowsHide: true },
      );
      let settled = false;
      const settle = (): void => {
        if (settled) {
          return;
        }

        settled = true;
        resolve();
      };

      killer.once("error", () => {
        handle.child.kill();
        settle();
      });
      killer.once("exit", settle);
    });

    await taskkill(false);
    if (!(await waitForExit())) {
      await taskkill(true);
      await waitForExit();
    }
    if (handle.registryPath) {
      await rm(handle.registryPath, { force: true });
    }
    return;
  }

  try {
    dependencies.killProcessGroup(pid, "SIGTERM");
  } catch {
    handle.child.kill();
  }

  if (!(await waitForExit())) {
    try {
      dependencies.killProcessGroup(pid, "SIGKILL");
    } catch {
      handle.child.kill("SIGKILL");
    }
    await waitForExit();
  }
  if (handle.registryPath) {
    await rm(handle.registryPath, { force: true });
  }
};
