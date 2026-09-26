import type { TaskExecutionResult } from "../types.js";
import type { ConversationMemoryRuntime } from "./agent-tools-shared.js";

export const finalizePoseSceneResult = (
  result: TaskExecutionResult,
  memory: ConversationMemoryRuntime,
): TaskExecutionResult => {
  if (
    !memory.sourceSessionId ||
    !Object.hasOwn(memory, "poseScene") ||
    result.status !== "executed"
  ) {
    return result;
  }

  const savedScene = memory.poseSceneSaved ? memory.poseScene : undefined;
  const message = savedScene
    ? `Saved ${savedScene.people.length} editable ${savedScene.people.length === 1 ? "figure" : "figures"}. Review the skeleton below and tell me what to adjust.`
    : memory.poseScene
      ? "I couldn't update the pose scene. The current scene is unchanged. Please retry."
      : "I couldn't create the pose scene. Please retry.";

  return {
    ...result,
    status: savedScene ? "executed" : "failed",
    summary: message,
    ...(savedScene ? {} : { reason: message }),
    response: {
      markdown: message,
      highlights: [],
      relatedFiles: [],
      verification: [],
      followUps: [],
    },
  };
};
