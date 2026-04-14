import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getUserConfigPath,
  getUserProviderAvailability,
  hasConfiguredValue,
  loadProcessEnv,
  loadUserApiKeys,
  saveUserApiKey,
} from "./env.ts";

const workspacesToClean: string[] = [];
const originalEnvironment = new Map<string, string | undefined>();
const ISOLATED_ENV_KEYS = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GOOGLE_API_KEY",
  "OPENAI_COMPATIBLE_BASE_URL",
  "MACHDOCH_MODE",
  "MACHDOCH_MODEL",
  "MACHDOCH_OFFLINE",
  "MACHDOCH_PROFILE",
  "MACHDOCH_USER_CONFIG_DIR",
] as const;

const createWorkspace = async (): Promise<string> => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "machdoch-env-"));
  workspacesToClean.push(workspaceRoot);
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
    expect(hasConfiguredValue("sk-real-value")).toBe(true);
  });
});

describe("loadProcessEnv", () => {
  it("returns runtime overrides from process env without mixing in provider keys", () => {
    isolateEnvironment();
    process.env.OPENAI_API_KEY = "sk-live";
    process.env.MACHDOCH_MODEL = "local-model";
    process.env.MACHDOCH_MODE = "auto";

    const env = loadProcessEnv();

    expect(env.MACHDOCH_MODEL).toBe("local-model");
    expect(env.MACHDOCH_MODE).toBe("auto");
    expect(env).not.toHaveProperty("OPENAI_API_KEY");
  });
});

describe("user config API key helpers", () => {
  it("persists provider keys in the user-scoped config file", async () => {
    isolateEnvironment();
    const configDirectory = await createWorkspace();
    process.env.MACHDOCH_USER_CONFIG_DIR = configDirectory;

    const savedPath = await saveUserApiKey("openai", "sk-live");
    const apiKeys = await loadUserApiKeys();
    const availability = await getUserProviderAvailability();

    expect(savedPath).toBe(join(configDirectory, "user-config.json"));
    expect(getUserConfigPath()).toBe(join(configDirectory, "user-config.json"));
    expect(apiKeys.openai).toBe("sk-live");
    expect(availability).toEqual([
      { provider: "openai", configured: true },
      { provider: "anthropic", configured: false },
      { provider: "google", configured: false },
    ]);
  });
});
