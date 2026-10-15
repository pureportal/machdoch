import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getChatDefaultsPath,
  loadChatDefaults,
} from "../../core/chat-defaults.js";
import { loadRuntimeConfig } from "../../core/config.js";
import { DEFAULT_MODEL_BY_PROVIDER } from "../../core/runtime-contract.generated.js";
import { resolveConversationContext } from "./cli-task-run.js";
import {
  clearConfigSetting,
  loadCliConfigEntries,
  saveConfigSetting,
} from "./cli-config-commands.js";
import {
  runInteractiveConfig,
  type InteractiveConfigPrompter,
} from "./cli-config-interactive.js";

let root: string;
let workspace: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "machdoch-shared-defaults-"));
  workspace = join(root, "workspace");
  await mkdir(workspace);
  vi.stubEnv("MACHDOCH_USER_CONFIG_DIR", join(root, "user"));
  for (const key of [
    "MACHDOCH_MODE",
    "MACHDOCH_MODEL",
    "MACHDOCH_REASONING",
    "MACHDOCH_REASONING_MODE",
    "MACHDOCH_CONTEXT_WINDOW",
  ])
    vi.stubEnv(key, "");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe("shared desktop and CLI chat defaults", () => {
  it("edits global defaults without desktop and uses them across workspaces", async () => {
    await saveConfigSetting(workspace, "defaults.provider", "openai");
    await saveConfigSetting(workspace, "defaults.model", "gpt-5.6-sol");
    await saveConfigSetting(workspace, "defaults.mode", "ask");
    await saveConfigSetting(workspace, "defaults.reasoning", "high");

    const otherWorkspace = join(root, "other");
    for (const path of [workspace, otherWorkspace]) {
      expect(await loadRuntimeConfig(path)).toMatchObject({
        provider: "openai",
        model: "gpt-5.6-sol",
        mode: "ask",
        reasoning: "high",
      });
    }
    expect(
      (await loadCliConfigEntries(workspace)).find(
        (entry) => entry.setting === "defaults.reasoning",
      ),
    ).toMatchObject({ value: "high", source: "saved" });
    const snapshot = JSON.parse(await readFile(getChatDefaultsPath(), "utf8"));
    expect(snapshot.state.version).toBe(2);
  });

  it("uses explicit options, environment and workspace settings before global defaults", async () => {
    await saveConfigSetting(workspace, "defaults.provider", "openai");
    await saveConfigSetting(workspace, "defaults.model", "global-model");
    await saveConfigSetting(workspace, "defaults.mode", "ask");
    await saveConfigSetting(workspace, "defaults.reasoning", "high");
    await saveConfigSetting(workspace, "workspace.model", "gpt-5.6-sol");
    await saveConfigSetting(workspace, "workspace.mode", "machdoch");
    await saveConfigSetting(workspace, "workspace.reasoning", "low");
    expect(await loadRuntimeConfig(workspace)).toMatchObject({
      model: "gpt-5.6-sol",
      mode: "machdoch",
      reasoning: "low",
    });
    vi.stubEnv("MACHDOCH_MODEL", "gpt-5.6-terra");
    vi.stubEnv("MACHDOCH_MODE", "ask");
    vi.stubEnv("MACHDOCH_REASONING", "medium");
    expect(await loadRuntimeConfig(workspace)).toMatchObject({
      model: "gpt-5.6-terra",
      mode: "ask",
      reasoning: "medium",
    });
    expect(
      await loadRuntimeConfig(
        workspace,
        "machdoch",
        "gpt-5.6-sol",
        "openai",
        undefined,
        "high",
      ),
    ).toMatchObject({
      model: "gpt-5.6-sol",
      mode: "machdoch",
      reasoning: "high",
    });
  });

  it("keeps a separate model for each provider and resets the selected provider model", async () => {
    await saveConfigSetting(workspace, "defaults.provider", "openai");
    await saveConfigSetting(workspace, "defaults.model", "gpt-5.6-terra");
    await saveConfigSetting(workspace, "defaults.provider", "anthropic");
    await saveConfigSetting(workspace, "defaults.model", "claude-sonnet-4-6");
    expect((await loadRuntimeConfig(workspace)).model).toBe(
      "claude-sonnet-4-6",
    );
    await saveConfigSetting(workspace, "defaults.provider", "openai");
    expect((await loadRuntimeConfig(workspace)).model).toBe("gpt-5.6-terra");
    await clearConfigSetting(workspace, "defaults.model");
    expect((await loadRuntimeConfig(workspace)).model).toBe(
      DEFAULT_MODEL_BY_PROVIDER.openai,
    );
    expect((await loadChatDefaults()).models.anthropic).toBe(
      "claude-sonnet-4-6",
    );
    await clearConfigSetting(workspace, "defaults.mode");
    await clearConfigSetting(workspace, "defaults.reasoning");
    expect(await loadChatDefaults()).not.toHaveProperty("mode");
    expect(await loadChatDefaults()).not.toHaveProperty("reasoning");
  });

  it("reads desktop-written defaults and preserves conversations during concurrent edits", async () => {
    const state = {
      sessions: [
        { id: "keep-me", messages: [{ content: "Existing conversation" }] },
      ],
      lastSelectedProvider: "openai",
      lastSelectedModelByProvider: { openai: "gpt-5.6-sol" },
      lastSelectedMode: "ask",
      voice: { voiceUri: "keep-voice" },
      __machdochTombstones: { sessions: { deleted: 5 } },
    };
    await mkdir(dirname(getChatDefaultsPath()), { recursive: true });
    await writeFile(
      getChatDefaultsPath(),
      JSON.stringify({ state, revision: 7 }),
    );
    expect((await loadRuntimeConfig(workspace)).mode).toBe("ask");
    await Promise.all([
      saveConfigSetting(workspace, "defaults.reasoning", "high"),
      saveConfigSetting(workspace, "defaults.session-memory", "off"),
      saveConfigSetting(workspace, "spoken-reply.rate", "1.2"),
    ]);
    const snapshot = JSON.parse(await readFile(getChatDefaultsPath(), "utf8"));
    expect(snapshot).toMatchObject({
      revision: 10,
      state: {
        ...state,
        lastSelectedReasoning: "high",
        lastSelectedSessionMemoryEnabled: false,
        voice: { voiceUri: "keep-voice", rate: 1.2 },
      },
    });
    expect(
      await readFile(
        join(
          dirname(getChatDefaultsPath()),
          "machdoch-shell-state.snapshot.revision",
        ),
        "utf8",
      ),
    ).toBe("10");
  });

  it("applies memory and control defaults while respecting explicit conversation settings", async () => {
    await saveConfigSetting(workspace, "defaults.session-memory", "off");
    await saveConfigSetting(workspace, "defaults.workspace-memory", "off");
    await saveConfigSetting(workspace, "defaults.global-memory", "off");
    await saveConfigSetting(workspace, "defaults.ui-control", "on");
    expect(
      await resolveConversationContext({ workspaceRoot: workspace }),
    ).toMatchObject({
      sessionMemoryEnabled: false,
      workspaceMemoryEnabled: false,
      globalMemoryEnabled: false,
      uiControlEnabled: true,
    });
    expect(
      await resolveConversationContext(
        { workspaceRoot: workspace, globalMemoryEnabled: true },
        {
          history: [],
          sessionMemoryEnabled: true,
          uiControlEnabled: false,
        },
      ),
    ).toMatchObject({
      sessionMemoryEnabled: true,
      globalMemoryEnabled: true,
      uiControlEnabled: false,
    });
  });

  it("opens Defaults in the interactive editor and saves without desktop", async () => {
    const selections = [
      "__defaults",
      "defaults.provider",
      "openai",
      "defaults.mode",
      "ask",
      "__back",
      "__done",
    ];
    const prompter: InteractiveConfigPrompter = {
      select: vi.fn(async () => selections.shift()),
      input: vi.fn(),
      status: vi.fn(),
      suspend: async (action) => await action(),
      close: vi.fn(),
    };
    await runInteractiveConfig(workspace, { prompter });
    expect(prompter.status).toHaveBeenCalledWith("Mode updated.");
    expect(prompter.status).not.toHaveBeenCalledWith(
      expect.anything(),
      "error",
    );
    expect((await loadRuntimeConfig(workspace)).mode).toBe("ask");
  });

  it("rejects invalid model and voice values without changing the saved defaults", async () => {
    await saveConfigSetting(workspace, "defaults.model", "gpt-5.6-sol");
    expect(await loadRuntimeConfig(workspace)).toMatchObject({
      provider: "openai",
      model: "gpt-5.6-sol",
    });
    await expect(
      saveConfigSetting(workspace, "defaults.model", " "),
    ).rejects.toThrow("model id");
    await expect(
      saveConfigSetting(workspace, "defaults.model", "bad\nmodel"),
    ).rejects.toThrow("model id");
    await expect(
      saveConfigSetting(workspace, "spoken-reply.rate", "4"),
    ).rejects.toThrow("0.8 to 1.4");
    expect((await loadChatDefaults()).models.openai).toBe("gpt-5.6-sol");
  });
});
