import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
      await mkdir(
        join(userConfigRoot, "provider-enrollment"),
        { recursive: true },
      );
      await writeFile(
        getProviderSyncWorkspaceRegistryPath(),
        `${JSON.stringify({
          schemaVersion: 1,
          workspaceRoots: [extendedWorkspaceRoot, workspaceRoot],
        }, null, 2)}\n`,
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
        `${JSON.stringify({
          agentCliPaths: { "codex-cli": process.execPath },
          providerEnrollment: {
            enabled: true,
            persistentSync: { enabled: true, watch: false, daemonAtLogin: false },
            providers: {
              "codex-cli": { enabled: true },
              "claude-cli": { enabled: false },
              "copilot-cli": { enabled: false },
            },
          },
        }, null, 2)}\n`,
        "utf8",
      ),
      writeFile(join(userConfigRoot, "instructions.md"), "Keep user policy.\n", "utf8"),
      writeFile(
        join(workspaceRoot, ".machdoch", "instructions.md"),
        "Keep workspace policy.\n",
        "utf8",
      ),
    ]);

    const status = await reconcileProviderSync(workspaceRoot);
    expect(status.targets).toHaveLength(2);
    expect(status.targets.every((target) => target.state === "awaiting-provider-refresh")).toBe(true);

    const [userInstructions, workspaceInstructions, coverageText] = await Promise.all([
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
    await expect(stat(join(codexHome, "AGENTS.md"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(workspaceRoot, "AGENTS.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
