import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLI_CONFIG_SETTING_DEFINITIONS,
  clearConfigSetting,
  loadCliConfigEntries,
  saveConfigSetting,
} from "./cli-config-commands.js";
import {
  loadUserConfigFile,
  loadUserWorkspaceRunSettings,
} from "../../core/env.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "machdoch-config-families-"));
  vi.stubEnv("MACHDOCH_USER_CONFIG_DIR", join(root, "user"));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe("configuration family mutations", () => {
  it("preserves environment-first mode and agent limits, and saved-first model sources", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-source-precedence-123456");
    vi.stubEnv("MACHDOCH_MODE", "ask");
    vi.stubEnv("MACHDOCH_MODEL", "environment-model");
    vi.stubEnv("MACHDOCH_EXECUTOR_TURNS", "31");
    await saveConfigSetting(root, "workspace.provider", "openai");
    await saveConfigSetting(root, "workspace.mode", "machdoch");
    await saveConfigSetting(root, "workspace.model", "saved-model");
    await saveConfigSetting(root, "agent-limits.infinite", "on");
    const entries = await loadCliConfigEntries(root);
    expect(
      entries.find((entry) => entry.setting === "workspace.mode"),
    ).toMatchObject({ source: "environment" });
    expect(
      entries.find((entry) => entry.setting === "workspace.model"),
    ).toMatchObject({ source: "saved" });
    expect(
      entries.find((entry) => entry.setting === "agent-limits.executor-turns"),
    ).toMatchObject({ source: "environment", value: 31 });
  });
  it("normalizes names and persisted values while omitting secret result values", async () => {
    const result = await saveConfigSetting(
      root,
      " API.OPENAI.KEY ",
      " sk-test-family-key-123456 ",
    );
    expect(result).toEqual({
      setting: "api.openai.key",
      scope: "user",
      configPath: join(root, "user", "user-config.json"),
      status: "configured",
    });
    expect((await loadUserConfigFile()).config.apiKeys?.openai).toBe(
      "sk-test-family-key-123456",
    );
    expect(await clearConfigSetting(root, " API.OPENAI.KEY ")).toEqual({
      ...result,
      status: "reset",
    });
  });

  it("reports raw additional text and deletes only the reset setting", async () => {
    const result = await saveConfigSetting(
      root,
      "internal-task.model",
      "  family instructions  ",
    );
    expect(result.value).toBe("  family instructions  ");
    const stored = JSON.parse(
      await readFile(result.configPath, "utf8"),
    ) as Record<string, unknown>;
    expect((stored.internalTaskModel as Record<string, unknown>).model).toBe(
      "family instructions",
    );
    expect(await clearConfigSetting(root, "internal-task.model")).toEqual({
      setting: "internal-task.model",
      scope: "user",
      configPath: result.configPath,
      status: "reset",
    });
    const reset = JSON.parse(
      await readFile(result.configPath, "utf8"),
    ) as Record<string, unknown>;
    expect(reset.internalTaskModel).not.toHaveProperty("model");
  });

  it("rejects MCP resets and invalid documents before writing", async () => {
    await expect(clearConfigSetting(root, " WORKSPACE.MCP ")).rejects.toThrow(
      "Edit this configuration",
    );
    await expect(saveConfigSetting(root, "mcp.global", "[]")).rejects.toThrow(
      "Enter a JSON object.",
    );
    const result = await saveConfigSetting(
      root,
      "mcp.global",
      '  {"schemaVersion":1,"servers":[]}  ',
    );
    expect(result).not.toHaveProperty("value");
    expect(JSON.parse(await readFile(result.configPath, "utf8"))).toEqual({
      schemaVersion: 1,
      servers: [],
    });
  });

  it("clears answer language and resets Fleet to false with explicit result values", async () => {
    expect(await clearConfigSetting(root, "answer-language")).toMatchObject({
      status: "reset",
      value: "",
    });
    expect((await loadUserConfigFile()).config.answerLanguage).toBe("");
    expect(await clearConfigSetting(root, "fleet.enabled")).toMatchObject({
      status: "reset",
      value: false,
    });
  });

  it("reduces the health timeout with its interval and rejects excessive timeouts", async () => {
    await saveConfigSetting(
      root,
      "workspace-run.health-check-interval-ms",
      "7000",
    );
    await saveConfigSetting(
      root,
      "workspace-run.health-check-timeout-ms",
      "6500",
    );
    await saveConfigSetting(
      root,
      "workspace-run.health-check-interval-ms",
      "6000",
    );
    expect(await loadUserWorkspaceRunSettings()).toMatchObject({
      healthCheckIntervalMs: 6000,
      healthCheckTimeoutMs: 6000,
    });
    await expect(
      saveConfigSetting(root, "workspace-run.health-check-timeout-ms", "6001"),
    ).rejects.toThrow("at most 6000");
    expect((await loadUserWorkspaceRunSettings()).healthCheckTimeoutMs).toBe(
      6000,
    );
  });

  it.each(["agent-limits.executor-turns", "agent-limits.autopilot-iterations"])(
    "disables infinite mode when saving %s",
    async (setting) => {
      await saveConfigSetting(root, "agent-limits.infinite", "on");
      expect(await saveConfigSetting(root, setting, "12")).toMatchObject({
        value: 12,
      });
      expect((await loadUserConfigFile()).config.agentLimits?.infinite).toBe(
        false,
      );
    },
  );

  it("propagates failed writes and preserves unsupported-setting errors", async () => {
    await writeFile(join(root, "user"), "occupied");
    await expect(
      saveConfigSetting(root, "answer-language", "German"),
    ).rejects.toThrow();
    await expect(
      saveConfigSetting(root, "unknown.setting", "on"),
    ).rejects.toThrow("Unsupported config setting `unknown.setting`");
    await expect(clearConfigSetting(root, "unknown.setting")).rejects.toThrow(
      "Unsupported config setting `unknown.setting`",
    );
  });
});

it("preserves the complete catalogue order", () => {
  expect(
    CLI_CONFIG_SETTING_DEFINITIONS.map((definition) => definition.setting),
  ).toEqual([
    "provider-sync.enabled",
    "provider-sync.persistent",
    "provider-sync.watch",
    "provider-sync.autostart",
    "provider-sync.native-mcp",
    "provider-sync.codex-cli",
    "provider-sync.claude-cli",
    "provider-sync.copilot-cli",
    "agent.adaptive",
    "agent-limits.automatic-retries",
    "agent-limits.retry-attempts",
    "memory.workspace-default",
    "workspace.memory",
    "workspace.adaptive",
    "workspace.reasoning-bank",
    "workspace.infinite",
    "workspace.executor-turns",
    "workspace.autopilot-iterations",
    "internal-task.provider",
    "internal-task.model",
    "internal-task.reasoning",
    "speech-to-text.key-terms",
    "speech-to-text.context",
    "speech-to-text.translate",
    "speech-to-text.format",
    "appearance.theme",
    "appearance.density",
    "appearance.accent",
    "defaults.provider",
    "defaults.model",
    "defaults.mode",
    "defaults.reasoning",
    "defaults.session-memory",
    "defaults.workspace-memory",
    "defaults.global-memory",
    "defaults.ui-control",
    "spoken-reply.enabled",
    "spoken-reply.rate",
    "desktop.autostart-enabled",
    "desktop.running-message-action",
    "assets.folder",
    "civitai.key",
    "mcp.global",
    "workspace.mcp",
    "answer-language",
    "workspace.mode",
    "workspace.provider",
    "workspace.model",
    "workspace.reasoning",
    "workspace.reasoning-mode",
    "workspace.context-window",
    "workspace.offline",
    "workspace.github-customizations",
    "api.openai.key",
    "api.anthropic.key",
    "api.google.key",
    "api.langdock.key",
    "api.quiver.key",
    "api.recraft.key",
    "agent-cli.codex-cli.path",
    "agent-cli.claude-cli.path",
    "agent-cli.copilot-cli.path",
    "web-search.provider",
    "web-search.perplexity.key",
    "web-search.tavily.key",
    "web-search.serper.key",
    "agent-limits.infinite",
    "agent-limits.executor-turns",
    "agent-limits.autopilot-iterations",
    "review-model",
    "memory.global",
    "fleet.enabled",
    "voice.provider",
    "speech-to-text.provider",
    "speech-to-text.input-device",
    "desktop.autostart-minimized",
    "desktop.autostart-to-tray",
    "desktop.always-run-as-administrator",
    "desktop.ai-context-max-messages",
    "desktop.chat-idle-timeout-minutes",
    "desktop.inactive-session-archive-days",
    "desktop.archived-session-retention-days",
    "desktop.quick-voice-enabled",
    "desktop.quick-voice-shortcut",
    "desktop.quick-voice-silence-seconds",
    "desktop.quick-voice-max-messages",
    "workspace-run.startup-delay-ms",
    "workspace-run.health-check-interval-ms",
    "workspace-run.health-check-timeout-ms",
    "workspace-run.health-check-failure-threshold",
    "workspace-run.sequential-readiness-timeout-ms",
  ]);
});
