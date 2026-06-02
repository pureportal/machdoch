import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRuntimeConfig, saveWorkspaceDefaultModel } from "./config.ts";

const workspacesToClean: string[] = [];
const originalEnvironment = new Map<string, string | undefined>();
const ISOLATED_ENV_KEYS = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GOOGLE_API_KEY",
  "MACHDOCH_MODE",
  "MACHDOCH_MODEL",
  "MACHDOCH_OFFLINE",
  "MACHDOCH_PROFILE",
  "MACHDOCH_USER_CONFIG_DIR",
  "MACHDOCH_EXECUTOR_TURNS",
  "MACHDOCH_AUTOPILOT_ITERATIONS",
  "MACHDOCH_INFINITE",
] as const;

const createWorkspace = async (): Promise<string> => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "machdoch-config-"));
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

describe("loadRuntimeConfig", () => {
  it("falls back to defaults when no workspace config or environment values are present", async () => {
    isolateEnvironment();
    const workspaceRoot = await createWorkspace();

    const config = await loadRuntimeConfig(workspaceRoot);

    expect(config.activeProfile).toBeUndefined();
    expect(config.workspaceConfigPath).toBeUndefined();
    expect(config.userConfigPath).toBe(
      join(workspaceRoot, ".user-config", "user-config.json"),
    );
    expect(config.availableProfiles).toEqual([]);
    expect(config.mode).toBe("machdoch");
    expect(config.provider).toBe("unconfigured");
    expect(config.model).toBe("gpt-5.5");
    expect(config.offline).toBe(false);
    expect(config.agentLimits).toEqual({
      executorTurns: 64,
      autopilotExecutorIterations: 16,
    });
    expect(config.compatibility.discoverGithubCustomizations).toBe(false);
  });

  it("loads runtime config from .env and .machdoch/config.json", async () => {
    isolateEnvironment();
    const workspaceRoot = await createWorkspace();

    await mkdir(join(workspaceRoot, ".machdoch"), { recursive: true });
    await writeFile(
      join(workspaceRoot, ".env"),
      [
        "OPENAI_API_KEY=sk-real-openai-key-123456",
        "MACHDOCH_MODEL=env-model",
      ].join("\n"),
    );
    await writeFile(
      join(workspaceRoot, ".machdoch", "config.json"),
      JSON.stringify(
        {
          defaultProfile: "ask-review",
          defaultMode: "ask",
          provider: "openai",
          model: "config-model",
          offline: true,
          profiles: {
            "ask-review": {
              description: "Review changes conservatively",
              mode: "ask",
            },
            local: {
              description: "Prefer a local backend",
              provider: "google",
              model: "gemini-2.5-flash",
              offline: false,
            },
          },
        },
        null,
        2,
      ),
    );

    const config = await loadRuntimeConfig(workspaceRoot, "machdoch");

    expect(config.activeProfile).toBe("ask-review");
    expect(config.availableProfiles).toEqual([
      {
        name: "ask-review",
        description: "Review changes conservatively",
      },
      {
        name: "local",
        description: "Prefer a local backend",
      },
    ]);
    expect(config.mode).toBe("machdoch");
    expect(config.provider).toBe("openai");
    expect(config.model).toBe("config-model");
    expect(config.offline).toBe(true);
    expect(config.workspaceConfigPath).toBe(
      join(workspaceRoot, ".machdoch", "config.json"),
    );
  });

  it("supports explicit profile overrides and profile-specific provider/model settings", async () => {
    isolateEnvironment();
    const workspaceRoot = await createWorkspace();

    await mkdir(join(workspaceRoot, ".machdoch"), { recursive: true });
    await writeFile(
      join(workspaceRoot, ".machdoch", "config.json"),
      JSON.stringify(
        {
          defaultMode: "ask",
          provider: "openai",
          model: "base-model",
          profiles: {
            local: {
              description: "Local backend profile",
              mode: "machdoch",
              provider: "google",
              model: "gemini-2.5-flash",
              offline: true,
            },
          },
        },
        null,
        2,
      ),
    );

    const config = await loadRuntimeConfig(workspaceRoot, undefined, "local");

    expect(config.activeProfile).toBe("local");
    expect(config.mode).toBe("machdoch");
    expect(config.provider).toBe("google");
    expect(config.model).toBe("gemini-2.5-flash");
    expect(config.offline).toBe(true);
  });

  it("uses environment values for mode, model, offline, and provider discovery when config does not set them", async () => {
    isolateEnvironment();
    const workspaceRoot = await createWorkspace();

    process.env.OPENAI_API_KEY = "sk-real-openai-key-123456";
    process.env.MACHDOCH_MODE = "machdoch";
    process.env.MACHDOCH_MODEL = "env-model";
    process.env.MACHDOCH_OFFLINE = "true";

    const config = await loadRuntimeConfig(workspaceRoot);

    expect(config.mode).toBe("machdoch");
    expect(config.provider).toBe("openai");
    expect(config.model).toBe("env-model");
    expect(config.offline).toBe(true);
    expect(
      config.providerAvailability.find((entry) => entry.provider === "openai")
        ?.configured,
    ).toBe(true);
  });

  it("uses provider-specific default models when no model is configured", async () => {
    isolateEnvironment();
    const workspaceRoot = await createWorkspace();

    process.env.GOOGLE_API_KEY = "google-real-key-123456";

    const config = await loadRuntimeConfig(workspaceRoot);

    expect(config.provider).toBe("google");
    expect(config.model).toBe("gemini-3.5-flash");
  });

  it("loads agent loop limits from user config, workspace config, environment, and overrides", async () => {
    isolateEnvironment();
    const workspaceRoot = await createWorkspace();

    await mkdir(join(workspaceRoot, ".user-config"), { recursive: true });
    await writeFile(
      join(workspaceRoot, ".user-config", "user-config.json"),
      JSON.stringify(
        {
          agentLimits: {
            executorTurns: 96,
            autopilotExecutorIterations: 18,
          },
        },
        null,
        2,
      ),
    );

    expect((await loadRuntimeConfig(workspaceRoot)).agentLimits).toEqual({
      executorTurns: 96,
      autopilotExecutorIterations: 18,
    });

    await mkdir(join(workspaceRoot, ".machdoch"), { recursive: true });
    await writeFile(
      join(workspaceRoot, ".machdoch", "config.json"),
      JSON.stringify(
        {
          agentLimits: {
            executorTurns: 128,
            autopilotExecutorIterations: 24,
          },
        },
        null,
        2,
      ),
    );

    expect((await loadRuntimeConfig(workspaceRoot)).agentLimits).toEqual({
      executorTurns: 128,
      autopilotExecutorIterations: 24,
    });

    process.env.MACHDOCH_INFINITE = "true";
    expect((await loadRuntimeConfig(workspaceRoot)).agentLimits).toEqual({
      executorTurns: null,
      autopilotExecutorIterations: null,
    });

    expect(
      (
        await loadRuntimeConfig(
          workspaceRoot,
          undefined,
          undefined,
          undefined,
          undefined,
          {
            executorTurns: 256,
            autopilotExecutorIterations: 32,
          },
        )
      ).agentLimits,
    ).toEqual({
      executorTurns: 256,
      autopilotExecutorIterations: 32,
    });
  });

  it("throws a helpful error for unknown profile names", async () => {
    isolateEnvironment();
    const workspaceRoot = await createWorkspace();

    await mkdir(join(workspaceRoot, ".machdoch"), { recursive: true });
    await writeFile(
      join(workspaceRoot, ".machdoch", "config.json"),
      JSON.stringify(
        {
          profiles: {
            existing: {
              description: "Existing profile",
            },
          },
        },
        null,
        2,
      ),
    );

    await expect(
      loadRuntimeConfig(workspaceRoot, undefined, "missing"),
    ).rejects.toThrow("Profile `missing` was not found");
  });

  it("persists the workspace default model into .machdoch/config.json", async () => {
    isolateEnvironment();
    const workspaceRoot = await createWorkspace();

    const configPath = await saveWorkspaceDefaultModel(
      workspaceRoot,
      "gpt-5.4",
    );
    const config = await loadRuntimeConfig(workspaceRoot);

    expect(configPath).toBe(join(workspaceRoot, ".machdoch", "config.json"));
    expect(config.model).toBe("gpt-5.4");
  });
});
