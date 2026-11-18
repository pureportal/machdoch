import type { RunManifest } from "./cloud-execution.ts";
import type { TaskInferenceInput } from "./cloud-inference.ts";
import { taskSystemPrompt } from "./cloud-agent-tools.ts";

export const taskInferenceReservationOverhead = 1024;
export const sharedAgentMaximumTaskBytes = 32 * 1024;
const changeReportFormat =
  "Finish with a Markdown report using exactly these sections: '## What changed' (the user-visible result), '## Decisions' (each choice you made, why, and any alternative you rejected), and '## Checks' (only checks you actually ran, with their results).";
const checkReportFormat =
  "Do not change the code; your edits are discarded. Finish with a Markdown report using exactly these sections: '## Verdict' (one sentence: whether the pull request is ready to merge), '## Problems' (each problem with the file, the evidence and why it matters, or 'None found'), and '## Checks' (every command you ran and what you inspected, with results).";

export function taskReportFormat(
  manifest: Pick<RunManifest, "subject">,
): string {
  return manifest.subject.kind === "pull_request" &&
    manifest.subject.purpose === "check"
    ? checkReportFormat
    : changeReportFormat;
}
export type TaskPromptManifest = Pick<
  RunManifest,
  | "title"
  | "objective"
  | "acceptanceCriteria"
  | "profile"
  | "branch"
  | "subject"
>;
const sharedAgentEnvironment =
  "Offline Linux sandbox without network access, so package installs fail. Node.js can load playwright-core from /opt/node_modules/playwright-core and launch Chromium at /usr/bin/chromium; the browser tools use the same browser.";

export function sharedAgentTask(
  manifest: TaskPromptManifest,
  correction = "",
): string {
  let excerpt = correction;
  while (true) {
    const task = JSON.stringify({
      objective: manifest.objective,
      acceptanceCriteria: manifest.acceptanceCriteria,
      branch: manifest.branch,
      requiredChecks: manifest.profile.requiredChecks,
      reportFormat: taskReportFormat(manifest),
      environment: sharedAgentEnvironment,
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
        branch: manifest.branch,
        requiredChecks: manifest.profile.requiredChecks,
        reportFormat: taskReportFormat(manifest),
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
