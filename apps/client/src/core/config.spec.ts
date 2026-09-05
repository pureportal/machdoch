import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadWorkspaceConfigFile,
  loadRuntimeConfig,
  saveWorkspaceContextWindow,
  saveWorkspaceDefaultMode,
  saveWorkspaceDefaultModel,
  saveWorkspaceMemoryOverride,
  saveWorkspaceReasoningExecutionMode,
  saveWorkspaceReasoningMode,
  saveWorkspaceRuntimeProvider,
} from "./config.ts";

const workspacesToClean: string[] = [];
const originalEnvironment = new Map<string, string | undefined>();
const ISOLATED_ENV_KEYS = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GOOGLE_API_KEY",
  "MACHDOCH_MODE",
  "MACHDOCH_MODEL",
  "MACHDOCH_REASONING_MODE",
  "MACHDOCH_CONTEXT_WINDOW",
  "MACHDOCH_OFFLINE",
  "MACHDOCH_USER_CONFIG_DIR",
  "MACHDOCH_EXECUTOR_TURNS",
  "MACHDOCH_AUTOPILOT_ITERATIONS",
  "MACHDOCH_INFINITE",
  "MACHDOCH_CODEX_CLI_PATH",
  "MACHDOCH_CLAUDE_CLI_PATH",
  "MACHDOCH_COPILOT_CLI_PATH",
  "APPDATA",
  "LOCALAPPDATA",
  "PATH",
  "PATHEXT",
  "USERPROFILE",
] as const;

const createWorkspace = async (): Promise<string> => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "machdoch-config-"));
  workspacesToClean.push(workspaceRoot);
  process.env.MACHDOCH_USER_CONFIG_DIR = join(workspaceRoot, ".user-config");
  process.env.APPDATA = join(workspaceRoot, "appdata");
  process.env.LOCALAPPDATA = join(workspaceRoot, "localappdata");
  process.env.USERPROFILE = join(workspaceRoot, "home");
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

    expect(config.workspaceConfigPath).toBeUndefined();
    expect(config.userConfigPath).toBe(
      join(workspaceRoot, ".user-config", "user-config.json"),
    );
    expect(config.mode).toBe("machdoch");
    expect(config.provider).toBe("unconfigured");
    expect(config.model).toBe("gpt-5.6-sol");
    expect(config.contextWindow).toBe("default");
    expect(config.reasoningMode).toBe("standard");
    expect(config.offline).toBe(false);
    expect(config.agentLimits).toEqual({
      executorTurns: 64,
      autopilotExecutorIterations: 16,
    });
    expect(config.reviewModel).toEqual({
      mode: "base",
    });
    expect(config.compatibility.discoverGithubCustomizations).toBe(false);
  });

  it("loads runtime config from process env and .machdoch/config.json", async () => {
    isolateEnvironment();
    const workspaceRoot = await createWorkspace();

    await mkdir(join(workspaceRoot, ".machdoch"), { recursive: true });
    process.env.OPENAI_API_KEY = "sk-real-openai-key-123456";
    process.env.MACHDOCH_MODEL = "env-model";
    await writeFile(
      join(workspaceRoot, ".machdoch", "config.json"),
      JSON.stringify(
        {
          defaultMode: "ask",
          provider: "openai",
          model: "config-model",
          offline: true,
        },
        null,
        2,
      ),
    );

    const config = await loadRuntimeConfig(workspaceRoot, "machdoch");

    expect(config.mode).toBe("machdoch");
    expect(config.provider).toBe("openai");
    expect(config.model).toBe("env-model");
    expect(config.offline).toBe(true);
    expect(config.workspaceConfigPath).toBe(
      join(workspaceRoot, ".machdoch", "config.json"),
    );
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
    expect(config.model).toBe("gemini-3.7-flash");
  });

  it("detects Codex CLI from PATH and uses its default model", async () => {
    isolateEnvironment();
    const workspaceRoot = await createWorkspace();
    const binaryName = process.platform === "win32" ? "codex.cmd" : "codex";

    await writeFile(join(workspaceRoot, binaryName), "");
    process.env.PATH = workspaceRoot;
    process.env.PATHEXT = ".CMD;.EXE";

    const config = await loadRuntimeConfig(workspaceRoot);

    expect(config.provider).toBe("codex-cli");
    expect(config.model).toBe("gpt-5.6-sol");
    expect(
      config.providerAvailability.find(
        (entry) => entry.provider === "codex-cli",
      )?.configured,
    ).toBe(true);
  });

  it("detects Claude and Copilot CLI binaries from PATH", async () => {
    isolateEnvironment();
    const workspaceRoot = await createWorkspace();
    const claudeBinaryName =
      process.platform === "win32" ? "claude.cmd" : "claude";
    const copilotBinaryName =
      process.platform === "win32" ? "copilot.cmd" : "copilot";

    await writeFile(join(workspaceRoot, claudeBinaryName), "");
    await writeFile(join(workspaceRoot, copilotBinaryName), "");
    process.env.PATH = workspaceRoot;
    process.env.PATHEXT = ".CMD;.EXE";

    let config = await loadRuntimeConfig(
      workspaceRoot,
      undefined,
      undefined,
      "claude-cli",
    );

    expect(config.provider).toBe("claude-cli");
    expect(config.model).toBe("sonnet");
    expect(
      config.providerAvailability.find(
        (entry) => entry.provider === "claude-cli",
      )?.configured,
    ).toBe(true);

    config = await loadRuntimeConfig(
      workspaceRoot,
      undefined,
      undefined,
      "copilot-cli",
    );

    expect(config.provider).toBe("copilot-cli");
    expect(config.model).toBe("auto");
    expect(
      config.providerAvailability.find(
        (entry) => entry.provider === "copilot-cli",
      )?.configured,
    ).toBe(true);
  });

  it("does not treat GitHub CLI as the Copilot CLI binary", async () => {
    isolateEnvironment();
    const workspaceRoot = await createWorkspace();
    const binaryName = process.platform === "win32" ? "gh.cmd" : "gh";

    await writeFile(join(workspaceRoot, binaryName), "");
    process.env.PATH = workspaceRoot;
    process.env.PATHEXT = ".CMD;.EXE";

    const config = await loadRuntimeConfig(
      workspaceRoot,
      undefined,
      undefined,
      "copilot-cli",
    );

    expect(
      config.providerAvailability.find(
        (entry) => entry.provider === "copilot-cli",
      )?.configured,
    ).toBe(false);
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

  it("loads a dedicated review model from user config", async () => {
    isolateEnvironment();
    const workspaceRoot = await createWorkspace();

    await mkdir(join(workspaceRoot, ".user-config"), { recursive: true });
    await writeFile(
      join(workspaceRoot, ".user-config", "user-config.json"),
      JSON.stringify(
        {
          reviewModel: {
            mode: "dedicated",
            provider: "openai",
            model: "gpt-5.5-mini",
          },
        },
        null,
        2,
      ),
    );

    expect((await loadRuntimeConfig(workspaceRoot)).reviewModel).toEqual({
      mode: "dedicated",
      provider: "openai",
      model: "gpt-5.5-mini",
    });
  });

  it("resolves the configured internal task provider and model", async () => {
    isolateEnvironment();
    const workspaceRoot = await createWorkspace();

    await mkdir(join(workspaceRoot, ".user-config"), { recursive: true });
    await writeFile(
      join(workspaceRoot, ".user-config", "user-config.json"),
      JSON.stringify({
        internalTaskModel: {
          provider: "anthropic",
          model: "claude-internal",
          reasoning: "high",
        },
      }),
    );
    process.env.ANTHROPIC_API_KEY = "sk-ant-internal-test";

    expect((await loadRuntimeConfig(workspaceRoot)).internalTaskModel).toEqual({
      provider: "anthropic",
      model: "claude-internal",
      reasoning: "high",
    });
  });

  it("preserves a configured CLI internal-task selection", async () => {
    isolateEnvironment();
    const workspaceRoot = await createWorkspace();

    await mkdir(join(workspaceRoot, ".user-config"), { recursive: true });
    await writeFile(
      join(workspaceRoot, ".user-config", "user-config.json"),
      JSON.stringify({
        internalTaskModel: {
          provider: "codex-cli",
          model: "gpt-5.6-sol",
          reasoning: "xhigh",
        },
      }),
    );
    process.env.MACHDOCH_CODEX_CLI_PATH = process.execPath;

    expect((await loadRuntimeConfig(workspaceRoot)).internalTaskModel).toEqual({
      provider: "codex-cli",
      model: "gpt-5.6-sol",
      reasoning: "xhigh",
    });
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

  it("persists nullable workspace-memory overrides", async () => {
    isolateEnvironment();
    const workspaceRoot = await createWorkspace();

    await saveWorkspaceMemoryOverride(workspaceRoot, false);
    expect((await loadWorkspaceConfigFile(workspaceRoot)).config).toMatchObject({
      workspaceMemoryEnabled: false,
    });

    await saveWorkspaceMemoryOverride(workspaceRoot, null);
    expect((await loadWorkspaceConfigFile(workspaceRoot)).config).toMatchObject({
      workspaceMemoryEnabled: null,
    });
  });

  it("persists and loads a numeric Codex context window", async () => {
    isolateEnvironment();
    const workspaceRoot = await createWorkspace();

    process.env.MACHDOCH_CODEX_CLI_PATH = process.execPath;
    await saveWorkspaceRuntimeProvider(workspaceRoot, "codex-cli");
    await saveWorkspaceDefaultModel(workspaceRoot, "gpt-5.5");
    await saveWorkspaceContextWindow(workspaceRoot, 400_000);

    const runtime = await loadRuntimeConfig(workspaceRoot);
    const stored = JSON.parse(
      await readFile(join(workspaceRoot, ".machdoch", "config.json"), "utf8"),
    ) as Record<string, unknown>;

    expect(runtime.contextWindow).toBe(400_000);
    expect(stored.contextWindow).toBe(400_000);
  });

  it("rejects context settings that the configured provider cannot apply", async () => {
    isolateEnvironment();
    const workspaceRoot = await createWorkspace();

    process.env.OPENAI_API_KEY = "sk-real-openai-key-123456";
    await saveWorkspaceRuntimeProvider(workspaceRoot, "openai");
    await saveWorkspaceDefaultModel(workspaceRoot, "gpt-5.5");

    await expect(
      saveWorkspaceContextWindow(workspaceRoot, "long"),
    ).rejects.toThrow("Long context is not supported");
    await expect(
      saveWorkspaceContextWindow(workspaceRoot, 400_000),
    ).rejects.toThrow("cannot be configured");
  });

  it("rejects an invalid context window environment value", async () => {
    isolateEnvironment();
    const workspaceRoot = await createWorkspace();

    process.env.MACHDOCH_CONTEXT_WINDOW = "automatic";

    await expect(loadRuntimeConfig(workspaceRoot)).rejects.toThrow(
      "MACHDOCH_CONTEXT_WINDOW must be default, long, or a positive token count",
    );
  });

  it("persists GPT-5.6 pro mode independently of reasoning effort", async () => {
    isolateEnvironment();
    const workspaceRoot = await createWorkspace();

    process.env.OPENAI_API_KEY = "sk-real-openai-key-123456";
    await saveWorkspaceRuntimeProvider(workspaceRoot, "openai");
    await saveWorkspaceDefaultModel(workspaceRoot, "gpt-5.6-terra");
    await saveWorkspaceReasoningMode(workspaceRoot, "high");
    await saveWorkspaceReasoningExecutionMode(workspaceRoot, "pro");

    const runtime = await loadRuntimeConfig(workspaceRoot);
    expect(runtime.reasoning).toBe("high");
    expect(runtime.reasoningMode).toBe("pro");
    await expect(
      saveWorkspaceDefaultModel(workspaceRoot, "gpt-5.5"),
    ).rejects.toThrow("Reasoning execution mode `pro` is not supported");
  });

  it("persists Aeon reasoning for GPT-6 Astra through Codex CLI", async () => {
    isolateEnvironment();
    const workspaceRoot = await createWorkspace();

    process.env.MACHDOCH_CODEX_CLI_PATH = process.execPath;
    await saveWorkspaceRuntimeProvider(workspaceRoot, "codex-cli");
    await saveWorkspaceDefaultModel(workspaceRoot, "gpt-6-astra");
    await saveWorkspaceReasoningMode(workspaceRoot, "aeon");

    const runtime = await loadRuntimeConfig(workspaceRoot);
    expect(runtime.provider).toBe("codex-cli");
    expect(runtime.model).toBe("gpt-6-astra");
    expect(runtime.reasoning).toBe("aeon");
  });

  it("rejects unsupported reasoning execution mode overrides", async () => {
    isolateEnvironment();
    const workspaceRoot = await createWorkspace();

    process.env.MACHDOCH_REASONING_MODE = "turbo";
    await expect(loadRuntimeConfig(workspaceRoot)).rejects.toThrow(
      "MACHDOCH_REASONING_MODE must be standard or pro",
    );
  });

  it("uses the environment model override ahead of the saved model", async () => {
    isolateEnvironment();
    const workspaceRoot = await createWorkspace();

    process.env.OPENAI_API_KEY = "sk-real-openai-key-123456";
    await saveWorkspaceRuntimeProvider(workspaceRoot, "openai");
    await saveWorkspaceDefaultModel(workspaceRoot, "gpt-5.5");
    process.env.MACHDOCH_MODEL = "gpt-5";

    expect((await loadRuntimeConfig(workspaceRoot)).model).toBe("gpt-5");
  });

  it("rejects provider and model changes that invalidate saved settings", async () => {
    isolateEnvironment();
    const workspaceRoot = await createWorkspace();

    process.env.MACHDOCH_CODEX_CLI_PATH = process.execPath;
    process.env.OPENAI_API_KEY = "sk-real-openai-key-123456";
    await saveWorkspaceRuntimeProvider(workspaceRoot, "codex-cli");
    await saveWorkspaceDefaultModel(workspaceRoot, "gpt-5.5");
    await saveWorkspaceContextWindow(workspaceRoot, 400_000);

    await expect(
      saveWorkspaceRuntimeProvider(workspaceRoot, "openai"),
    ).rejects.toThrow("numeric context window cannot be configured");

    await saveWorkspaceContextWindow(workspaceRoot, "default");
    await saveWorkspaceReasoningMode(workspaceRoot, "none");
    await expect(
      saveWorkspaceDefaultModel(workspaceRoot, "gpt-5"),
    ).rejects.toThrow("Reasoning mode `none` is not supported");

    const stored = JSON.parse(
      await readFile(join(workspaceRoot, ".machdoch", "config.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(stored.provider).toBe("codex-cli");
    expect(stored.model).toBe("gpt-5.5");
  });
});

describe("workspace config transactions", () => {
  it("preserves independent concurrent updates", async () => {
    isolateEnvironment();
    const workspaceRoot = await createWorkspace();

    await Promise.all([
      saveWorkspaceDefaultModel(workspaceRoot, "gpt-5.5"),
      saveWorkspaceRuntimeProvider(workspaceRoot, "openai"),
      saveWorkspaceDefaultMode(workspaceRoot, "ask"),
    ]);

    const config = JSON.parse(
      await readFile(join(workspaceRoot, ".machdoch", "config.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(config).toMatchObject({
      model: "gpt-5.5",
      provider: "openai",
      defaultMode: "ask",
    });
  });
});
