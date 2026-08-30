import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLI_CONFIG_SETTING_DEFINITIONS,
  clearConfigSetting,
  loadCliConfigEntries,
  saveConfigSetting,
} from "./cli-config-commands.ts";
import { writeFleetConnectionConfig } from "../../core/fleet-connection.ts";

const rootsToClean: string[] = [];
const originalEnvironment = new Map<string, string | undefined>();
const ISOLATED_ENV_KEYS = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GOOGLE_API_KEY",
  "LANGDOCK_API_KEY",
  "QUIVERAI_API_KEY",
  "RECRAFT_API_KEY",
  "PERPLEXITY_API_KEY",
  "TAVILY_API_KEY",
  "SERPER_API_KEY",
  "MACHDOCH_MODE",
  "MACHDOCH_MODEL",
  "MACHDOCH_REASONING",
  "MACHDOCH_REASONING_MODE",
  "MACHDOCH_CONTEXT_WINDOW",
  "MACHDOCH_OFFLINE",
  "MACHDOCH_WEB_SEARCH_PROVIDER",
  "MACHDOCH_EXECUTOR_TURNS",
  "MACHDOCH_AUTOPILOT_ITERATIONS",
  "MACHDOCH_INFINITE",
  "MACHDOCH_CODEX_CLI_PATH",
  "MACHDOCH_CLAUDE_CLI_PATH",
  "MACHDOCH_COPILOT_CLI_PATH",
  "MACHDOCH_USER_CONFIG_DIR",
] as const;

const isolateEnvironment = (): void => {
  for (const key of ISOLATED_ENV_KEYS) {
    originalEnvironment.set(key, process.env[key]);
    delete process.env[key];
  }
};

const createWorkspace = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "machdoch-cli-config-"));
  rootsToClean.push(root);
  process.env.MACHDOCH_USER_CONFIG_DIR = join(root, ".user-config");
  return root;
};

afterEach(async () => {
  for (const [key, value] of originalEnvironment) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  originalEnvironment.clear();
  await Promise.all(
    rootsToClean
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("CLI configuration catalog", () => {
  it("lists concrete, unique settings and exposes terminal-suitable UI settings", () => {
    const names = CLI_CONFIG_SETTING_DEFINITIONS.map((entry) => entry.setting);

    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain("review-model");
    expect(names).toContain("workspace.context-window");
    expect(names).toContain("workspace.reasoning-mode");
    expect(names).toContain("workspace.github-customizations");
    expect(names).toContain("desktop.quick-voice-shortcut");
    expect(names).toContain("fleet.enabled");
    expect(names).toEqual(
      expect.arrayContaining([
        "workspace-run.startup-delay-ms",
        "workspace-run.health-check-interval-ms",
        "workspace-run.health-check-timeout-ms",
        "workspace-run.health-check-failure-threshold",
        "workspace-run.sequential-readiness-timeout-ms",
      ]),
    );
    expect(names).not.toContain("desktop.autostart-enabled");
  });

  it("uses the canonical Fleet connection document for fleet.enabled", async () => {
    isolateEnvironment();
    const workspaceRoot = await createWorkspace();

    await expect(
      saveConfigSetting(workspaceRoot, "fleet.enabled", "off"),
    ).resolves.toMatchObject({ value: false });
    await expect(
      saveConfigSetting(workspaceRoot, "fleet.enabled", "on"),
    ).rejects.toThrow("Enroll this CLI");

    await writeFleetConnectionConfig({
      schemaVersion: 1,
      enabled: true,
      managerUrl: "https://fleet.example.test",
      managerId: `manager_${Buffer.alloc(18, 1).toString("base64url")}`,
      instanceId: `instance_${Buffer.alloc(18, 2).toString("base64url")}`,
      displayName: "Build host",
      instanceSecret: `mch_instance_${Buffer.alloc(32, 3).toString("base64url")}`,
    });

    await saveConfigSetting(workspaceRoot, "fleet.enabled", "off");
    expect(
      (await loadCliConfigEntries(workspaceRoot)).find(
        (entry) => entry.setting === "fleet.enabled",
      ),
    ).toMatchObject({ value: false, source: "saved" });
    await saveConfigSetting(workspaceRoot, "fleet.enabled", "on");
    await clearConfigSetting(workspaceRoot, "fleet.enabled");

    const stored = JSON.parse(
      await readFile(
        join(workspaceRoot, ".user-config", "fleet-connection.json"),
        "utf8",
      ),
    ) as { enabled?: boolean };
    expect(stored.enabled).toBe(false);
  });

  it("persists, reports, validates, and resets Workspace Run timeouts", async () => {
    isolateEnvironment();
    const workspaceRoot = await createWorkspace();

    await saveConfigSetting(
      workspaceRoot,
      "workspace-run.startup-delay-ms",
      "5000",
    );
    await saveConfigSetting(
      workspaceRoot,
      "workspace-run.health-check-interval-ms",
      "7000",
    );
    await saveConfigSetting(
      workspaceRoot,
      "workspace-run.health-check-timeout-ms",
      "6500",
    );
    await saveConfigSetting(
      workspaceRoot,
      "workspace-run.health-check-failure-threshold",
      "4",
    );
    await saveConfigSetting(
      workspaceRoot,
      "workspace-run.sequential-readiness-timeout-ms",
      "160000",
    );

    await expect(
      saveConfigSetting(
        workspaceRoot,
        "workspace-run.health-check-timeout-ms",
        "7001",
      ),
    ).rejects.toThrow("at most 7000");

    const entries = await loadCliConfigEntries(workspaceRoot);
    expect(
      entries.find(
        (entry) => entry.setting === "workspace-run.health-check-timeout-ms",
      ),
    ).toMatchObject({ value: 6500, source: "saved" });
    expect(
      entries.find(
        (entry) =>
          entry.setting === "workspace-run.sequential-readiness-timeout-ms",
      ),
    ).toMatchObject({ value: 160_000, source: "saved" });

    const configPath = join(workspaceRoot, ".user-config", "user-config.json");
    const stored = JSON.parse(await readFile(configPath, "utf8")) as {
      workspaceRun?: Record<string, unknown>;
    };
    expect(stored.workspaceRun).toMatchObject({
      startupDelayMs: 5000,
      healthCheckIntervalMs: 7000,
      healthCheckTimeoutMs: 6500,
      healthCheckFailureThreshold: 4,
      sequentialReadinessTimeoutMs: 160_000,
    });

    await clearConfigSetting(
      workspaceRoot,
      "workspace-run.health-check-timeout-ms",
    );
    const reset = JSON.parse(await readFile(configPath, "utf8")) as {
      workspaceRun?: Record<string, unknown>;
    };
    expect(reset.workspaceRun).not.toHaveProperty("healthCheckTimeoutMs");
  });

  it("persists review-model and workspace compatibility settings and redacts keys", async () => {
    isolateEnvironment();
    const workspaceRoot = await createWorkspace();
    const apiKey = "sk-real-cli-config-key-123456789";

    await saveConfigSetting(workspaceRoot, "api.openai.key", apiKey);
    await saveConfigSetting(
      workspaceRoot,
      "review-model",
      "openai:gpt-5.5-mini",
    );
    await saveConfigSetting(
      workspaceRoot,
      "workspace.github-customizations",
      "on",
    );

    const entries = await loadCliConfigEntries(workspaceRoot);
    expect(
      entries.find((entry) => entry.setting === "api.openai.key"),
    ).toMatchObject({
      value: "configured",
      source: "user config",
      secret: true,
    });
    expect(JSON.stringify(entries)).not.toContain(apiKey);
    expect(
      entries.find((entry) => entry.setting === "review-model")?.value,
    ).toBe("openai:gpt-5.5-mini");
    expect(
      entries.find(
        (entry) => entry.setting === "workspace.github-customizations",
      )?.value,
    ).toBe(true);
  });

  it("enforces shared numeric bounds and rejects the ineffective autostart setting", async () => {
    isolateEnvironment();
    const workspaceRoot = await createWorkspace();

    await expect(
      saveConfigSetting(workspaceRoot, "agent-limits.executor-turns", "1001"),
    ).rejects.toThrow("between 1 and 1000");
    await expect(
      saveConfigSetting(workspaceRoot, "desktop.autostart-enabled", "on"),
    ).rejects.toThrow("must be changed in the desktop app");
  });

  it("persists and reports the provider context-window setting", async () => {
    isolateEnvironment();
    const workspaceRoot = await createWorkspace();

    process.env.MACHDOCH_CODEX_CLI_PATH = process.execPath;
    await saveConfigSetting(workspaceRoot, "workspace.provider", "codex-cli");
    await saveConfigSetting(workspaceRoot, "workspace.model", "gpt-5.5");
    await saveConfigSetting(
      workspaceRoot,
      "workspace.context-window",
      "400000",
    );

    const entries = await loadCliConfigEntries(workspaceRoot);
    expect(
      entries.find((entry) => entry.setting === "workspace.context-window"),
    ).toMatchObject({ value: 400_000, source: "saved" });

    await clearConfigSetting(workspaceRoot, "workspace.context-window");
    const stored = JSON.parse(
      await readFile(join(workspaceRoot, ".machdoch", "config.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(stored).not.toHaveProperty("contextWindow");
  });

  it("persists and reports OpenAI GPT-5.6 pro mode", async () => {
    isolateEnvironment();
    const workspaceRoot = await createWorkspace();

    process.env.OPENAI_API_KEY = "sk-real-openai-key-123456";
    await saveConfigSetting(workspaceRoot, "workspace.provider", "openai");
    await saveConfigSetting(workspaceRoot, "workspace.model", "gpt-5.6-luna");
    await saveConfigSetting(workspaceRoot, "workspace.reasoning", "high");
    await saveConfigSetting(workspaceRoot, "workspace.reasoning-mode", "pro");

    const entries = await loadCliConfigEntries(workspaceRoot);
    expect(
      entries.find((entry) => entry.setting === "workspace.reasoning-mode"),
    ).toMatchObject({ value: "pro", source: "saved" });

    await clearConfigSetting(workspaceRoot, "workspace.reasoning-mode");
    const stored = JSON.parse(
      await readFile(join(workspaceRoot, ".machdoch", "config.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(stored).not.toHaveProperty("reasoningMode");
  });

  it("unsets nested user and workspace values without retaining empty sections", async () => {
    isolateEnvironment();
    const workspaceRoot = await createWorkspace();

    await saveConfigSetting(
      workspaceRoot,
      "api.openai.key",
      "sk-real-key-to-clear-123456",
    );
    await saveConfigSetting(workspaceRoot, "workspace.mode", "ask");
    await clearConfigSetting(workspaceRoot, "api.openai.key");
    await clearConfigSetting(workspaceRoot, "workspace.mode");

    const userConfig = JSON.parse(
      await readFile(
        join(workspaceRoot, ".user-config", "user-config.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    const workspaceConfig = JSON.parse(
      await readFile(join(workspaceRoot, ".machdoch", "config.json"), "utf8"),
    ) as Record<string, unknown>;

    expect(userConfig).not.toHaveProperty("apiKeys");
    expect(workspaceConfig).not.toHaveProperty("defaultMode");
  });

  it("reports environment-only secrets without exposing them", async () => {
    isolateEnvironment();
    const workspaceRoot = await createWorkspace();
    process.env.OPENAI_API_KEY = "sk-real-environment-key-123456";

    const entries = await loadCliConfigEntries(workspaceRoot);
    expect(
      entries.find((entry) => entry.setting === "api.openai.key"),
    ).toMatchObject({
      value: "configured",
      source: "environment",
    });
    expect(JSON.stringify(entries)).not.toContain(process.env.OPENAI_API_KEY);
  });

  it("reports an environment value when it overrides a saved secret", async () => {
    isolateEnvironment();
    const workspaceRoot = await createWorkspace();
    const savedKey = "sk-saved-key-123456789";
    const environmentKey = "sk-environment-key-987654321";

    await saveConfigSetting(workspaceRoot, "api.openai.key", savedKey);
    process.env.OPENAI_API_KEY = environmentKey;

    const entries = await loadCliConfigEntries(workspaceRoot);
    expect(
      entries.find((entry) => entry.setting === "api.openai.key"),
    ).toMatchObject({ value: "configured", source: "environment" });
    expect(JSON.stringify(entries)).not.toContain(savedKey);
    expect(JSON.stringify(entries)).not.toContain(environmentKey);
  });
});
