import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withCooperativeFileLock } from "../_helpers/with-cooperative-file-lock.helper.js";
import {
  getCurrentProviderSyncDaemonPid,
  getProviderSyncDaemonPid,
  getProviderSyncDaemonRuntimeId,
  getProviderSyncDaemonDiagnosticPath,
  isProviderSyncUserWatchPath,
  isProviderSyncWorkspaceWatchPath,
  requestProviderSyncRefresh,
  runProviderSyncDaemon,
  stopProviderSyncDaemon,
  type ProviderSyncDaemonDiagnostic,
} from "./sync-daemon.ts";

const roots: string[] = [];

const wait = async (delayMs: number): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
};

const loadDiagnostic = async (): Promise<
  ProviderSyncDaemonDiagnostic | undefined
> => {
  try {
    return JSON.parse(
      await readFile(getProviderSyncDaemonDiagnosticPath(), "utf8"),
    ) as ProviderSyncDaemonDiagnostic;
  } catch {
    return undefined;
  }
};

const waitForDiagnostic = async (
  predicate: (diagnostic: ProviderSyncDaemonDiagnostic) => boolean,
): Promise<ProviderSyncDaemonDiagnostic> => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5_000) {
    const diagnostic = await loadDiagnostic();
    if (diagnostic && predicate(diagnostic)) return diagnostic;
    await wait(25);
  }
  throw new Error("Timed out waiting for provider-sync daemon diagnostics.");
};

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("provider sync daemon", () => {
  it("filters workspace and user watch events to synchronization inputs", () => {
    expect(isProviderSyncWorkspaceWatchPath("AGENTS.md")).toBe(false);
    expect(isProviderSyncWorkspaceWatchPath(".env")).toBe(true);
    expect(isProviderSyncWorkspaceWatchPath(".ENV")).toBe(
      process.platform === "win32",
    );
    expect(isProviderSyncWorkspaceWatchPath(".machdoch/mcp/mcp.json")).toBe(
      true,
    );
    expect(
      isProviderSyncWorkspaceWatchPath(
        ".github/instructions/review.instructions.md",
      ),
    ).toBe(false);
    expect(isProviderSyncWorkspaceWatchPath("src/index.ts")).toBe(false);
    expect(isProviderSyncWorkspaceWatchPath(".git/index")).toBe(false);
    expect(
      isProviderSyncWorkspaceWatchPath("node_modules/package/index.js"),
    ).toBe(false);

    expect(isProviderSyncUserWatchPath("user-config.json")).toBe(true);
    expect(isProviderSyncUserWatchPath("mcp.json")).toBe(true);
    expect(
      isProviderSyncUserWatchPath("provider-enrollment/sync-status.json"),
    ).toBe(false);
    expect(isProviderSyncUserWatchPath("scheduler.json")).toBe(false);
  });

  it("does not reconcile in response to unrelated workspace churn", async () => {
    const root = await mkdtemp(join(tmpdir(), "machdoch-daemon-watch-"));
    roots.push(root);
    const workspaceRoot = join(root, "workspace");
    const userConfigRoot = join(root, "user-config");
    await Promise.all([
      mkdir(join(workspaceRoot, ".machdoch"), { recursive: true }),
      mkdir(join(workspaceRoot, "src"), { recursive: true }),
      mkdir(userConfigRoot, { recursive: true }),
    ]);
    vi.stubEnv("MACHDOCH_USER_CONFIG_DIR", userConfigRoot);
    await writeFile(
      join(userConfigRoot, "user-config.json"),
      `${JSON.stringify(
        {
          providerEnrollment: {
            schemaVersion: 1,
            enabled: true,
            persistentSync: {
              enabled: true,
              watch: true,
              daemonAtLogin: false,
              debounceMs: 50,
              fullRescanIntervalMs: 10_000,
            },
            providers: {
              "codex-cli": { enabled: false },
              "claude-cli": { enabled: false },
              "copilot-cli": { enabled: false },
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const controller = new AbortController();
    const daemon = runProviderSyncDaemon(workspaceRoot, {
      signal: controller.signal,
    });

    try {
      const initial = await waitForDiagnostic(
        (diagnostic) => diagnostic.outcome === "success",
      );
      const daemonPath = join(
        userConfigRoot,
        "provider-enrollment",
        "daemon.json",
      );
      await expect(
        readFile(daemonPath, "utf8").then((value) => JSON.parse(value)),
      ).resolves.toMatchObject({
        schemaVersion: 1,
        pid: process.pid,
        runtimeId: getProviderSyncDaemonRuntimeId(),
      });
      await expect(getCurrentProviderSyncDaemonPid()).resolves.toBe(
        process.pid,
      );
      await expect(runProviderSyncDaemon(workspaceRoot)).rejects.toThrow(
        new RegExp(`already running with PID ${process.pid}`, "u"),
      );
      await writeFile(
        join(workspaceRoot, "src", "noise.txt"),
        "noise\n",
        "utf8",
      );
      await wait(300);
      await expect(loadDiagnostic()).resolves.toMatchObject({
        runCompletedAt: initial.runCompletedAt,
      });

      await mkdir(join(workspaceRoot, ".machdoch", "mcp"), {
        recursive: true,
      });
      await writeFile(
        join(workspaceRoot, ".machdoch", "mcp", "mcp.json"),
        "{}\n",
        "utf8",
      );
      await waitForDiagnostic(
        (diagnostic) => diagnostic.runCompletedAt !== initial.runCompletedAt,
      );
    } finally {
      controller.abort();
      await daemon;
    }

    const daemonPath = join(
      userConfigRoot,
      "provider-enrollment",
      "daemon.json",
    );
    await expect(stat(daemonPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("waits for an in-flight reconciliation before shutting down", async () => {
    const root = await mkdtemp(join(tmpdir(), "machdoch-daemon-shutdown-"));
    roots.push(root);
    const workspaceRoot = join(root, "workspace");
    const userConfigRoot = join(root, "user-config");
    await Promise.all([
      mkdir(join(workspaceRoot, ".machdoch"), { recursive: true }),
      mkdir(userConfigRoot, { recursive: true }),
    ]);
    vi.stubEnv("MACHDOCH_USER_CONFIG_DIR", userConfigRoot);
    await writeFile(
      join(userConfigRoot, "user-config.json"),
      `${JSON.stringify(
        {
          providerEnrollment: {
            schemaVersion: 1,
            enabled: true,
            persistentSync: {
              enabled: true,
              watch: true,
              daemonAtLogin: false,
              debounceMs: 50,
              fullRescanIntervalMs: 10_000,
            },
            providers: {
              "codex-cli": { enabled: false },
              "claude-cli": { enabled: false },
              "copilot-cli": { enabled: false },
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const controller = new AbortController();
    const daemon = runProviderSyncDaemon(workspaceRoot, {
      signal: controller.signal,
    });
    let releaseHeldLock: (() => void) | undefined;
    let notifyLockAcquired: (() => void) | undefined;
    const lockAcquired = new Promise<void>((resolveAcquired) => {
      notifyLockAcquired = resolveAcquired;
    });
    let daemonSettled = false;
    void daemon.then(
      () => {
        daemonSettled = true;
      },
      () => {
        daemonSettled = true;
      },
    );

    await waitForDiagnostic((diagnostic) => diagnostic.outcome === "success");
    const heldLock = withCooperativeFileLock(
      join(userConfigRoot, "provider-enrollment", "reconcile.state"),
      async () => {
        notifyLockAcquired?.();
        await new Promise<void>((resolveHeld) => {
          releaseHeldLock = resolveHeld;
        });
      },
    );
    await lockAcquired;

    try {
      await requestProviderSyncRefresh();
      await wait(150);
      controller.abort();
      await wait(100);

      expect(daemonSettled).toBe(false);
    } finally {
      releaseHeldLock?.();
      await heldLock;
      controller.abort();
      await daemon;
      await wait(500);
    }
  });

  it("rejects daemon records outside the current schema", async () => {
    const root = await mkdtemp(join(tmpdir(), "machdoch-daemon-schema-"));
    roots.push(root);
    const userConfigRoot = join(root, "user-config");
    const daemonDirectory = join(userConfigRoot, "provider-enrollment");
    await mkdir(daemonDirectory, { recursive: true });
    vi.stubEnv("MACHDOCH_USER_CONFIG_DIR", userConfigRoot);
    await writeFile(
      join(daemonDirectory, "daemon.json"),
      `${JSON.stringify({
        pid: process.pid,
        workspaceRoot: root,
        startedAt: new Date().toISOString(),
        token: "obsolete-record",
        runtimeId: "0".repeat(64),
      })}\n`,
      "utf8",
    );

    await expect(getProviderSyncDaemonPid()).rejects.toThrow(
      "not a valid provider-sync daemon record",
    );
    await expect(getCurrentProviderSyncDaemonPid()).rejects.toThrow(
      "not a valid provider-sync daemon record",
    );
  });

  it("stops a daemon launched by a different runtime", async () => {
    const root = await mkdtemp(join(tmpdir(), "machdoch-daemon-runtime-"));
    roots.push(root);
    const userConfigRoot = join(root, "user-config");
    const daemonPath = join(
      userConfigRoot,
      "provider-enrollment",
      "daemon.json",
    );
    await mkdir(join(userConfigRoot, "provider-enrollment"), {
      recursive: true,
    });
    vi.stubEnv("MACHDOCH_USER_CONFIG_DIR", userConfigRoot);
    const child = spawn(
      process.execPath,
      ["-e", "setInterval(() => undefined, 1000)"],
      {
        stdio: "ignore",
        windowsHide: true,
      },
    );
    const childPid = child.pid;
    if (!childPid) {
      child.kill();
      throw new Error("Expected the daemon test process to expose a PID.");
    }
    await writeFile(
      daemonPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          pid: childPid,
          workspaceRoot: root,
          startedAt: new Date().toISOString(),
          token: "different-runtime-test",
          runtimeId: "0".repeat(64),
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    try {
      await expect(
        stopProviderSyncDaemon({
          onlyIfRuntimeMismatch: true,
          timeoutMs: 5_000,
        }),
      ).resolves.toBe(true);
      await expect(stat(daemonPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      child.kill();
    }
  });
});
