import type { RunManifest } from "./cloud-execution.ts";
import type { TaskInferenceInput } from "./cloud-inference.ts";
import { taskSystemPrompt } from "./cloud-agent-tools.ts";

export const taskInferenceReservationOverhead = 1024;
export const sharedAgentMaximumTaskBytes = 32 * 1024;
export type TaskPromptManifest = Pick<
  RunManifest,
  "title" | "objective" | "acceptanceCriteria" | "profile"
>;
export function sharedAgentTask(
  manifest: TaskPromptManifest,
  correction = "",
): string {
  let excerpt = correction;
  while (true) {
    const task = JSON.stringify({
      objective: manifest.objective,
      acceptanceCriteria: manifest.acceptanceCriteria,
      baseCommit: manifest.profile.baseCommit,
      requiredChecks: manifest.profile.requiredChecks,
      ...(excerpt
        ? {
            verificationFeedback: excerpt,
            feedbackTruncated: excerpt !== correction,
          }
        : {}),
    });
    if (
      new TextEncoder().encode(task).length <= sharedAgentMaximumTaskBytes ||
      !excerpt
    )
      return task;
    excerpt = excerpt.slice(0, Math.floor(excerpt.length / 2));
  }
}
export function taskInferencePayload(
  manifest: TaskPromptManifest,
  input: Pick<
    TaskInferenceInput,
    "context" | "runtimePrompt" | "tools" | "modelOptions"
  >,
) {
  const userPrompt =
    JSON.stringify({
      task: {
        title: manifest.title,
        objective: manifest.objective,
        acceptanceCriteria: manifest.acceptanceCriteria,
        baseCommit: manifest.profile.baseCommit,
        requiredChecks: manifest.profile.requiredChecks,
      },
    }) +
    "\n\n" +
    input.context;
  const systemPrompt = input.runtimePrompt
    ? `${taskSystemPrompt}\n\nRuntime guidance:\n${input.runtimePrompt}`
    : taskSystemPrompt;
  const toolsJson = JSON.stringify(input.tools),
    optionsJson = JSON.stringify(input.modelOptions);
  return {
    userPrompt,
    systemPrompt,
    toolsJson,
    optionsJson,
    inputBytes: new TextEncoder().encode(
      userPrompt + systemPrompt + toolsJson + optionsJson,
    ).length,
  };
}
