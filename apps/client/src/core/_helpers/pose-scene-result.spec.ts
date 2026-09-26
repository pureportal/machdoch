import { describe, expect, it } from "vitest";
import type { TaskExecutionResult } from "../types.js";
import type { ConversationMemoryRuntime } from "./agent-tools-shared.js";
import { finalizePoseSceneResult } from "./pose-scene-result.js";

const result: TaskExecutionResult = {
  task: "Create a pose scene",
  mode: "machdoch",
  status: "executed",
  summary: "Created a final image",
  executedTools: [],
  outputSections: [],
  response: { markdown: "Created a final image", highlights: [], relatedFiles: [], verification: [], followUps: [] },
};

const memory = (): ConversationMemoryRuntime => ({
  sourceSessionId: "6b48f2b2-9b96-4567-aab3-e6423dbe482a",
  poseScene: undefined,
  sessionEnabled: false,
  sessionEntries: [],
  globalEnabled: false,
  globalEntries: [],
});

describe("Pose chat result", () => {
  it("does not report a scene that the agent never saved", () => {
    const finalized = finalizePoseSceneResult(result, memory());
    expect(finalized.status).toBe("failed");
    expect(finalized.response?.markdown).toContain("couldn't create");
    expect(finalized.response?.markdown).not.toContain("final image");
  });

  it("describes the saved skeleton scene instead of a final image", () => {
    const context = memory();
    context.poseScene = {
      aspectRatio: "16:9",
      people: [
        { pose: "walking", x: 0.3, y: 0.92, scale: 0.75, mirror: false },
        { pose: "waving", x: 0.7, y: 0.92, scale: 0.75, mirror: true },
      ],
    };
    context.poseSceneSaved = true;
    const finalized = finalizePoseSceneResult(result, context);
    expect(finalized.status).toBe("executed");
    expect(finalized.response?.markdown).toContain("2 editable figures");
    expect(finalized.response?.markdown).toContain("skeleton");
    expect(finalized.response?.markdown).not.toContain("final image");
  });

  it("keeps a failed run's original error", () => {
    const failed = { ...result, status: "failed" as const, reason: "Provider unavailable" };
    expect(finalizePoseSceneResult(failed, memory())).toBe(failed);
  });
});
