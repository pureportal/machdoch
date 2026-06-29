import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getUserConfigPath,
  getUserProviderAvailability,
  getUserWebSearchProviderAvailability,
  hasConfiguredValue,
  loadProcessEnv,
  loadUserAgentCliPaths,
  loadUserApiKeys,
  loadUserMemorySettings,
  loadUserReviewModelSettings,
  loadUserWebSearchApiKeys,
  loadUserWebSearchSettings,
  loadWorkspaceEnv,
  rememberUserGlobalMemory,
  saveUserAgentCliPath,
  saveUserApiKey,
  saveUserDesktopSettingsPatch,
  saveUserGlobalMemoryEnabled,
  saveUserReviewModelSettings,
  saveUserSpeechToTextActiveProvider,
  saveUserSpeechToTextInputDevice,
  saveUserVoiceActiveProvider,
  saveUserWebSearchActiveProvider,
  saveUserWebSearchApiKey,
} from "./env.ts";

const workspacesToClean: string[] = [];
const originalEnvironment = new Map<string, string | undefined>();
const ISOLATED_ENV_KEYS = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GOOGLE_API_KEY",
  "PERPLEXITY_API_KEY",
  "TAVILY_API_KEY",
  "SERPER_API_KEY",
  "MACHDOCH_MODE",
  "MACHDOCH_MODEL",
  "MACHDOCH_OFFLINE",
  "MACHDOCH_WEB_SEARCH_PROVIDER",
  "MACHDOCH_USER_CONFIG_DIR",
  "MACHDOCH_CODEX_CLI_PATH",
  "MACHDOCH_CLAUDE_CLI_PATH",
  "MACHDOCH_COPILOT_CLI_PATH",
] as const;

const createWorkspace = async (): Promise<string> => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "machdoch-env-"));
  workspacesToClean.push(workspaceRoot);
  process.env.MACHDOCH_USER_CONFIG_DIR = join(workspaceRoot, ".user-config");
  return workspaceRoot;
};

const isolateEnvironment = (): void => {
  for (const key of ISOLATED_ENV_KEYS) {
    if (!originalEnvironment.has(key)) {
      originalEnvironment.set(key, process.env[key]);
    }

    delete process.env[key];
  }
};

const restoreEnvironment = (): void => {
  for (const [key, value] of originalEnvironment) {
    if (value === undefined) {
      delete process.env[key];
      continue;
    }

    process.env[key] = value;
  }

  originalEnvironment.clear();
};

afterEach(async () => {
  restoreEnvironment();

  await Promise.all(
    workspacesToClean
      .splice(0)
      .map((workspaceRoot) =>
        rm(workspaceRoot, { recursive: true, force: true }),
      ),
  );
});

describe("hasConfiguredValue", () => {
  it("treats placeholder values as unconfigured", () => {
    expect(hasConfiguredValue(undefined)).toBe(false);
    expect(hasConfiguredValue("   ")).toBe(false);
    expect(hasConfiguredValue("YOUR_OPENAI_API_KEY_HERE")).toBe(false);
    expect(hasConfiguredValue("CHANGE_ME")).toBe(false);
    expect(hasConfiguredValue("api-key-PLACEHOLDER")).toBe(false);
    expect(hasConfiguredValue("sk-user-config")).toBe(false);
    expect(hasConfiguredValue("pplx-live")).toBe(false);
    expect(hasConfiguredValue("sk-real-value")).toBe(true);
  });
});

describe("loadProcessEnv", () => {
  it("returns runtime overrides from process env without mixing in provider keys", () => {
    isolateEnvironment();
    process.env.OPENAI_API_KEY = "sk-live";
    process.env.MACHDOCH_MODEL = "local-model";
    process.env.MACHDOCH_MODE = "machdoch";

    const env = loadProcessEnv();

    expect(env.MACHDOCH_MODEL).toBe("local-model");
    expect(env.MACHDOCH_MODE).toBe("machdoch");
    expect(env).not.toHaveProperty("OPENAI_API_KEY");
  });
});

describe("loadWorkspaceEnv", () => {
  it("loads workspace .env values and process overrides for runtime config resolution", async () => {
    isolateEnvironment();
    const workspaceRoot = await createWorkspace();
    const userConfigDirectory = join(workspaceRoot, ".user-config");

    await mkdir(userConfigDirectory, { recursive: true });
    await writeFile(
      join(userConfigDirectory, "user-config.json"),
      `${JSON.stringify(
        {
          apiKeys: {
            openai: "sk-test-user-config-123456",
          },
        },
        null,
        2,
      )}\n`,
    );
    await writeFile(
      join(workspaceRoot, ".env"),
      ["OPENAI_API_KEY=sk-workspace", "MACHDOCH_MODEL=workspace-model"].join(
        "\n",
      ),
    );
    process.env.MACHDOCH_MODE = "machdoch";

    const env = await loadWorkspaceEnv(workspaceRoot);

    expect(env.OPENAI_API_KEY).toBe("sk-workspace");
    expect(env.MACHDOCH_MODEL).toBe("workspace-model");
    expect(env.MACHDOCH_MODE).toBe("machdoch");
  });

  it("does not load agent CLI binary paths from workspace .env files", async () => {
    isolateEnvironment();
    const workspaceRoot = await createWorkspace();
    const untrustedBinaryPath = join(workspaceRoot, "untrusted-codex.cmd");
    const trustedBinaryPath = join(workspaceRoot, "trusted-codex.cmd");

    await writeFile(untrustedBinaryPath, "");
    await writeFile(trustedBinaryPath, "");
    await writeFile(
      join(workspaceRoot, ".env"),
      [
        `MACHDOCH_CODEX_CLI_PATH=${untrustedBinaryPath}`,
        "MACHDOCH_MODEL=workspace-model",
      ].join("\n"),
    );

    let env = await loadWorkspaceEnv(workspaceRoot);

    expect(env.MACHDOCH_CODEX_CLI_PATH).toBeUndefined();
    expect(env.MACHDOCH_MODEL).toBe("workspace-model");

    process.env.MACHDOCH_CODEX_CLI_PATH = trustedBinaryPath;
    env = await loadWorkspaceEnv(workspaceRoot);

    expect(env.MACHDOCH_CODEX_CLI_PATH).toBe(trustedBinaryPath);
  });
});

describe("user config API key helpers", () => {
  it("persists provider keys in the user-scoped config file", async () => {
    isolateEnvironment();
    const configDirectory = await createWorkspace();
    process.env.MACHDOCH_USER_CONFIG_DIR = configDirectory;

    const savedPath = await saveUserApiKey(
      "openai",
      "sk-test-openai-key-1234567890",
    );
    const apiKeys = await loadUserApiKeys();
    const availability = await getUserProviderAvailability();

    expect(savedPath).toBe(join(configDirectory, "user-config.json"));
    expect(getUserConfigPath()).toBe(join(configDirectory, "user-config.json"));
    expect(apiKeys.openai).toBe("sk-test-openai-key-1234567890");
    expect(availability).toEqual([
      { provider: "openai", configured: true },
      { provider: "anthropic", configured: false },
      { provider: "google", configured: false },
    ]);
  });

  it("persists agent CLI binary paths in the user-scoped config file", async () => {
    isolateEnvironment();
    const configDirectory = await createWorkspace();
    const binaryPath = join(configDirectory, "codex.cmd");

    process.env.MACHDOCH_USER_CONFIG_DIR = configDirectory;
    await writeFile(binaryPath, "");

    const savedPath = await saveUserAgentCliPath("codex-cli", binaryPath);
    const paths = await loadUserAgentCliPaths();
    const env = await loadWorkspaceEnv(configDirectory);

    expect(savedPath).toBe(join(configDirectory, "user-config.json"));
    expect(paths["codex-cli"]).toBe(binaryPath);
    expect(env.MACHDOCH_CODEX_CLI_PATH).toBe(binaryPath);
  });

  it("persists web-search settings in the user-scoped config file", async () => {
    isolateEnvironment();
    const configDirectory = await createWorkspace();
    process.env.MACHDOCH_USER_CONFIG_DIR = configDirectory;

    await saveUserWebSearchApiKey("perplexity", "pplx-test-key-1234567890");
    await saveUserWebSearchActiveProvider("perplexity");

    const apiKeys = await loadUserWebSearchApiKeys();
    const availability = await getUserWebSearchProviderAvailability();
    const settings = await loadUserWebSearchSettings();

    expect(apiKeys.perplexity).toBe("pplx-test-key-1234567890");
    expect(availability).toEqual([
      { provider: "perplexity", configured: true },
      { provider: "tavily", configured: false },
      { provider: "serper", configured: false },
    ]);
    expect(settings.activeProvider).toBe("perplexity");
    expect(settings.apiKeys.perplexity).toBe("pplx-test-key-1234567890");
  });

  it("persists Serper as a web-search provider", async () => {
    isolateEnvironment();
    const configDirectory = await createWorkspace();
    process.env.MACHDOCH_USER_CONFIG_DIR = configDirectory;

    await saveUserWebSearchApiKey("serper", "serper-test-key-1234567890");
    await saveUserWebSearchActiveProvider("serper");

    const env = await loadWorkspaceEnv(configDirectory);
    const settings = await loadUserWebSearchSettings();

    expect(env.SERPER_API_KEY).toBe("serper-test-key-1234567890");
    expect(settings.activeProvider).toBe("serper");
    expect(settings.providerAvailability).toEqual([
      { provider: "perplexity", configured: false },
      { provider: "tavily", configured: false },
      { provider: "serper", configured: true },
    ]);
  });

  it("persists voice, speech-to-text, and desktop settings", async () => {
    isolateEnvironment();
    const configDirectory = await createWorkspace();
    process.env.MACHDOCH_USER_CONFIG_DIR = configDirectory;

    await saveUserVoiceActiveProvider("google");
    await saveUserSpeechToTextActiveProvider("openai");
    await saveUserSpeechToTextInputDevice("microphone-1");
    await saveUserDesktopSettingsPatch({
      quickVoiceEnabled: false,
      quickVoiceMaxMessages: 80,
    });

    const savedConfigPath = join(configDirectory, "user-config.json");
    const config = JSON.parse(await readFile(savedConfigPath, "utf8"));

    expect(config.voice.activeProvider).toBe("google");
    expect(config.speechToText.activeProvider).toBe("openai");
    expect(config.speechToText.inputDeviceId).toBe("microphone-1");
    expect(config.desktop.quickVoiceEnabled).toBe(false);
    expect(config.desktop.quickVoiceMaxMessages).toBe(80);

    await saveUserSpeechToTextInputDevice(null);

    const updatedConfig = JSON.parse(await readFile(savedConfigPath, "utf8"));
    expect(updatedConfig.speechToText).not.toHaveProperty("inputDeviceId");
  });

  it("persists cross-session global memory settings and deduplicates entries", async () => {
    isolateEnvironment();
    const configDirectory = await createWorkspace();
    process.env.MACHDOCH_USER_CONFIG_DIR = configDirectory;

    await saveUserGlobalMemoryEnabled(true);
    const firstEntry = await rememberUserGlobalMemory(
      "The user prefers compact summaries.",
    );
    const secondEntry = await rememberUserGlobalMemory(
      "The user prefers compact summaries.",
    );
    const settings = await loadUserMemorySettings();

    expect(firstEntry.content).toBe("The user prefers compact summaries.");
    expect(secondEntry.content).toBe("The user prefers compact summaries.");
    expect(settings.globalEnabled).toBe(true);
    expect(settings.entries).toHaveLength(1);
    expect(settings.entries[0]?.content).toBe(
      "The user prefers compact summaries.",
    );
  });

  it("persists review model settings for validator and memory passes", async () => {
    isolateEnvironment();
    const configDirectory = await createWorkspace();
    process.env.MACHDOCH_USER_CONFIG_DIR = configDirectory;

    expect(await loadUserReviewModelSettings()).toEqual({
      mode: "base",
    });

    await saveUserReviewModelSettings({
      mode: "dedicated",
      provider: "openai",
      model: "gpt-5.5-mini",
    });

    expect(await loadUserReviewModelSettings()).toEqual({
      mode: "dedicated",
      provider: "openai",
      model: "gpt-5.5-mini",
    });

    await saveUserReviewModelSettings({
      mode: "dedicated",
      provider: "openai",
      model: "",
    });

    expect(await loadUserReviewModelSettings()).toEqual({
      mode: "base",
    });
  });
});
