import assert from "node:assert/strict";
import { test } from "node:test";
import {
  contextWindowCapabilities,
  contextWindowSchema,
  contextWindowTokens,
  resolveProviderContextWindow,
} from "./context-window.ts";

test("stores only model-independent context presets", () => {
  for (const mode of ["lowest", "default", "highest"])
    assert.equal(contextWindowSchema.safeParse(mode).success, true);
  for (const value of ["long", 200_000, "200000", "custom"])
    assert.equal(contextWindowSchema.safeParse(value).success, false);
});

test("resolves Codex presets from advertised model capacities", () => {
  const supported = contextWindowCapabilities("codex-cli", "discovered", {
    contextWindowTokens: 272_000,
    longContextWindowTokens: 872_000,
  });
  assert.equal(supported.kind, "numeric");
  assert.equal(contextWindowTokens("lowest", supported), 272_000);
  assert.equal(contextWindowTokens("default", supported), 272_000);
  assert.equal(contextWindowTokens("highest", supported), 872_000);
  assert.equal(resolveProviderContextWindow("lowest", supported), 272_000);
  assert.equal(resolveProviderContextWindow("default", supported), "default");
  assert.equal(resolveProviderContextWindow("highest", supported), 872_000);
});

test("resolves the same highest preset after switching models or providers", () => {
  for (const [provider, model, capabilities, expected] of [
    ["codex-cli", "gpt-6-astra", undefined, 1_050_000],
    ["codex-cli", "gpt-5.4-mini", undefined, 400_000],
    ["claude-cli", "sonnet", undefined, "long"],
    [
      "copilot-cli",
      "tiered",
      { contextWindowTokens: 200_000, longContextWindowTokens: 1_000_000 },
      "long",
    ],
    ["openai", "gpt-6-astra", { contextWindowTokens: 1_050_000 }, "default"],
  ] as const) {
    assert.equal(
      resolveProviderContextWindow(
        "highest",
        contextWindowCapabilities(provider, model, capabilities),
      ),
      expected,
    );
  }
});

test("single-size and unsupported models are fixed for every preset", () => {
  for (const provider of ["codex-cli", "copilot-cli", "claude-cli", "openai"]) {
    const supported = contextWindowCapabilities(provider, "sonnet", {
      contextWindowTokens: 1_000_000,
      longContextWindowTokens: 1_000_000,
    });
    assert.equal(supported.kind, "fixed");
    for (const mode of contextWindowSchema.options) {
      assert.equal(contextWindowTokens(mode, supported), 1_000_000);
      assert.equal(resolveProviderContextWindow(mode, supported), "default");
    }
  }
});

test("invalid capacities and unknown models never enable resizing", () => {
  for (const capacity of [0, -1, 1.5, Infinity, NaN]) {
    assert.equal(
      contextWindowCapabilities("codex-cli", "gpt-6-astra", {
        contextWindowTokens: capacity,
      }).kind,
      "fixed",
    );
    assert.equal(
      contextWindowCapabilities("copilot-cli", "model", {
        longContextWindowTokens: capacity,
      }).kind,
      "fixed",
    );
  }
  assert.equal(contextWindowCapabilities("codex-cli", "unknown").kind, "fixed");
  assert.equal(contextWindowCapabilities("codex-cli", undefined).kind, "fixed");
  assert.equal(
    contextWindowCapabilities("openai", "model", {
      contextWindowTokens: 200_000,
      longContextWindowTokens: 1_000_000,
    }).kind,
    "fixed",
  );
});
