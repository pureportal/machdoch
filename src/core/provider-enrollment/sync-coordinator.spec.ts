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
  getProviderSyncStatusPath,
  getProviderSyncWorkspaceRegistryPath,
  loadRegisteredProviderSyncWorkspaces,
  reconcileProviderSync,
  registerProviderSyncWorkspace,
} from "./sync-coordinator.js";

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
