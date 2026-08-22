import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLI_CONFIG_SETTING_DEFINITIONS,
  clearConfigSetting,
  loadCliConfigEntries,
  saveConfigSetting,
} from "./cli-config-commands.ts";

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
    expect(names).toContain("workspace.github-customizations");
    expect(names).toContain("desktop.quick-voice-shortcut");
    expect(names).not.toContain("desktop.autostart-enabled");
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
