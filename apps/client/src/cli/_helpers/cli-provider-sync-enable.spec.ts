import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PROVIDER_ENROLLMENT_CONFIG } from "../../core/provider-enrollment/config.js";
import {
  inspectManagedTarget,
  installManagedTarget,
  loadOwnershipManifest,
  readStableManagedTarget,
  saveOwnershipManifest,
} from "../../core/provider-enrollment/ownership-merge.js";
import { getProviderSyncOwnershipPath } from "../../core/provider-enrollment/sync-coordinator.js";
import { parseCliArgs } from "./cli-args.js";
import { printProviderSyncSummary } from "./cli-provider-sync-commands.js";

vi.mock("../../core/provider-enrollment/sync-daemon.js", () => ({
  getCurrentProviderSyncDaemonPid: vi.fn().mockResolvedValue(undefined),
  getProviderSyncDaemonPid: vi.fn().mockResolvedValue(undefined),
  requestProviderSyncRefresh: vi.fn(),
  runProviderSyncDaemon: vi.fn(),
  stopProviderSyncDaemon: vi.fn().mockResolvedValue(false),
}));

vi.mock("../../core/provider-enrollment/platform-autostart.js", () => ({
  getProviderSyncAutostartPath: vi.fn(),
  installProviderSyncAutostart: vi.fn(),
  isProviderSyncAutostartInstalled: vi.fn().mockResolvedValue(false),
  removeProviderSyncAutostart: vi.fn(),
}));

const roots: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("provider sync enablement", () => {
  it("enables after ownership repair while preserving unrelated settings and files", async () => {
    const root = await mkdtemp(join(tmpdir(), "machdoch-sync-enable-"));
    roots.push(root);
    const workspaceRoot = join(root, "workspace");
    const userConfigRoot = join(root, "user-config");
    const providerHome = join(root, "codex-home");
    await Promise.all(
      [workspaceRoot, userConfigRoot, providerHome].map((path) =>
        mkdir(path, { recursive: true }),
      ),
    );
    vi.stubEnv("MACHDOCH_USER_CONFIG_DIR", userConfigRoot);
    vi.stubEnv("CODEX_HOME", providerHome);

    const userConfigPath = join(userConfigRoot, "user-config.json");
    const mcpConfigPath = join(userConfigRoot, "mcp.json");
    const targetPath = join(providerHome, "config.toml");
    const instructionPath = join(workspaceRoot, "AGENTS.md");
    const userConfig = {
      agentCliPaths: { "codex-cli": process.execPath },
      providerEnrollment: {
        ...DEFAULT_PROVIDER_ENROLLMENT_CONFIG,
        persistentSync: {
          enabled: false,
          watch: false,
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
    };
    const userConfigContent = `${JSON.stringify(userConfig, null, 2)}\n`;
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
    const instructionContent = "Project instructions\n";
    await Promise.all([
      writeFile(userConfigPath, userConfigContent),
      writeFile(mcpConfigPath, mcpConfigContent),
      writeFile(targetPath, unmanagedContent),
      writeFile(instructionPath, instructionContent),
    ]);
    const installed = await installManagedTarget({
      path: targetPath,
      provider: "codex-cli",
      scope: "user",
      format: "toml",
      payload: '[mcp_servers.obsolete]\ncommand = "obsolete-server"',
    });
    const targetBefore = await readFile(targetPath, "utf8");
    const ownershipPath = getProviderSyncOwnershipPath();
    await mkdir(join(userConfigRoot, "provider-enrollment"), {
      recursive: true,
    });
    const ownershipContent = `${JSON.stringify({
      schemaVersion: 1,
      targets: [
        installed.record,
        {
          ...installed.record,
          path: instructionPath,
          scope: "workspace",
          format: "markdown",
          createdFile: true,
        },
      ],
    })}\n`;
    await writeFile(ownershipPath, ownershipContent);
    const args = parseCliArgs([
      "provider-sync",
      "enable",
      "--cwd",
      workspaceRoot,
      "--json",
    ]);
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);

    await expect(printProviderSyncSummary(args)).rejects.toThrow(
      `${ownershipPath} target 1 (${instructionPath}) has format "markdown"`,
    );
    expect(await readFile(userConfigPath, "utf8")).toBe(userConfigContent);
    expect(await readFile(ownershipPath, "utf8")).toBe(ownershipContent);
    expect(await readFile(targetPath, "utf8")).toBe(targetBefore);
    expect(await readFile(instructionPath, "utf8")).toBe(instructionContent);
    expect(stdout).not.toHaveBeenCalled();

    await saveOwnershipManifest(
      ownershipPath,
      { schemaVersion: 1, targets: [installed.record] },
      { expectedTargetSnapshot: await readStableManagedTarget(ownershipPath) },
    );
    expect((await loadOwnershipManifest(ownershipPath)).targets).toEqual([
      installed.record,
    ]);

    await printProviderSyncSummary(args);

    const result = JSON.parse(String(stdout.mock.calls[0]?.[0]));
    expect(result).toMatchObject({
      enabled: true,
      daemonStartPid: null,
      daemon: { running: false },
      targets: [
        {
          provider: "codex-cli",
          scope: "user",
          state: "awaiting-provider-refresh",
        },
        {
          provider: "codex-cli",
          scope: "workspace",
          state: "awaiting-provider-refresh",
        },
      ],
    });
    expect(JSON.parse(await readFile(userConfigPath, "utf8"))).toEqual({
      ...userConfig,
      providerEnrollment: {
        ...userConfig.providerEnrollment,
        persistentSync: {
          ...userConfig.providerEnrollment.persistentSync,
          enabled: true,
        },
      },
    });
    const targetAfter = await readFile(targetPath, "utf8");
    expect(targetAfter).toContain(unmanagedContent.trimEnd());
    expect(targetAfter).toContain("current-server.js");
    expect(targetAfter).not.toContain("obsolete-server");
    expect(await readFile(mcpConfigPath, "utf8")).toBe(mcpConfigContent);
    expect(await readFile(instructionPath, "utf8")).toBe(instructionContent);
    const ownership = await loadOwnershipManifest(ownershipPath);
    expect(ownership.targets).toHaveLength(1);
    expect(ownership.targets[0]).toMatchObject({
      path: targetPath,
      format: "toml",
    });
    await expect(inspectManagedTarget(ownership.targets[0]!)).resolves.toEqual({
      exists: true,
      syntaxValid: true,
      managedCurrent: true,
    });
  });
});
