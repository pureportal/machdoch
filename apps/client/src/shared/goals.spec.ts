import { afterEach, describe, expect, it } from "vitest";
import { replaceDiscoveredModelCapabilities } from "@machdoch/model-runtime/model-capabilities";
import { getAvailableGoalModes, resolveGoalMode } from "./goals.js";

describe("goal modes", () => {
  afterEach(() => {
    replaceDiscoveredModelCapabilities("claude-cli", []);
  });

  it("offers native goals for agent CLIs with goal support", () => {
    expect(getAvailableGoalModes("claude-cli")).toEqual(["machdoch", "native"]);
    expect(getAvailableGoalModes("codex-cli")).toEqual(["machdoch", "native"]);
    expect(getAvailableGoalModes("openai")).toEqual(["machdoch"]);
  });

  it("follows the Claude CLI probe when it reports the /goal command", () => {
    replaceDiscoveredModelCapabilities("claude-cli", [
      { id: "opus", capabilities: { nativeGoal: true } },
    ]);
    expect(getAvailableGoalModes("claude-cli")).toEqual(["machdoch", "native"]);

    replaceDiscoveredModelCapabilities("claude-cli", [
      { id: "opus", capabilities: { nativeGoal: false } },
    ]);
    expect(getAvailableGoalModes("claude-cli")).toEqual(["machdoch"]);
    expect(resolveGoalMode("claude-cli", "native")).toBe("machdoch");
  });
});
