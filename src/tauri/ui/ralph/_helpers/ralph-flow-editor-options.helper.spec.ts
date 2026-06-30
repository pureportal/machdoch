import type { RuntimeProvider } from "../../model-catalog";
import {
  DEFAULT_RUNTIME_PROVIDER_OPTIONS,
  EDITOR_MODES,
  RALPH_INSPECTOR_SECTIONS,
  RALPH_VARIABLE_SNIPPETS,
  createRalphProviderOptions,
} from "./ralph-flow-editor-options.helper";

describe("Ralph flow editor options", () => {
  it("keeps editor modes and inspector sections in the expected display order", () => {
    expect(EDITOR_MODES.map((mode) => mode.id)).toEqual([
      "design",
      "generate",
      "run",
      "review",
    ]);
    expect(RALPH_INSPECTOR_SECTIONS.map((section) => section.id)).toEqual([
      "content",
      "behavior",
      "execution",
      "advanced",
      "routes",
    ]);
  });

  it("creates provider options with default first and duplicates removed", () => {
    const providers: RuntimeProvider[] = [
      "openai",
      "anthropic",
      "openai",
      "codex-cli",
    ];

    expect(createRalphProviderOptions(providers)).toEqual([
      "default",
      "openai",
      "anthropic",
      "codex-cli",
    ]);
  });

  it("keeps runtime provider defaults and variable snippets available", () => {
    expect(DEFAULT_RUNTIME_PROVIDER_OPTIONS).not.toContain("default");
    expect(DEFAULT_RUNTIME_PROVIDER_OPTIONS).toContain("openai");
    expect(RALPH_VARIABLE_SNIPPETS).toContain("{{lastResult}}");
  });
});
