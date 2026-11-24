import assert from "node:assert/strict";
import { test } from "node:test";
import {
  autoCompactTokens,
  contextWindowCapabilities,
  contextWindowSchema,
  contextWindowTokens,
  isContextWindowAdjustable,
  resolveProviderContextWindow,
} from "./context-window.ts";

void test("stores only model-independent context presets", () => {
  for (const mode of ["lowest", "default", "highest"])
    assert.equal(contextWindowSchema.safeParse(mode).success, true);
  for (const value of ["long", 200_000, "200000", "custom"])
    assert.equal(contextWindowSchema.safeParse(value).success, false);
});

void test("resolves Codex presets from advertised model capacities", () => {
  const supported = contextWindowCapabilities("codex-cli", "discovered", {
    contextWindowTokens: 272_000,
    longContextWindowTokens: 872_000,
  });
  assert.equal(supported.kind, "numeric");
  assert.equal(contextWindowTokens("lowest", supported), 200_000);
  assert.equal(contextWindowTokens("default", supported), 272_000);
  assert.equal(contextWindowTokens("highest", supported), 872_000);
  assert.equal(autoCompactTokens("lowest", supported), 200_000);
  assert.equal(autoCompactTokens("default", supported), null);
  assert.equal(autoCompactTokens("highest", supported), null);
  assert.equal(resolveProviderContextWindow("lowest", supported), "default");
  assert.equal(resolveProviderContextWindow("default", supported), "default");
  assert.equal(resolveProviderContextWindow("highest", supported), 872_000);
});

void test("resolves the same highest preset after switching models or providers", () => {
  for (const [provider, model, capabilities, expected] of [
    [
      "codex-cli",
      "gpt-6-astra",
      { contextWindowTokens: 272_000, longContextWindowTokens: 872_000 },
      872_000,
    ],
    // Without the CLI's model report Codex keeps its own default window.
    ["codex-cli", "gpt-6-astra", undefined, "default"],
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

void test("compacts native 1M Claude models early below Highest", () => {
  const supported = contextWindowCapabilities("claude-cli", "opus");
  assert.equal(supported.kind, "fixed");
  assert.equal(isContextWindowAdjustable(supported), true);
  assert.equal(contextWindowTokens("lowest", supported), 200_000);
  assert.equal(contextWindowTokens("default", supported), 400_000);
  assert.equal(contextWindowTokens("highest", supported), 1_000_000);
  assert.equal(autoCompactTokens("default", supported), 400_000);
});

void test("keeps Claude models with a [1m] tier at their 200K window below Highest", () => {
  const supported = contextWindowCapabilities("claude-cli", "sonnet", {
    longContextWindowTokens: 1_000_000,
  });
  assert.equal(supported.kind, "tiered");
  assert.equal(contextWindowTokens("lowest", supported), 200_000);
  assert.equal(contextWindowTokens("default", supported), 200_000);
  assert.equal(contextWindowTokens("highest", supported), 1_000_000);
  for (const mode of contextWindowSchema.options)
    assert.equal(autoCompactTokens(mode, supported), null);
  assert.equal(resolveProviderContextWindow("highest", supported), "long");
});

void test("single-size agent CLI models keep one window and compact early below Highest", () => {
  for (const provider of ["codex-cli", "copilot-cli"]) {
    const supported = contextWindowCapabilities(provider, "sonnet", {
      contextWindowTokens: 1_000_000,
      longContextWindowTokens: 1_000_000,
    });
    assert.equal(supported.kind, "fixed");
    assert.equal(isContextWindowAdjustable(supported), true);
    assert.equal(contextWindowTokens("lowest", supported), 200_000);
    assert.equal(contextWindowTokens("default", supported), 400_000);
    assert.equal(contextWindowTokens("highest", supported), 1_000_000);
    for (const mode of contextWindowSchema.options)
      assert.equal(resolveProviderContextWindow(mode, supported), "default");
  }
});

void test("small windows and API providers offer no context choice", () => {
  for (const [provider, tokens] of [
    ["codex-cli", 200_000],
    ["copilot-cli", 128_000],
    ["openai", 1_000_000],
  ] as const) {
    const supported = contextWindowCapabilities(provider, "model", {
      contextWindowTokens: tokens,
    });
    assert.equal(isContextWindowAdjustable(supported), false);
    for (const mode of contextWindowSchema.options) {
      assert.equal(contextWindowTokens(mode, supported), tokens);
      assert.equal(autoCompactTokens(mode, supported), null);
    }
  }
});

void test("invalid capacities and unknown models never enable resizing", () => {
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
