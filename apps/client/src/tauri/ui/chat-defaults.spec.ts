import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getChatDefaultsPath,
  loadChatDefaults,
  saveChatPreference,
} from "../../core/chat-defaults.js";
import { normalizeShellState } from "./chat-session.model";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "machdoch-desktop-defaults-"));
  vi.stubEnv("MACHDOCH_USER_CONFIG_DIR", root);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe("desktop and CLI preferences", () => {
  it("hydrates desktop with defaults saved before its first launch", async () => {
    await saveChatPreference("defaults.provider", "openai");
    await saveChatPreference("defaults.model", "gpt-5.6-sol");
    await saveChatPreference("defaults.mode", "ask");
    await saveChatPreference("defaults.reasoning", "high");
    await saveChatPreference("defaults.useGlobalMemory", false);
    await saveChatPreference("spoken-reply.rate", 1.2);
    const snapshot = JSON.parse(await readFile(getChatDefaultsPath(), "utf8"));
    expect(normalizeShellState(snapshot.state)).toMatchObject({
      lastSelectedProvider: "openai",
      lastSelectedModelByProvider: { openai: "gpt-5.6-sol" },
      lastSelectedMode: "ask",
      lastSelectedReasoning: "high",
      lastSelectedUseGlobalMemory: false,
      voice: { rate: 1.2 },
    });
  });

  it("reads the desktop's normalized defaults in standalone CLI", async () => {
    const state = normalizeShellState({
      version: 2,
      lastSelectedProvider: "codex-cli",
      lastSelectedModelByProvider: { "codex-cli": "gpt-6-astra" },
      lastSelectedMode: "machdoch",
      lastSelectedReasoning: "high",
      lastSelectedUseWorkspaceMemory: false,
    });
    await mkdir(dirname(getChatDefaultsPath()), { recursive: true });
    await writeFile(
      getChatDefaultsPath(),
      JSON.stringify({ state, revision: 1 }),
    );
    expect(await loadChatDefaults()).toMatchObject({
      provider: "codex-cli",
      models: { "codex-cli": "gpt-6-astra" },
      mode: "machdoch",
      reasoning: "high",
      useWorkspaceMemory: false,
    });
  });
});
