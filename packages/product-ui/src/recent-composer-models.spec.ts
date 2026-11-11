import { beforeEach, describe, expect, it } from "vitest";
import type { ComposerModelProvider } from "./composer-model-picker";
import {
  parseRecentComposerModels,
  rememberRecentComposerModel,
  resolveRecentComposerModels,
  withRecentComposerModel,
} from "./recent-composer-models";

const STORAGE_KEY = "machdoch.composer.recent-models";
const opus = { provider: "claude-cli", model: "opus" };
const sonnet = { provider: "claude-cli", model: "sonnet" };
const sol = { provider: "codex-cli", model: "gpt-5.6-sol" };

describe("withRecentComposerModel", () => {
  it("moves the selection to the front without duplicates", () => {
    expect(withRecentComposerModel([opus, sonnet, sol], sol)).toEqual([
      sol,
      opus,
      sonnet,
    ]);
  });

  it("keeps the same list when the selection is already the most recent", () => {
    const recentModels = [opus, sonnet];
    expect(withRecentComposerModel(recentModels, { ...opus })).toBe(
      recentModels,
    );
  });

  it("keeps only the five most recent models", () => {
    const recentModels = ["a", "b", "c", "d", "e"].map((model) => ({
      provider: "claude-cli",
      model,
    }));
    expect(
      withRecentComposerModel(recentModels, sol).map((entry) => entry.model),
    ).toEqual(["gpt-5.6-sol", "a", "b", "c", "d"]);
  });

  it("separates identical model ids from different providers", () => {
    const codexOpus = { provider: "codex-cli", model: "opus" };
    expect(withRecentComposerModel([opus], codexOpus)).toEqual([
      codexOpus,
      opus,
    ]);
  });
});

describe("parseRecentComposerModels", () => {
  it.each([null, "", "not json", "{}", '"opus"'])(
    "returns no models for %j",
    (raw) => {
      expect(parseRecentComposerModels(raw)).toEqual([]);
    },
  );

  it("drops invalid and duplicate entries and keeps the stored order", () => {
    expect(
      parseRecentComposerModels(
        JSON.stringify([
          sol,
          { provider: "", model: "empty" },
          { provider: "claude-cli" },
          "opus",
          null,
          { ...opus, label: "Opus" },
          sol,
          sonnet,
        ]),
      ),
    ).toEqual([sol, opus, sonnet]);
  });

  it("keeps at most five models", () => {
    const stored = ["a", "b", "c", "d", "e", "f"].map((model) => ({
      provider: "claude-cli",
      model,
    }));
    expect(
      parseRecentComposerModels(JSON.stringify(stored)).map(
        (entry) => entry.model,
      ),
    ).toEqual(["a", "b", "c", "d", "e"]);
  });
});

describe("resolveRecentComposerModels", () => {
  const providers: ComposerModelProvider[] = [
    {
      id: "claude-cli",
      label: "Claude Code",
      available: true,
      models: [
        { id: "opus", label: "Opus" },
        { id: "sonnet", label: "Sonnet" },
      ],
    },
    {
      id: "codex-cli",
      label: "Codex CLI",
      available: false,
      models: [{ id: "gpt-5.6-sol", label: "GPT-5.6 Sol" }],
    },
  ];

  it("keeps usage order and only offers selectable catalog models", () => {
    expect(
      resolveRecentComposerModels(
        [
          sonnet,
          sol,
          { provider: "claude-cli", model: "retired" },
          { provider: "gemini-cli", model: "flash" },
          opus,
        ],
        providers,
      ).map(({ provider, model }) => [provider.label, model.label]),
    ).toEqual([
      ["Claude Code", "Sonnet"],
      ["Claude Code", "Opus"],
    ]);
  });
});

describe("rememberRecentComposerModel", () => {
  beforeEach(() => localStorage.clear());

  it("persists picks in most recently used order", () => {
    rememberRecentComposerModel(opus);
    rememberRecentComposerModel(sol);
    rememberRecentComposerModel(sonnet);
    rememberRecentComposerModel(opus);

    expect(
      parseRecentComposerModels(localStorage.getItem(STORAGE_KEY)),
    ).toEqual([opus, sonnet, sol]);
  });
});
