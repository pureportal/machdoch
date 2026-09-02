import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PROVIDER_ENROLLMENT_CONFIG } from "./config.js";
import {
  doctorProviderSync,
  getProviderSyncOwnershipPath,
  getProviderSyncStatusPath,
  getProviderSyncWorkspaceRegistryPath,
  loadRegisteredProviderSyncWorkspaces,
  reconcileProviderSync,
  registerProviderSyncWorkspace,
} from "./sync-coordinator.js";
import { getProviderSyncDaemonDiagnosticPath } from "./sync-daemon.js";

const roots: string[] = [];
const execFileAsync = promisify(execFile);

const createRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "machdoch-provider-sync-"));
  roots.push(root);
  return root;
};

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("provider sync coordinator", () => {
  it("keeps persistent provider sync opt-in by default", () => {
    expect(DEFAULT_PROVIDER_ENROLLMENT_CONFIG.persistentSync.enabled).toBe(
      false,
    );
  });

  it("withholds an unauthorized Copilot OAuth proxy until authorization is available", async () => {
    const root = await createRoot();
    const workspaceRoot = join(root, "workspace");
    const userConfigRoot = join(root, "user-config");
    const copilotHome = join(root, "copilot-home");
    const copilotUserPath = join(copilotHome, "mcp-config.json");
    const userMcpPath = join(userConfigRoot, "mcp.json");
    const oauthServer = {
      id: "linear",
      enabled: true,
      transport: {
        type: "streamable-http",
        url: "https://example.test/mcp",
      },
      auth: {
        type: "oauth",
        redirectUrl: "http://127.0.0.1:43110/oauth/callback",
      },
    };
    await Promise.all([
      mkdir(workspaceRoot, { recursive: true }),
      mkdir(userConfigRoot, { recursive: true }),
      mkdir(copilotHome, { recursive: true }),
    ]);
    vi.stubEnv("MACHDOCH_USER_CONFIG_DIR", userConfigRoot);
    vi.stubEnv("COPILOT_HOME", copilotHome);
    await Promise.all([
      writeFile(
        join(userConfigRoot, "user-config.json"),
        `${JSON.stringify({
          agentCliPaths: {
            "copilot-cli": process.execPath,
          },
          providerEnrollment: {
            schemaVersion: 1,
            enabled: true,
            persistentSync: {
              enabled: true,
              watch: false,
              daemonAtLogin: false,
            },
            providers: {
              "codex-cli": { enabled: false },
              "claude-cli": { enabled: false },
              "copilot-cli": { enabled: true },
            },
          },
        })}\n`,
        "utf8",
      ),
      writeFile(
        userMcpPath,
        `${JSON.stringify({
          schemaVersion: 1,
          servers: [oauthServer],
        })}\n`,
        "utf8",
      ),
    ]);

    const unauthorizedStatus = await reconcileProviderSync(workspaceRoot);

    expect(unauthorizedStatus.targets).toContainEqual(
      expect.objectContaining({
        provider: "copilot-cli",
        scope: "user",
        state: "degraded",
        warnings: [
          expect.stringContaining(
            "machdoch mcp oauth-authorize linear --scope user",
          ),
        ],
      }),
    );
    await expect(stat(copilotUserPath)).rejects.toMatchObject({
      code: "ENOENT",
    });

    await writeFile(
      userMcpPath,
      `${JSON.stringify({
        schemaVersion: 1,
        servers: [
          {
            ...oauthServer,
            auth: {
              ...oauthServer.auth,
              accessToken: "authorized-token",
            },
          },
        ],
      })}\n`,
      "utf8",
    );

    const authorizedStatus = await reconcileProviderSync(workspaceRoot);
    const copilotConfig = JSON.parse(
      await readFile(copilotUserPath, "utf8"),
    ) as {
      mcpServers: Record<string, unknown>;
    };

    expect(authorizedStatus.targets).toContainEqual(
      expect.objectContaining({
        provider: "copilot-cli",
        scope: "user",
        state: "awaiting-provider-refresh",
      }),
    );
    expect(Object.keys(copilotConfig.mcpServers)).toEqual([
      expect.stringMatching(/^machdoch-line-/u),
    ]);
  });

  it("attributes daemon reconciliation failures to the affected workspace", async () => {
    const root = await createRoot();
    const workspaceRoot = join(root, "workspace");
    const otherWorkspaceRoot = join(root, "other-workspace");
    const userConfigRoot = join(root, "user-config");
    await Promise.all([
      mkdir(workspaceRoot, { recursive: true }),
      mkdir(otherWorkspaceRoot, { recursive: true }),
      mkdir(userConfigRoot, { recursive: true }),
    ]);
    vi.stubEnv("MACHDOCH_USER_CONFIG_DIR", userConfigRoot);
    await writeFile(
      join(userConfigRoot, "user-config.json"),
      `${JSON.stringify({
        providerEnrollment: {
          schemaVersion: 1,
          enabled: true,
          persistentSync: {
            enabled: true,
            watch: false,
            daemonAtLogin: false,
          },
          providers: {
            "codex-cli": { enabled: false },
            "claude-cli": { enabled: false },
            "copilot-cli": { enabled: false },
          },
        },
      })}\n`,
      "utf8",
    );
    await reconcileProviderSync(workspaceRoot);
    const runStartedAt = new Date().toISOString();
    const createDiagnostic = (failedWorkspaceRoot: string) => ({
      schemaVersion: 2,
      pid: process.pid,
      runStartedAt,
      runCompletedAt: new Date().toISOString(),
      outcome: "error",
      workspaceResults: [
        {
          workspaceRoot: failedWorkspaceRoot,
          outcome: "error",
          error: "reconciliation failed",
        },
      ],
    });

    await writeFile(
      getProviderSyncDaemonDiagnosticPath(),
      `${JSON.stringify(createDiagnostic(otherWorkspaceRoot))}\n`,
      "utf8",
    );
    await expect(doctorProviderSync(workspaceRoot)).resolves.toMatchObject({
      healthy: true,
    });

    await writeFile(
      getProviderSyncDaemonDiagnosticPath(),
      `${JSON.stringify(
        createDiagnostic(
          process.platform === "win32"
            ? workspaceRoot.toLocaleUpperCase("en-US")
            : workspaceRoot,
        ),
      )}\n`,
      "utf8",
    );
    await expect(doctorProviderSync(workspaceRoot)).resolves.toMatchObject({
      healthy: false,
    });
  });

  it("reconciles every supported CLI provider without changing unmanaged entries", async () => {
    const root = await createRoot();
    const workspaceRoot = join(root, "workspace");
    const userConfigRoot = join(root, "user-config");
    const providerHome = join(root, "home");
    const codexHome = join(root, "codex-home");
    const copilotHome = join(root, "copilot-home");
    const codexUserPath = join(codexHome, "config.toml");
    const codexWorkspacePath = join(workspaceRoot, ".codex", "config.toml");
    const claudeUserPath = join(providerHome, ".claude.json");
    const claudeWorkspacePath = join(workspaceRoot, ".mcp.json");
    const copilotUserPath = join(copilotHome, "mcp-config.json");
    const copilotWorkspacePath = join(workspaceRoot, ".github", "mcp.json");
    await Promise.all([
      mkdir(join(workspaceRoot, ".machdoch", "mcp"), { recursive: true }),
      mkdir(join(workspaceRoot, ".codex"), { recursive: true }),
      mkdir(join(workspaceRoot, ".github"), { recursive: true }),
      mkdir(userConfigRoot, { recursive: true }),
      mkdir(providerHome, { recursive: true }),
      mkdir(codexHome, { recursive: true }),
      mkdir(copilotHome, { recursive: true }),
    ]);
    vi.stubEnv("MACHDOCH_USER_CONFIG_DIR", userConfigRoot);
    vi.stubEnv("HOME", providerHome);
    vi.stubEnv("USERPROFILE", providerHome);
    vi.stubEnv("CODEX_HOME", codexHome);
    vi.stubEnv("COPILOT_HOME", copilotHome);
    await Promise.all([
      writeFile(
        join(userConfigRoot, "user-config.json"),
        `${JSON.stringify({
          agentCliPaths: {
            "codex-cli": process.execPath,
            "claude-cli": process.execPath,
            "copilot-cli": process.execPath,
          },
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
              "claude-cli": { enabled: true },
              "copilot-cli": { enabled: true },
            },
          },
        })}\n`,
        "utf8",
      ),
      writeFile(
        join(userConfigRoot, "mcp.json"),
        `${JSON.stringify({
          schemaVersion: 1,
          servers: [
            {
              id: "user-server",
              enabled: true,
              transport: {
                type: "stdio",
                command: process.execPath,
              },
            },
          ],
        })}\n`,
        "utf8",
      ),
      writeFile(
        join(workspaceRoot, ".machdoch", "mcp", "mcp.json"),
        `${JSON.stringify({
          schemaVersion: 1,
          servers: [
            {
              id: "workspace-server",
              enabled: true,
              transport: {
                type: "stdio",
                command: process.execPath,
              },
            },
          ],
        })}\n`,
        "utf8",
      ),
      writeFile(
        codexUserPath,
        'model = "gpt-5"\n\n[mcp_servers.custom]\ncommand = "custom"\n',
        "utf8",
      ),
      writeFile(
        codexWorkspacePath,
        'approval_policy = "never"\n\n[mcp_servers.custom]\ncommand = "custom"\n',
        "utf8",
      ),
      ...[
        claudeUserPath,
        claudeWorkspacePath,
        copilotUserPath,
        copilotWorkspacePath,
      ].map((path) =>
        writeFile(
          path,
          `${JSON.stringify({
            note: "keep",
            mcpServers: { custom: { command: "custom" } },
          })}\n`,
          "utf8",
        ),
      ),
    ]);

    const status = await reconcileProviderSync(workspaceRoot);

    expect(status.targets).toHaveLength(6);
    expect(status.targets).toEqual(
      expect.arrayContaining(
        ["codex-cli", "claude-cli", "copilot-cli"].flatMap((provider) =>
          ["user", "workspace"].map((scope) =>
            expect.objectContaining({
              provider,
              scope,
              state: "awaiting-provider-refresh",
            }),
          ),
        ),
      ),
    );
    await expect(readFile(codexUserPath, "utf8")).resolves.toMatch(
      /model = "gpt-5"[\s\S]*\[mcp_servers\.custom\][\s\S]*machdoch-managed:provider-enrollment:start/u,
    );
    await expect(readFile(codexWorkspacePath, "utf8")).resolves.toMatch(
      /approval_policy = "never"[\s\S]*\[mcp_servers\.custom\][\s\S]*machdoch-managed:provider-enrollment:start/u,
    );
    for (const path of [
      claudeUserPath,
      claudeWorkspacePath,
      copilotUserPath,
      copilotWorkspacePath,
    ]) {
      const parsed = JSON.parse(await readFile(path, "utf8")) as {
        note: string;
        mcpServers: Record<string, { command: string }>;
      };
      expect(parsed.note).toBe("keep");
      expect(parsed.mcpServers.custom).toEqual({ command: "custom" });
      expect(
        Object.keys(parsed.mcpServers).filter((key) =>
          key.startsWith("machdoch-"),
        ),
      ).toHaveLength(1);
    }
    const ownership = JSON.parse(
      await readFile(getProviderSyncOwnershipPath(), "utf8"),
    ) as {
      targets: Array<{
        provider: string;
        scope: string;
        managedKeys?: string[];
      }>;
    };
    expect(ownership.targets).toHaveLength(6);
    expect(
      ownership.targets
        .flatMap((target) => target.managedKeys ?? [])
        .every((key) => key.startsWith("machdoch-")),
    ).toBe(true);
  });

  it.runIf(process.platform === "win32")(
    "deduplicates normal and extended-length Windows workspace paths",
    async () => {
      const root = await createRoot();
      const workspaceRoot = join(root, "workspace");
      const userConfigRoot = join(root, "user-config");
      await Promise.all([
        mkdir(workspaceRoot, { recursive: true }),
        mkdir(userConfigRoot, { recursive: true }),
      ]);
      vi.stubEnv("MACHDOCH_USER_CONFIG_DIR", userConfigRoot);
      const extendedWorkspaceRoot = `\\\\?\\${workspaceRoot}`;
      await mkdir(join(userConfigRoot, "provider-enrollment"), {
        recursive: true,
      });
      await writeFile(
        getProviderSyncWorkspaceRegistryPath(),
        `${JSON.stringify(
          {
            schemaVersion: 1,
            workspaceRoots: [extendedWorkspaceRoot, workspaceRoot],
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      await expect(
        loadRegisteredProviderSyncWorkspaces(workspaceRoot),
      ).resolves.toEqual([extendedWorkspaceRoot]);
      expect(getProviderSyncStatusPath(workspaceRoot)).toBe(
        getProviderSyncStatusPath(extendedWorkspaceRoot),
      );
      await registerProviderSyncWorkspace(workspaceRoot);
      const compacted = JSON.parse(
        await readFile(getProviderSyncWorkspaceRegistryPath(), "utf8"),
      ) as { workspaceRoots: string[] };
      expect(compacted.workspaceRoots).toEqual([extendedWorkspaceRoot]);
    },
  );

  it("retains temporarily unavailable registered workspace roots", async () => {
    const root = await createRoot();
    const userConfigRoot = join(root, "user-config");
    const existingWorkspace = join(root, "existing-workspace");
    const unavailableWorkspace = join(root, "offline-workspace");
    await Promise.all([
      mkdir(userConfigRoot, { recursive: true }),
      mkdir(existingWorkspace, { recursive: true }),
    ]);
    vi.stubEnv("MACHDOCH_USER_CONFIG_DIR", userConfigRoot);
    await mkdir(join(userConfigRoot, "provider-enrollment"), {
      recursive: true,
    });
    await writeFile(
      getProviderSyncWorkspaceRegistryPath(),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          workspaceRoots: [unavailableWorkspace],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    await registerProviderSyncWorkspace(existingWorkspace);

    const stored = JSON.parse(
      await readFile(getProviderSyncWorkspaceRegistryPath(), "utf8"),
    ) as { workspaceRoots: string[] };
    expect(stored.workspaceRoots.sort()).toEqual(
      [existingWorkspace, unavailableWorkspace].sort(),
    );
    await expect(loadRegisteredProviderSyncWorkspaces()).resolves.toEqual([
      existingWorkspace,
    ]);
  });

  it.runIf(process.platform === "win32")(
    "reconciles extended-length ownership aliases without duplicating authority",
    async () => {
      const root = await createRoot();
      const workspaceRoot = join(root, "workspace");
      const userConfigRoot = join(root, "user-config");
      const codexHome = join(root, "codex-home");
      await Promise.all([
        mkdir(workspaceRoot, { recursive: true }),
        mkdir(userConfigRoot, { recursive: true }),
        mkdir(codexHome, { recursive: true }),
      ]);
      vi.stubEnv("MACHDOCH_USER_CONFIG_DIR", userConfigRoot);
      vi.stubEnv("CODEX_HOME", codexHome);
      await Promise.all([
        writeFile(
          join(userConfigRoot, "user-config.json"),
          `${JSON.stringify(
            {
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
            },
            null,
            2,
          )}\n`,
          "utf8",
        ),
        writeFile(
          join(userConfigRoot, "mcp.json"),
          `${JSON.stringify({
            schemaVersion: 1,
            servers: [
              {
                id: "user-server",
                enabled: true,
                transport: {
                  type: "stdio",
                  command: process.execPath,
                },
              },
            ],
          })}\n`,
          "utf8",
        ),
        writeFile(join(codexHome, "config.toml"), 'model = "gpt-5"\n', "utf8"),
      ]);
      await reconcileProviderSync(workspaceRoot);
      const targetPath = join(codexHome, "config.toml");
      const extendedTargetPath = `\\\\?\\${targetPath}`;
      const initialOwnership = JSON.parse(
        await readFile(getProviderSyncOwnershipPath(), "utf8"),
      ) as { schemaVersion: 1; targets: Array<Record<string, unknown>> };
      const userTarget = initialOwnership.targets.find(
        (target) => target.provider === "codex-cli" && target.scope === "user",
      );
      expect(userTarget).toBeDefined();
      await writeFile(
        getProviderSyncOwnershipPath(),
        `${JSON.stringify(
          {
            schemaVersion: 1,
            targets: [{ ...userTarget, path: extendedTargetPath }],
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      const status = await reconcileProviderSync(workspaceRoot);

      expect(status.targets).toContainEqual(
        expect.objectContaining({
          provider: "codex-cli",
          scope: "user",
          state: "awaiting-provider-refresh",
        }),
      );
      const reconciledContent = await readFile(targetPath, "utf8");
      expect(reconciledContent).toContain('model = "gpt-5"');
      let reconciledOwnership = JSON.parse(
        await readFile(getProviderSyncOwnershipPath(), "utf8"),
      ) as { schemaVersion: 1; targets: Array<Record<string, unknown>> };
      expect(reconciledOwnership.targets).toHaveLength(1);
      expect(reconciledOwnership.targets[0]?.path).toBe(extendedTargetPath);

      await writeFile(
        getProviderSyncOwnershipPath(),
        `${JSON.stringify(
          {
            schemaVersion: 1,
            targets: [
              reconciledOwnership.targets[0],
              {
                ...reconciledOwnership.targets[0],
                path: targetPath,
              },
            ],
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      await reconcileProviderSync(workspaceRoot);

      reconciledOwnership = JSON.parse(
        await readFile(getProviderSyncOwnershipPath(), "utf8"),
      ) as { schemaVersion: 1; targets: Array<Record<string, unknown>> };
      expect(reconciledOwnership.targets).toHaveLength(1);
      expect(reconciledOwnership.targets[0]?.path).toBe(targetPath);

      vi.stubEnv("CODEX_HOME", `\\\\?\\${codexHome}`);
      await reconcileProviderSync(workspaceRoot);
      reconciledOwnership = JSON.parse(
        await readFile(getProviderSyncOwnershipPath(), "utf8"),
      ) as { schemaVersion: 1; targets: Array<Record<string, unknown>> };
      expect(reconciledOwnership.targets[0]?.path).toBe(targetPath);
      await expect(readFile(targetPath, "utf8")).resolves.toBe(
        reconciledContent,
      );
    },
  );

  it("removes a superseded user target after the provider home changes", async () => {
    const root = await createRoot();
    const workspaceRoot = join(root, "workspace");
    const userConfigRoot = join(root, "user-config");
    const firstCodexHome = join(root, "codex-home-one");
    const secondCodexHome = join(root, "codex-home-two");
    await Promise.all([
      mkdir(workspaceRoot, { recursive: true }),
      mkdir(userConfigRoot, { recursive: true }),
      mkdir(firstCodexHome, { recursive: true }),
      mkdir(secondCodexHome, { recursive: true }),
    ]);
    vi.stubEnv("MACHDOCH_USER_CONFIG_DIR", userConfigRoot);
    vi.stubEnv("CODEX_HOME", firstCodexHome);
    await Promise.all([
      writeFile(
        join(userConfigRoot, "user-config.json"),
        `${JSON.stringify(
          {
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
          },
          null,
          2,
        )}\n`,
        "utf8",
      ),
      writeFile(
        join(userConfigRoot, "mcp.json"),
        `${JSON.stringify({
          schemaVersion: 1,
          servers: [
            {
              id: "user-server",
              enabled: true,
              transport: {
                type: "stdio",
                command: process.execPath,
              },
            },
          ],
        })}\n`,
        "utf8",
      ),
    ]);
    await reconcileProviderSync(workspaceRoot);
    const firstTargetPath = join(firstCodexHome, "config.toml");
    await expect(stat(firstTargetPath)).resolves.toBeDefined();

    vi.stubEnv("CODEX_HOME", secondCodexHome);
    await reconcileProviderSync(workspaceRoot);

    const secondTargetPath = join(secondCodexHome, "config.toml");
    await expect(stat(firstTargetPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(secondTargetPath, "utf8")).resolves.toContain(
      "[mcp_servers.",
    );
    const ownership = JSON.parse(
      await readFile(getProviderSyncOwnershipPath(), "utf8"),
    ) as {
      targets: Array<{ path: string; provider: string; scope: string }>;
    };
    expect(
      ownership.targets.filter(
        (target) => target.provider === "codex-cli" && target.scope === "user",
      ),
    ).toEqual([expect.objectContaining({ path: secondTargetPath })]);
  });

  it("fails clearly when disabled synchronization cannot remove an owned target", async () => {
    const root = await createRoot();
    const workspaceRoot = join(root, "workspace");
    const userConfigRoot = join(root, "user-config");
    const stateDirectory = join(userConfigRoot, "provider-enrollment");
    const targetPath = join(root, "mcp-config.json");
    await Promise.all([
      mkdir(workspaceRoot, { recursive: true }),
      mkdir(userConfigRoot, { recursive: true }),
      mkdir(stateDirectory, { recursive: true }),
    ]);
    vi.stubEnv("MACHDOCH_USER_CONFIG_DIR", userConfigRoot);
    await Promise.all([
      writeFile(
        join(userConfigRoot, "user-config.json"),
        `${JSON.stringify({
          providerEnrollment: {
            schemaVersion: 1,
            enabled: true,
            persistentSync: {
              enabled: false,
              watch: false,
              daemonAtLogin: false,
            },
          },
        })}\n`,
        "utf8",
      ),
      writeFile(targetPath, '{"mcpServers":\n', "utf8"),
      writeFile(
        getProviderSyncOwnershipPath(),
        `${JSON.stringify({
          schemaVersion: 1,
          targets: [
            {
              path: targetPath,
              provider: "copilot-cli",
              scope: "user",
              format: "json",
              managedDigest: "a".repeat(64),
              installedFileDigest: "b".repeat(64),
              createdFile: false,
              managedKeys: ["managed"],
              installedAt: new Date().toISOString(),
            },
          ],
        })}\n`,
        "utf8",
      ),
    ]);

    await expect(reconcileProviderSync(workspaceRoot)).rejects.toThrow(
      "Failed to remove",
    );
    await expect(readFile(targetPath, "utf8")).resolves.toBe(
      '{"mcpServers":\n',
    );
  });

  it("removes an empty managed MCP config after the last canonical server is deleted", async () => {
    const root = await createRoot();
    const workspaceRoot = join(root, "workspace");
    const userConfigRoot = join(root, "user-config");
    const codexHome = join(root, "codex-home");
    const mcpDirectory = join(workspaceRoot, ".machdoch", "mcp");
    await Promise.all([
      mkdir(mcpDirectory, { recursive: true }),
      mkdir(userConfigRoot, { recursive: true }),
      mkdir(codexHome, { recursive: true }),
    ]);
    vi.stubEnv("MACHDOCH_USER_CONFIG_DIR", userConfigRoot);
    vi.stubEnv("CODEX_HOME", codexHome);
    await Promise.all([
      writeFile(
        join(userConfigRoot, "user-config.json"),
        `${JSON.stringify(
          {
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
          },
          null,
          2,
        )}\n`,
        "utf8",
      ),
      writeFile(
        join(mcpDirectory, "mcp.json"),
        `${JSON.stringify(
          {
            schemaVersion: 1,
            servers: [
              {
                id: "workspace-server",
                enabled: true,
                transport: {
                  type: "stdio",
                  command: process.execPath,
                  args: ["server.js"],
                },
              },
            ],
          },
          null,
          2,
        )}\n`,
        "utf8",
      ),
    ]);
    await reconcileProviderSync(workspaceRoot);
    const projectedPath = join(workspaceRoot, ".codex", "config.toml");
    await expect(stat(projectedPath)).resolves.toBeDefined();

    await rm(join(mcpDirectory, "mcp.json"));
    await reconcileProviderSync(workspaceRoot);

    await expect(stat(projectedPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes a stale generated target when a replacement projection fails", async () => {
    const root = await createRoot();
    const workspaceRoot = join(root, "workspace");
    const userConfigRoot = join(root, "user-config");
    const codexHome = join(root, "codex-home");
    await Promise.all([
      mkdir(workspaceRoot, { recursive: true }),
      mkdir(userConfigRoot, { recursive: true }),
      mkdir(codexHome, { recursive: true }),
    ]);
    vi.stubEnv("MACHDOCH_USER_CONFIG_DIR", userConfigRoot);
    vi.stubEnv("CODEX_HOME", codexHome);
    vi.stubEnv("MISSING_SYNC_MCP_TOKEN", "");
    await writeFile(
      join(userConfigRoot, "user-config.json"),
      `${JSON.stringify({
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
      })}\n`,
      "utf8",
    );
    const mcpPath = join(userConfigRoot, "mcp.json");
    await writeFile(
      mcpPath,
      `${JSON.stringify({
        schemaVersion: 1,
        servers: [
          {
            id: "user-server",
            enabled: true,
            transport: { type: "stdio", command: process.execPath },
          },
        ],
      })}\n`,
      "utf8",
    );
    const projectedPath = join(codexHome, "config.toml");

    await reconcileProviderSync(workspaceRoot);
    await expect(stat(projectedPath)).resolves.toBeDefined();

    await writeFile(
      mcpPath,
      `${JSON.stringify({
        schemaVersion: 1,
        servers: [
          {
            id: "user-server",
            enabled: true,
            transport: {
              type: "stdio",
              command: process.execPath,
              args: ["${env:MISSING_SYNC_MCP_TOKEN}"],
            },
          },
        ],
      })}\n`,
      "utf8",
    );

    const status = await reconcileProviderSync(workspaceRoot);

    expect(status.targets).toContainEqual(
      expect.objectContaining({
        provider: "codex-cli",
        scope: "user",
        state: "degraded",
        error: expect.stringContaining("MISSING_SYNC_MCP_TOKEN"),
      }),
    );
    await expect(stat(projectedPath)).rejects.toMatchObject({ code: "ENOENT" });
    const ownership = JSON.parse(
      await readFile(getProviderSyncOwnershipPath(), "utf8"),
    ) as { targets: Array<{ provider: string; scope: string }> };
    expect(
      ownership.targets.some(
        (target) => target.provider === "codex-cli" && target.scope === "user",
      ),
    ).toBe(false);
  });

  it("writes exclusions to Git's actual linked-worktree exclude path", async () => {
    try {
      await execFileAsync("git", ["--version"], { windowsHide: true });
    } catch {
      return;
    }
    const root = await createRoot();
    const primaryRoot = join(root, "primary");
    const workspaceRoot = join(root, "linked");
    const userConfigRoot = join(root, "user-config");
    const codexHome = join(root, "codex-home");
    await Promise.all([
      mkdir(primaryRoot, { recursive: true }),
      mkdir(userConfigRoot, { recursive: true }),
      mkdir(codexHome, { recursive: true }),
    ]);
    await execFileAsync("git", ["init"], {
      cwd: primaryRoot,
      windowsHide: true,
    });
    await execFileAsync(
      "git",
      [
        "-c",
        "user.name=Machdoch Tests",
        "-c",
        "user.email=tests@machdoch.invalid",
        "commit",
        "--allow-empty",
        "-m",
        "initial",
      ],
      { cwd: primaryRoot, windowsHide: true },
    );
    await execFileAsync(
      "git",
      ["worktree", "add", "-b", "linked-test", workspaceRoot],
      { cwd: primaryRoot, windowsHide: true },
    );
    await mkdir(join(workspaceRoot, ".machdoch", "mcp"), {
      recursive: true,
    });
    vi.stubEnv("MACHDOCH_USER_CONFIG_DIR", userConfigRoot);
    vi.stubEnv("CODEX_HOME", codexHome);
    await Promise.all([
      writeFile(
        join(userConfigRoot, "user-config.json"),
        `${JSON.stringify(
          {
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
          },
          null,
          2,
        )}\n`,
        "utf8",
      ),
      writeFile(
        join(workspaceRoot, ".machdoch", "mcp", "mcp.json"),
        `${JSON.stringify(
          {
            schemaVersion: 1,
            servers: [
              {
                id: "workspace-server",
                enabled: true,
                transport: {
                  type: "stdio",
                  command: process.execPath,
                  args: ["server.js"],
                },
              },
            ],
          },
          null,
          2,
        )}\n`,
        "utf8",
      ),
    ]);

    const status = await reconcileProviderSync(workspaceRoot);
    expect(status.targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: "codex-cli",
          scope: "workspace",
          state: "awaiting-provider-refresh",
        }),
      ]),
    );
    const { stdout } = await execFileAsync(
      "git",
      ["--no-optional-locks", "rev-parse", "--git-path", "info/exclude"],
      { cwd: workspaceRoot, encoding: "utf8", windowsHide: true },
    );
    const excludePath = resolve(workspaceRoot, stdout.trim());
    await expect(readFile(excludePath, "utf8")).resolves.toContain(
      "/.codex/config.toml",
    );
  });
});
