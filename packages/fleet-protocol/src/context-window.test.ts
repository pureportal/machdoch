import assert from "node:assert/strict";
import { test } from "node:test";
import {
  contextWindowCapabilities,
  contextWindowSchema,
} from "./context-window.ts";

await test("Codex ranges follow discovered capacity and the runtime token bound", () => {
  assert.deepEqual(
    contextWindowCapabilities("codex-cli", "discovered", {
      contextWindowTokens: 200_000,
      longContextWindowTokens: 2_000_000,
    }),
    {
      kind: "range",
      minimum: 1,
      maximum: 2_000_000,
      step: 1,
      defaultTokens: 200_000,
    },
  );
  const capabilities = contextWindowCapabilities("codex-cli", "discovered", {
    contextWindowTokens: 20_000_000,
  });
  assert.equal(capabilities.kind, "range");
  if (capabilities.kind === "range") {
    assert.equal(capabilities.maximum, 10_000_000);
    assert.equal(
      contextWindowSchema.safeParse(capabilities.maximum).success,
      true,
    );
  }
});

await test("known Codex models have distinct model limits", () => {
  for (const [model, maximum] of [
    ["gpt-6-astra", 1_050_000],
    ["gpt-5.4-mini", 400_000],
  ] as const) {
    const capabilities = contextWindowCapabilities("codex-cli", model);
    assert.equal(capabilities.kind, "range");
    if (capabilities.kind === "range")
      assert.equal(capabilities.maximum, maximum);
  }
});

await test("invalid or missing capacities never enable arbitrary numeric input", () => {
  for (const capacity of [0, -1, 1.5, Infinity, NaN]) {
    assert.deepEqual(
      contextWindowCapabilities("codex-cli", "gpt-6-astra", {
        contextWindowTokens: capacity,
      }),
      { kind: "fixed" },
    );
    assert.deepEqual(
      contextWindowCapabilities("copilot-cli", "model", {
        longContextWindowTokens: capacity,
      }),
      { kind: "fixed" },
    );
  }
  assert.deepEqual(contextWindowCapabilities("codex-cli", "unknown"), {
    kind: "fixed",
  });
  assert.deepEqual(
    contextWindowCapabilities("codex-cli", undefined, {
      contextWindowTokens: 200_000,
    }),
    { kind: "fixed" },
  );
});

await test("context capacity alone does not imply provider support for resizing", () => {
  for (const provider of ["openai", "anthropic", "gemini-cli", "claude-cli"]) {
    assert.deepEqual(
      contextWindowCapabilities(provider, "fixed-model", {
        contextWindowTokens: 200_000,
        longContextWindowTokens: 1_000_000,
      }),
      { kind: "fixed" },
    );
  }
});

await test("tiered providers expose only their supported long-context sizes", () => {
  assert.deepEqual(
    contextWindowCapabilities("copilot-cli", "discovered", {
      contextWindowTokens: 200_000,
      longContextWindowTokens: 2_000_000,
    }),
    { kind: "presets", defaultTokens: 200_000, longTokens: 2_000_000 },
  );
  assert.deepEqual(contextWindowCapabilities("claude-cli", "sonnet"), {
    kind: "presets",
    defaultTokens: null,
    longTokens: 1_000_000,
  });
  assert.deepEqual(contextWindowCapabilities("claude-cli", "haiku"), {
    kind: "fixed",
  });
});
