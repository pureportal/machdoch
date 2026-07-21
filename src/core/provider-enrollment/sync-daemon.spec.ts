import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getProviderSyncDaemonDiagnosticPath,
  isProviderSyncUserWatchPath,
  isProviderSyncWorkspaceWatchPath,
  runProviderSyncDaemon,
  type ProviderSyncDaemonDiagnostic,
} from "./sync-daemon.ts";

const roots: string[] = [];

const wait = async (delayMs: number): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
};

const loadDiagnostic = async (): Promise<ProviderSyncDaemonDiagnostic | undefined> => {
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
    expect(isProviderSyncWorkspaceWatchPath("AGENTS.md")).toBe(true);
    expect(isProviderSyncWorkspaceWatchPath(".env")).toBe(true);
    expect(isProviderSyncWorkspaceWatchPath(".machdoch/instructions/team.instructions.md")).toBe(true);
    expect(isProviderSyncWorkspaceWatchPath(".machdoch/mcp/mcp.json")).toBe(true);
    expect(isProviderSyncWorkspaceWatchPath(".github/instructions/review.instructions.md")).toBe(true);
    expect(isProviderSyncWorkspaceWatchPath("src/index.ts")).toBe(false);
    expect(isProviderSyncWorkspaceWatchPath(".git/index")).toBe(false);
    expect(isProviderSyncWorkspaceWatchPath("node_modules/package/index.js")).toBe(false);

    expect(isProviderSyncUserWatchPath("user-config.json")).toBe(true);
    expect(isProviderSyncUserWatchPath("instructions/team.instructions.md")).toBe(true);
    expect(isProviderSyncUserWatchPath("provider-enrollment/sync-status.json")).toBe(false);
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
      `${JSON.stringify({
        providerEnrollment: {
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
      }, null, 2)}\n`,
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
      await expect(runProviderSyncDaemon(workspaceRoot)).rejects.toThrow(
        new RegExp(`already running with PID ${process.pid}`, "u"),
      );
      await writeFile(join(workspaceRoot, "src", "noise.txt"), "noise\n", "utf8");
      await wait(300);
      await expect(loadDiagnostic()).resolves.toMatchObject({
        runCompletedAt: initial.runCompletedAt,
      });

      await writeFile(
        join(workspaceRoot, ".machdoch", "instructions.md"),
        "Updated provider input.\n",
        "utf8",
      );
      await waitForDiagnostic(
        (diagnostic) => diagnostic.runCompletedAt !== initial.runCompletedAt,
      );
    } finally {
      controller.abort();
      await daemon;
    }

    const daemonPath = join(userConfigRoot, "provider-enrollment", "daemon.json");
    await expect(stat(daemonPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
