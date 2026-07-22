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
import { DEFAULT_PROVIDER_ENROLLMENT_CONFIG } from "./config.js";
import { cleanupProviderNativeState } from "./provider-native-cleanup.js";
import {
  getProviderCoverageLedgerPath,
  getProviderSyncStatusPath,
  getProviderSyncWorkspaceRegistryPath,
  loadRegisteredProviderSyncWorkspaces,
  reconcileProviderSync,
  registerProviderSyncWorkspace,
  uninstallProviderSyncTargets,
} from "./sync-coordinator.js";

const roots: string[] = [];

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

  it("reconciles user and workspace instruction targets and uninstalls only owned output", async () => {
    const root = await createRoot();
    const workspaceRoot = join(root, "workspace");
    const userConfigRoot = join(root, "user-config");
    const codexHome = join(root, "codex-home");
    await Promise.all([
      mkdir(join(workspaceRoot, ".machdoch"), { recursive: true }),
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
        join(userConfigRoot, "instructions.md"),
        "Keep user policy.\n",
        "utf8",
      ),
      writeFile(
        join(workspaceRoot, ".machdoch", "instructions.md"),
        "Keep workspace policy.\n",
        "utf8",
      ),
    ]);

    const status = await reconcileProviderSync(workspaceRoot);
    expect(status.targets).toHaveLength(2);
    expect(
      status.targets.every(
        (target) => target.state === "awaiting-provider-refresh",
      ),
    ).toBe(true);

    const [userInstructions, workspaceInstructions, coverageText] =
      await Promise.all([
        readFile(join(codexHome, "AGENTS.md"), "utf8"),
        readFile(join(workspaceRoot, "AGENTS.md"), "utf8"),
        readFile(getProviderCoverageLedgerPath(workspaceRoot), "utf8"),
      ]);
    expect(userInstructions).toContain("Keep user policy.");
    expect(userInstructions).not.toContain("Keep workspace policy.");
    expect(workspaceInstructions).toContain("Keep workspace policy.");
    expect(workspaceInstructions).not.toContain("Keep user policy.");
    expect(JSON.parse(coverageText)).toMatchObject({
      entries: [
        { entityKind: "instruction", provider: "codex-cli", covered: true },
        { entityKind: "instruction", provider: "codex-cli", covered: true },
      ],
    });

    expect(await uninstallProviderSyncTargets()).toEqual([]);
    await expect(stat(join(codexHome, "AGENTS.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(stat(join(workspaceRoot, "AGENTS.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("removes provider instruction projections when canonical instructions are deleted", async () => {
    const root = await createRoot();
    const workspaceRoot = join(root, "workspace");
    const userConfigRoot = join(root, "user-config");
    const codexHome = join(root, "codex-home");
    await Promise.all([
      mkdir(join(workspaceRoot, ".machdoch"), { recursive: true }),
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
        join(userConfigRoot, "instructions.md"),
        "User policy.\n",
        "utf8",
      ),
      writeFile(
        join(workspaceRoot, ".machdoch", "instructions.md"),
        "Workspace policy.\n",
        "utf8",
      ),
    ]);
    await reconcileProviderSync(workspaceRoot);

    await Promise.all([
      rm(join(userConfigRoot, "instructions.md")),
      rm(join(workspaceRoot, ".machdoch", "instructions.md")),
    ]);
    await reconcileProviderSync(workspaceRoot);

    await expect(stat(join(codexHome, "AGENTS.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(stat(join(workspaceRoot, "AGENTS.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("removes stale projections when a provider is disabled in configuration", async () => {
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
    const createConfig = (enabled: boolean): string =>
      `${JSON.stringify(
        {
          agentCliPaths: { "codex-cli": process.execPath },
          providerEnrollment: {
            enabled: true,
            persistentSync: {
              enabled: true,
              watch: false,
              daemonAtLogin: false,
            },
            providers: {
              "codex-cli": { enabled },
              "claude-cli": { enabled: false },
              "copilot-cli": { enabled: false },
            },
          },
        },
        null,
        2,
      )}\n`;
    await Promise.all([
      writeFile(
        join(userConfigRoot, "user-config.json"),
        createConfig(true),
        "utf8",
      ),
      writeFile(
        join(userConfigRoot, "instructions.md"),
        "User policy.\n",
        "utf8",
      ),
    ]);
    await reconcileProviderSync(workspaceRoot);
    await writeFile(
      join(userConfigRoot, "user-config.json"),
      createConfig(false),
      "utf8",
    );

    await reconcileProviderSync(workspaceRoot);

    await expect(stat(join(codexHome, "AGENTS.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
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

  it("backs up and removes provider-native instructions and MCP entries before enablement", async () => {
    const root = await createRoot();
    const workspaceRoot = join(root, "workspace");
    const codexHome = join(root, "codex-home");
    const claudeHome = join(root, "claude-home");
    const copilotHome = join(root, "copilot-home");
    const userHome = join(root, "home");
    await Promise.all([
      mkdir(join(workspaceRoot, ".machdoch"), { recursive: true }),
      mkdir(join(workspaceRoot, ".claude", "rules"), { recursive: true }),
      mkdir(join(workspaceRoot, ".github", "instructions"), {
        recursive: true,
      }),
      mkdir(join(workspaceRoot, ".codex"), { recursive: true }),
      mkdir(join(workspaceRoot, "docs"), { recursive: true }),
      mkdir(codexHome, { recursive: true }),
      mkdir(join(claudeHome, "rules"), { recursive: true }),
      mkdir(join(copilotHome, "instructions"), { recursive: true }),
      mkdir(userHome, { recursive: true }),
    ]);
    vi.stubEnv("HOME", userHome);
    vi.stubEnv("USERPROFILE", userHome);
    vi.stubEnv("CODEX_HOME", codexHome);
    vi.stubEnv("CLAUDE_CONFIG_DIR", claudeHome);
    vi.stubEnv("COPILOT_HOME", copilotHome);
    const files = [
      join(codexHome, "AGENTS.md"),
      join(claudeHome, "CLAUDE.md"),
      join(claudeHome, "rules", "testing.md"),
      join(copilotHome, "copilot-instructions.md"),
      join(copilotHome, "instructions", "testing.instructions.md"),
      join(workspaceRoot, "AGENTS.md"),
      join(workspaceRoot, "CLAUDE.md"),
      join(workspaceRoot, "GEMINI.md"),
      join(workspaceRoot, "README.md"),
      join(workspaceRoot, ".claude", "rules", "testing.md"),
      join(workspaceRoot, ".github", "instructions", "testing.instructions.md"),
    ];
    await Promise.all(
      files.map((path) => writeFile(path, "Provider policy.\n", "utf8")),
    );
    await writeFile(
      join(workspaceRoot, ".machdoch", "instructions.md"),
      "Canonical Machdoch policy.\n",
      "utf8",
    );
    await Promise.all([
      writeFile(
        join(codexHome, "config.toml"),
        'model = "gpt-5.5"\nproject_doc_fallback_filenames = ["README.md"]\n\n[mcp_servers.native]\ncommand = "native"\n',
        "utf8",
      ),
      writeFile(
        join(workspaceRoot, "docs", "README.md"),
        "Keep documentation.\n",
        "utf8",
      ),
      writeFile(
        join(workspaceRoot, ".codex", "config.toml"),
        'model_verbosity = "low"\n\n[mcp_servers.workspace]\ncommand = "native"\n',
        "utf8",
      ),
      writeFile(
        join(userHome, ".claude.json"),
        `${JSON.stringify({ theme: "dark", mcpServers: { native: { command: "native" } } })}\n`,
        "utf8",
      ),
      writeFile(
        join(copilotHome, "mcp-config.json"),
        `${JSON.stringify({ note: "keep", mcpServers: { native: { command: "native" } } })}\n`,
        "utf8",
      ),
      writeFile(
        join(workspaceRoot, ".mcp.json"),
        `${JSON.stringify({ mcpServers: { native: { command: "native" } } })}\n`,
        "utf8",
      ),
    ]);

    const result = await cleanupProviderNativeState(workspaceRoot);

    expect(result.removedInstructionFiles).toHaveLength(files.length);
    expect(result.backupFiles.length).toBeGreaterThanOrEqual(files.length + 5);
    await Promise.all(
      files.map((path) =>
        expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" }),
      ),
    );
    await expect(
      readFile(join(workspaceRoot, ".machdoch", "instructions.md"), "utf8"),
    ).resolves.toContain("Canonical Machdoch policy");
    await expect(
      readFile(join(workspaceRoot, "docs", "README.md"), "utf8"),
    ).resolves.toContain("Keep documentation");
    await expect(
      readFile(join(codexHome, "config.toml"), "utf8"),
    ).resolves.toBe(
      'model = "gpt-5.5"\nproject_doc_fallback_filenames = ["README.md"]\n',
    );
    await expect(
      readFile(join(workspaceRoot, ".codex", "config.toml"), "utf8"),
    ).resolves.toBe('model_verbosity = "low"\n');
    await expect(
      readFile(join(userHome, ".claude.json"), "utf8"),
    ).resolves.toContain('"theme": "dark"');
    await expect(
      readFile(join(copilotHome, "mcp-config.json"), "utf8"),
    ).resolves.toContain('"note": "keep"');
    await expect(stat(join(workspaceRoot, ".mcp.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
