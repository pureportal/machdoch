import { describe, expect, it } from "vitest";
import { createInstructionResolutionFixture } from "./__test__/instruction-test-helpers.js";
import {
  assertNativeSubagentInstructionDelivery,
  createInstructionDeliveryPlan,
  getInstructionCapabilityDescriptor,
} from "./instruction-system/delivery.js";
import type { InstructionLifecycleSupport } from "./instruction-system/types.js";
import { getAvailableParallelAgentModes, resolveParallelAgentMode } from "./parallel-agent-capabilities.js";
import { supportsNativeSubagents } from "@machdoch/model-runtime/native-subagents";
import { replaceDiscoveredModelCapabilities } from "@machdoch/model-runtime/model-capabilities";

const createNativeInstructionPlan = (
  subagents: InstructionLifecycleSupport,
) => {
  const resolution = createInstructionResolutionFixture({
    providerId: "claude-cli",
    surface: "cli",
    model: "claude-opus-4-6",
  });
  const capability = getInstructionCapabilityDescriptor("claude-cli", "cli");
  return createInstructionDeliveryPlan(resolution, {
    capability: {
      ...capability,
      lifecycle: { ...capability.lifecycle, subagents },
    },
  });
};

describe("parallel agent capabilities", () => {
  it.each([
    ["codex-cli", "gpt-6.1-sol", true],
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
      expect(getAvailableParallelAgentModes(provider, model)).toEqual([
        "disabled",
        "read-only",
        "machdoch",
      ]);
    },
  );

  it("rejects unsupported saved native modes", () => {
    expect(
      resolveParallelAgentMode("anthropic", "claude-opus-4-6", "native"),
    ).toBe("disabled");
    expect(resolveParallelAgentMode("openai", "gpt-6-sol", "native")).toBe(
      "disabled",
    );
    expect(resolveParallelAgentMode("codex-cli", "gpt-6.1-sol", "native")).toBe(
      "disabled",
    );
    expect(getAvailableParallelAgentModes("unconfigured", "")).toEqual([
      "disabled",
    ]);
    expect(getAvailableParallelAgentModes("codex-cli", "")).toEqual([
      "disabled",
    ]);
  });

  it.each([
    ["reattached", true],
    ["session", true],
    ["unknown", false],
    ["unsupported", false],
  ] as const)(
    "matches execution checks for %s subagent instruction delivery",
    (support, available) => {
      const plan = createNativeInstructionPlan(support);
      expect(
        getAvailableParallelAgentModes("claude-cli", "claude-opus-4-6", plan),
      ).toEqual(
        available
          ? ["disabled", "read-only", "machdoch", "native"]
          : ["disabled", "read-only", "machdoch"],
      );
      expect(
        resolveParallelAgentMode(
          "claude-cli",
          "claude-opus-4-6",
          "native",
          plan,
        ),
      ).toBe(available ? "native" : "disabled");
      if (available) {
        expect(() =>
          assertNativeSubagentInstructionDelivery(plan),
        ).not.toThrow();
      } else {
        expect(() => assertNativeSubagentInstructionDelivery(plan)).toThrow(
          /cannot confirm delivery/u,
        );
      }
    },
  );

  it("rejects instruction plans for another provider or an unsupported route", () => {
    const plan = createNativeInstructionPlan("reattached");
    expect(
      getAvailableParallelAgentModes("codex-cli", "gpt-6.1-sol", plan),
    ).not.toContain("native");
    expect(
      getAvailableParallelAgentModes("claude-cli", "claude-opus-4-6", {
        ...plan,
        grade: "unsupported",
      }),
    ).not.toContain("native");
  });

  it("offers native Claude subagents before a run when the CLI probe confirmed them", () => {
    try {
      replaceDiscoveredModelCapabilities("claude-cli", [
        { id: "opus", capabilities: { nativeSubagents: true } },
        { id: "haiku", capabilities: { nativeSubagents: false } },
        { id: "sonnet", capabilities: {} },
      ]);
      expect(getAvailableParallelAgentModes("claude-cli", "opus")).toContain(
        "native",
      );
      expect(resolveParallelAgentMode("claude-cli", "opus", "native")).toBe(
        "native",
      );
      expect(supportsNativeSubagents("claude-cli", "haiku")).toBe(false);
      expect(
        getAvailableParallelAgentModes("claude-cli", "haiku"),
      ).not.toContain("native");
      expect(
        getAvailableParallelAgentModes("claude-cli", "sonnet"),
      ).not.toContain("native");
      // A run's instruction plan still decides once it exists.
      expect(
        getAvailableParallelAgentModes(
          "claude-cli",
          "opus",
          createNativeInstructionPlan("unknown"),
        ),
      ).not.toContain("native");
    } finally {
      replaceDiscoveredModelCapabilities("claude-cli", []);
    }
  });

  it.each(["disabled", "read-only", "machdoch"] as const)(
    "preserves %s mode without native instruction evidence",
    (mode) => {
      expect(resolveParallelAgentMode("codex-cli", "gpt-6.1-sol", mode)).toBe(
        mode,
      );
    },
  );
});
