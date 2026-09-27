import { describe, expect, it } from "vitest";
import {
  getAvailableParallelAgentModes,
  resolveParallelAgentMode,
  supportsNativeSubagents,
} from "./parallel-agent-capabilities.js";

describe("parallel agent capabilities", () => {
  it.each([
    ["codex-cli", "gpt-6-sol", true],
    ["claude-cli", "claude-opus-4-6", true],
    ["copilot-cli", "gemini-3.5-flash", true],
    ["openai", "gpt-6-astra", true],
    ["openai", "gpt-5.6-terra", true],
    ["openai", "gpt-5.5", false],
    ["anthropic", "claude-opus-4-6", false],
    ["google", "gemini-3.5-flash", false],
    ["langdock", "gpt-6-astra", false],
  ] as const)(
    "resolves native support for %s / %s",
    (provider, model, native) => {
      expect(supportsNativeSubagents(provider, model)).toBe(native);
      expect(getAvailableParallelAgentModes(provider, model)).toEqual(
        native
          ? ["disabled", "read-only", "machdoch", "native"]
          : ["disabled", "read-only", "machdoch"],
      );
    },
  );

  it("rejects unsupported saved native modes", () => {
    expect(
      resolveParallelAgentMode("anthropic", "claude-opus-4-6", "native"),
    ).toBe("disabled");
    expect(resolveParallelAgentMode("openai", "gpt-6-sol", "native")).toBe(
      "native",
    );
    expect(getAvailableParallelAgentModes("unconfigured", "")).toEqual([
      "disabled",
    ]);
    expect(getAvailableParallelAgentModes("codex-cli", "")).toEqual([
      "disabled",
    ]);
  });
});
