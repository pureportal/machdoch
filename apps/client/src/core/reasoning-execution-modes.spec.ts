import { describe, expect, it } from "vitest";
import {
  assertReasoningExecutionModeSupportedForProviderModel,
  getReasoningExecutionModesForProviderModel,
} from "./reasoning-execution-modes.js";

describe("reasoning execution modes", () => {
  it.each([
    "gpt-6-astra",
    "gpt-6-astra-2026-09-03",
    "gpt-5.6",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-5.6-sol-2026-07-09",
  ])("exposes standard and pro for OpenAI %s", (model) => {
    expect(getReasoningExecutionModesForProviderModel("openai", model)).toEqual(
      ["standard", "pro"],
    );
  });

  it("does not advertise pro on unsupported transports or models", () => {
    expect(
      getReasoningExecutionModesForProviderModel("codex-cli", "gpt-5.6-sol"),
    ).toEqual(["standard"]);
    expect(
      getReasoningExecutionModesForProviderModel("openai", "gpt-5.5"),
    ).toEqual(["standard"]);
  });

  it("rejects pro instead of silently lowering it", () => {
    expect(() =>
      assertReasoningExecutionModeSupportedForProviderModel(
        "pro",
        "google",
        "gemini-3.5-flash",
      ),
    ).toThrow("Reasoning execution mode `pro` is not supported");
  });
});
