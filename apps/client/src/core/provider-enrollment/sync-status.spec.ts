import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  doctorProviderSync,
  getProviderSyncOwnershipPath,
  getProviderSyncStatusPath,
  loadProviderSyncStatus,
  reconcileProviderSync,
} from "./sync-coordinator.js";
import { getProviderSyncDaemonDiagnosticPath } from "./sync-daemon.js";

const roots: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const createWorkspace = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "machdoch-sync-status-"));
  roots.push(root);
  const workspaceRoot = join(root, "workspace");
  const userConfigRoot = join(root, "user-config");
  await Promise.all([
    mkdir(workspaceRoot),
    mkdir(join(userConfigRoot, "provider-enrollment"), { recursive: true }),
  ]);
  vi.stubEnv("MACHDOCH_USER_CONFIG_DIR", userConfigRoot);
  vi.stubEnv("CODEX_HOME", join(root, "codex-home"));
  await Promise.all([
    writeFile(
      join(userConfigRoot, "user-config.json"),
      JSON.stringify({
        agentCliPaths: { "codex-cli": process.execPath },
        providerEnrollment: {
          schemaVersion: 1,
          enabled: true,
          persistentSync: {
            enabled: true,
            watch: false,
            daemonAtLogin: false,
          },
          providers: {
            "codex-cli": { enabled: true },
            "claude-cli": { enabled: false },
            "copilot-cli": { enabled: false },
          },
        },
      }),
    ),
    writeFile(
      join(userConfigRoot, "mcp.json"),
      JSON.stringify({
        schemaVersion: 1,
        servers: [
          {
            id: "example",
            enabled: true,
            transport: {
              type: "stdio",
              command: process.execPath,
              args: ["example-server.js"],
            },
          },
        ],
      }),
    ),
  ]);
  return workspaceRoot;
};

it("persists a failed sync and clears it after a successful refresh", async () => {
  const workspaceRoot = await createWorkspace();
  const synced = await reconcileProviderSync(workspaceRoot);
  const ownershipPath = getProviderSyncOwnershipPath();
  const ownership = await readFile(ownershipPath, "utf8");
  await writeFile(ownershipPath, "{broken");

  await expect(reconcileProviderSync(workspaceRoot)).rejects.toThrow();
  const failed = await loadProviderSyncStatus(workspaceRoot);
  expect(failed).toMatchObject({
    enabled: true,
    lastReconciledAt: synced.lastReconciledAt,
    lastAttemptedAt: expect.any(String),
    error: expect.any(String),
    targets: [],
  });
  expect(Date.parse(failed.lastAttemptedAt!)).toBeGreaterThanOrEqual(
    Date.parse(synced.lastReconciledAt!),
  );
  await writeFile(
    getProviderSyncDaemonDiagnosticPath(),
    JSON.stringify({
      schemaVersion: 2,
      pid: process.pid,
      runStartedAt: failed.lastAttemptedAt,
      runCompletedAt: failed.lastAttemptedAt,
      outcome: "error",
      workspaceResults: [
        {
          workspaceRoot,
          outcome: "error",
          error: failed.error,
        },
      ],
    }),
  );
  await writeFile(ownershipPath, ownership);
  await expect(doctorProviderSync(workspaceRoot)).resolves.toMatchObject({
    healthy: false,
  });

  const recovered = await reconcileProviderSync(workspaceRoot);
  expect(recovered.error).toBeUndefined();
  expect(
    recovered.targets.every((target) => target.state === "filesystem-current"),
  ).toBe(true);
  expect((await loadProviderSyncStatus(workspaceRoot)).error).toBeUndefined();
  await expect(doctorProviderSync(workspaceRoot)).resolves.toMatchObject({
    healthy: true,
  });
});

it("reports failure even when no earlier sync completed", async () => {
  const workspaceRoot = await createWorkspace();
  await writeFile(getProviderSyncOwnershipPath(), "{broken");

  await expect(reconcileProviderSync(workspaceRoot)).rejects.toThrow();
  await expect(loadProviderSyncStatus(workspaceRoot)).resolves.toMatchObject({
    enabled: true,
    lastAttemptedAt: expect.any(String),
    error: expect.any(String),
    targets: [],
  });
});

it("does not report an enabled workspace as healthy before its first sync", async () => {
  const workspaceRoot = await createWorkspace();
  await expect(doctorProviderSync(workspaceRoot)).resolves.toMatchObject({
    healthy: false,
  });
});

it("includes the sync error when persisting failure status also fails", async () => {
  const workspaceRoot = await createWorkspace();
  await writeFile(getProviderSyncOwnershipPath(), "{broken");
  await mkdir(getProviderSyncStatusPath(workspaceRoot));

  await expect(reconcileProviderSync(workspaceRoot)).rejects.toMatchObject({
    name: "AggregateError",
    errors: [expect.any(Error), expect.any(Error)],
    message: expect.stringContaining("Could not save sync failure"),
  });
});

it.each(["workspace", "global"] as const)(
  "shows a %s daemon failure that occurred before reconciliation",
  async (scope) => {
    const workspaceRoot = await createWorkspace();
    await reconcileProviderSync(workspaceRoot);
    const runStartedAt = new Date().toISOString();
    const error = "Timed out waiting for the sync lock.";
    await writeFile(
      getProviderSyncDaemonDiagnosticPath(),
      JSON.stringify({
        schemaVersion: 2,
        pid: process.pid,
        runStartedAt,
        runCompletedAt: runStartedAt,
        outcome: "error",
        workspaceResults:
          scope === "workspace"
            ? [{ workspaceRoot, outcome: "error", error }]
            : [],
        ...(scope === "global" ? { error } : {}),
      }),
    );

    await expect(loadProviderSyncStatus(workspaceRoot)).resolves.toMatchObject({
      lastAttemptedAt: runStartedAt,
      error,
      targets: [],
    });
    await expect(doctorProviderSync(workspaceRoot)).resolves.toMatchObject({
      healthy: false,
    });
  },
);

it("does not show another workspace's daemon failure", async () => {
  const workspaceRoot = await createWorkspace();
  await reconcileProviderSync(workspaceRoot);
  const runStartedAt = new Date().toISOString();
  await writeFile(
    getProviderSyncDaemonDiagnosticPath(),
    JSON.stringify({
      schemaVersion: 2,
      pid: process.pid,
      runStartedAt,
      runCompletedAt: runStartedAt,
      outcome: "error",
      workspaceResults: [
        {
          workspaceRoot: join(workspaceRoot, "other"),
          outcome: "error",
          error: "Other workspace failed.",
        },
      ],
    }),
  );

  const status = await loadProviderSyncStatus(workspaceRoot);
  expect(status.error).toBeUndefined();
  expect(
    status.targets.every((target) => target.state === "filesystem-current"),
  ).toBe(true);
});

it("keeps a successful refresh that completed after a daemon failure began", async () => {
  const workspaceRoot = await createWorkspace();
  const synced = await reconcileProviderSync(workspaceRoot);
  const completedAt = Date.parse(synced.lastReconciledAt!);
  await writeFile(
    getProviderSyncStatusPath(workspaceRoot),
    JSON.stringify({
      ...synced,
      lastAttemptedAt: new Date(completedAt - 2_000).toISOString(),
    }),
  );
  await writeFile(
    getProviderSyncDaemonDiagnosticPath(),
    JSON.stringify({
      schemaVersion: 2,
      pid: process.pid,
      runStartedAt: new Date(completedAt - 1_000).toISOString(),
      runCompletedAt: new Date(completedAt + 1_000).toISOString(),
      outcome: "error",
      workspaceResults: [
        { workspaceRoot, outcome: "error", error: "Sync lock was busy." },
      ],
    }),
  );

  expect((await loadProviderSyncStatus(workspaceRoot)).error).toBeUndefined();
});

it("reports an unreadable status file and replaces it on refresh", async () => {
  const workspaceRoot = await createWorkspace();
  await writeFile(getProviderSyncStatusPath(workspaceRoot), "{broken");

  await expect(loadProviderSyncStatus(workspaceRoot)).rejects.toThrow(
    "Could not read MCP sync status",
  );
  await reconcileProviderSync(workspaceRoot);
  await expect(loadProviderSyncStatus(workspaceRoot)).resolves.toMatchObject({
    enabled: true,
    targets: expect.arrayContaining([
      expect.objectContaining({ state: "filesystem-current" }),
    ]),
  });
});
