import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PROVIDER_ENROLLMENT_CONFIG } from "../../core/provider-enrollment/config.js";
import {
  inspectManagedTarget,
  installManagedTarget,
  loadOwnershipManifest,
  saveOwnershipManifest,
} from "../../core/provider-enrollment/ownership-merge.js";
import { getProviderSyncOwnershipPath } from "../../core/provider-enrollment/sync-coordinator.js";
import { getProviderSyncDaemonPid } from "../../core/provider-enrollment/sync-daemon.js";
import { parseCliArgs } from "./cli-args.js";
import { printProviderSyncSummary } from "./cli-provider-sync-commands.js";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: vi.fn(),
}));

vi.mock("../../core/provider-enrollment/machdoch-cli-launch.js", () => ({
  resolveMachdochCliLaunch: () => ({
    command: process.execPath,
    args: ["machdoch-cli.cjs"],
    cwd: process.cwd(),
    environment: {},
  }),
}));

vi.mock("../../core/provider-enrollment/platform-autostart.js", () => ({
  installProviderSyncAutostart: vi.fn(),
  isProviderSyncAutostartInstalled: vi.fn().mockResolvedValue(false),
}));

const roots: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("provider sync Refresh", () => {
  it.each([false, true])(
    "refreshes with a stopped daemon and watch=%s after recovering orphaned locks",
    async (watch) => {
      const root = await mkdtemp(join(tmpdir(), "machdoch-sync-refresh-"));
      roots.push(root);
      const workspaceRoot = join(root, "workspace");
      const userConfigRoot = join(root, "user-config");
      const providerHome = join(root, "codex-home");
      await Promise.all(
        [workspaceRoot, userConfigRoot, providerHome].map((path) =>
          mkdir(path),
        ),
      );
      vi.stubEnv("MACHDOCH_USER_CONFIG_DIR", userConfigRoot);
      vi.stubEnv("CODEX_HOME", providerHome);

      const userConfigPath = join(userConfigRoot, "user-config.json");
      const mcpConfigPath = join(userConfigRoot, "mcp.json");
      const targetPath = join(providerHome, "config.toml");
      const userConfigContent = `${JSON.stringify(
        {
          agentCliPaths: { "codex-cli": process.execPath },
          providerEnrollment: {
            ...DEFAULT_PROVIDER_ENROLLMENT_CONFIG,
            persistentSync: {
              enabled: true,
              watch,
              daemonAtLogin: false,
              debounceMs: 875,
              fullRescanIntervalMs: 500_000,
            },
            providers: {
              "codex-cli": { enabled: true },
              "claude-cli": { enabled: false },
              "copilot-cli": { enabled: false },
            },
          },
        },
        null,
        2,
      )}\n`;
      const mcpConfigContent = `${JSON.stringify({
        schemaVersion: 1,
        servers: [
          {
            id: "current-server",
            enabled: true,
            transport: {
              type: "stdio",
              command: process.execPath,
              args: ["current-server.js"],
            },
          },
        ],
      })}\n`;
      const unmanagedContent =
        'model = "custom-model"\n\n[mcp_servers.custom]\ncommand = "custom-server"\n';
      await Promise.all([
        writeFile(userConfigPath, userConfigContent),
        writeFile(mcpConfigPath, mcpConfigContent),
        writeFile(targetPath, unmanagedContent),
      ]);
      const installed = await installManagedTarget({
        path: targetPath,
        provider: "codex-cli",
        scope: "user",
        format: "toml",
        payload: '[mcp_servers.obsolete]\ncommand = "obsolete-server"',
      });
      const stateDirectory = join(userConfigRoot, "provider-enrollment");
      await mkdir(stateDirectory);
      await saveOwnershipManifest(getProviderSyncOwnershipPath(), {
        schemaVersion: 1,
        targets: [installed.record],
      });
      const lockTargets = [
        ...(!watch ? [join(stateDirectory, "workspace-roots.json")] : []),
        join(stateDirectory, "reconcile.state"),
        targetPath,
      ];
      for (const destination of lockTargets) {
        const ownerDirectory = join(
          `${destination}.machdoch.lock`,
          "owner.dead-owner",
        );
        await mkdir(ownerDirectory, { recursive: true });
        const ownerPath = join(ownerDirectory, "owner.json");
        await writeFile(
          ownerPath,
          JSON.stringify({ token: "dead-owner", pid: 2_000_000_000 }),
        );
        const acquiredAt = new Date(Date.now() - 84_681);
        await utimes(ownerPath, acquiredAt, acquiredAt);
      }

      await expect(getProviderSyncDaemonPid()).resolves.toBeUndefined();
      const child = Object.assign(new EventEmitter(), {
        pid: 4322,
        unref: vi.fn(),
      });
      const daemonSpawn = vi.mocked(spawn).mockImplementation(() => {
        queueMicrotask(() => child.emit("spawn"));
        return child as unknown as ReturnType<typeof spawn>;
      });
      daemonSpawn.mockClear();
      const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
      const args = parseCliArgs([
        "provider-sync",
        "refresh",
        "--cwd",
        workspaceRoot,
        "--json",
      ]);

      await printProviderSyncSummary(args);
      await printProviderSyncSummary(args);

      expect(stdout).toHaveBeenCalledTimes(2);
      for (const [output] of stdout.mock.calls) {
        expect(JSON.parse(String(output))).toMatchObject({
          enabled: true,
          targets: expect.arrayContaining([
            {
              provider: "codex-cli",
              scope: "user",
              state: "awaiting-provider-refresh",
              targetPaths: [targetPath],
              updatedAt: expect.any(String),
              warnings: [],
            },
          ]),
        });
      }
      expect(daemonSpawn).toHaveBeenCalledTimes(watch ? 2 : 0);
      if (watch) {
        expect(daemonSpawn).toHaveBeenCalledWith(
          process.execPath,
          [
            "machdoch-cli.cjs",
            "provider-sync",
            "daemon",
            "--cwd",
            workspaceRoot,
          ],
          expect.objectContaining({ detached: true, windowsHide: true }),
        );
      }
      expect(await readFile(userConfigPath, "utf8")).toBe(userConfigContent);
      expect(await readFile(mcpConfigPath, "utf8")).toBe(mcpConfigContent);
      const updatedTarget = await readFile(targetPath, "utf8");
      expect(updatedTarget).toContain(unmanagedContent.trimEnd());
      expect(updatedTarget).toContain("current-server.js");
      expect(updatedTarget).not.toContain("obsolete-server");
      for (const destination of lockTargets) {
        await expect(
          stat(`${destination}.machdoch.lock`),
        ).rejects.toMatchObject({ code: "ENOENT" });
      }
      const ownership = await loadOwnershipManifest(
        getProviderSyncOwnershipPath(),
      );
      expect(ownership.targets).toHaveLength(1);
      await expect(
        inspectManagedTarget(ownership.targets[0]!),
      ).resolves.toEqual({
        exists: true,
        syntaxValid: true,
        managedCurrent: true,
      });
    },
    40_000,
  );
});
