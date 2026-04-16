import type {
  AgentModelToolSpec,
  ResolvedTaskContext,
  RuntimeConfig,
} from "../types.js";
import type { ExecutorContinuationRequest } from "./agent-runtime-types.js";
import type { PreparedConversationPromptContext } from "./conversation-prompt-context.js";

export const createExecutorSystemPrompt = (
  config: RuntimeConfig,
  taskContext: ResolvedTaskContext,
  tools: AgentModelToolSpec[],
  conversationContext: PreparedConversationPromptContext,
  continuationRequest?: ExecutorContinuationRequest,
): string => {
  const instructionLines =
    taskContext.applicableInstructions.length > 0
      ? taskContext.applicableInstructions.map(
          (instruction) => `${instruction.name}: ${instruction.body}`,
        )
      : ["No additional task-specific instructions were discovered."];
  const promptContextLines = taskContext.invokedPrompt
    ? [
        `Resolved prompt: /${taskContext.invokedPrompt.name}`,
        `Prompt body: ${taskContext.invokedPrompt.resolvedBody}`,
      ]
    : ["Resolved prompt: none"];

  return [
    "<role>You are Machdoch Executor, a local-first autonomous workspace agent responsible for doing the work rather than grading it.</role>",
    "<mission>Keep working until the task is complete, blocked by a real runtime limitation, or paused for approval. Use tools instead of guessing, and never claim a change, command, or fetched result unless a tool actually produced it.</mission>",
    "<operating_principles>Prefer low-risk inspection before edits. Before editing an existing file, inspect it first. Use create_file only for brand-new files and replace_in_file for targeted edits. If a tool returns an error, adapt and continue instead of stopping immediately.</operating_principles>",
    config.mode === "auto"
      ? "<autopilot_contract>You are running in Autopilot mode. A separate monitor agent will review every claimed completion. Before you stop, gather concrete verification evidence from tool results. If monitor feedback is provided, treat every missing requirement and required action as mandatory for the next iteration.</autopilot_contract>"
      : "<approval_contract>If a higher-risk action is necessary, call the tool anyway; the runtime will pause automatically if approval is required.</approval_contract>",
    continuationRequest
      ? [
          "<monitor_feedback>",
          `This is continuation iteration ${continuationRequest.continuationIndex}.`,
          `Rationale: ${continuationRequest.rationale}`,
          continuationRequest.missingRequirements.length > 0
            ? `Missing requirements: ${continuationRequest.missingRequirements.join(", ")}`
            : "Missing requirements: none listed",
          continuationRequest.requiredActions.length > 0
            ? `Required actions: ${continuationRequest.requiredActions.join(", ")}`
            : "Required actions: none listed",
          "You must address this feedback before claiming completion again.",
          "</monitor_feedback>",
        ].join("\n")
      : "<monitor_feedback>No prior monitor feedback has been issued for this task.</monitor_feedback>",
    [
      "<runtime>",
      `Workspace root: ${config.workspaceRoot}`,
      `Runtime mode: ${config.mode}`,
      `Selected provider: ${config.provider}`,
      `Selected model: ${config.model}`,
      `Enabled high-level tools: ${config.enabledTools.join(", ")}`,
      `Available agent tools: ${tools.map((tool) => tool.name).join(", ")}`,
      ...promptContextLines,
      "</runtime>",
    ].join("\n"),
    ["<instructions>", ...instructionLines, "</instructions>"].join("\n"),
    [
      "<memory_contract>",
      conversationContext.memory.sessionEnabled
        ? "Session memory is enabled. Use `remember_session_memory` for facts, preferences, or decisions that should matter later in this same session."
        : "Session memory is disabled for this run.",
      conversationContext.memory.globalEnabled
        ? "Global memory is enabled. Use `remember_global_memory` only for durable cross-session preferences or facts that will still matter in later sessions."
        : "Global memory is disabled for this run.",
      "Never store transient tool output, secrets, or speculative guesses as memory.",
      "</memory_contract>",
    ].join("\n"),
    "<final_response_contract>When the task is complete, call `submit_final_response` exactly once and make it the only tool call in that turn. The markdown must stay compact, use standard Markdown, prefer short bullet lists over long prose, and only mention files or checks that are grounded in actual tool output. Put workspace file references in `relatedFiles` instead of inventing inline file URLs.</final_response_contract>",
    "<completion_requirements>Only stop when the user request is actually satisfied and you have tool-grounded evidence for that conclusion. Do not end with freeform prose alone when you can return the structured final response.</completion_requirements>",
  ].join("\n\n");
};

export const createExecutorUserPrompt = (
  task: string,
  taskContext: ResolvedTaskContext,
  conversationContext: PreparedConversationPromptContext,
  continuationRequest?: ExecutorContinuationRequest,
): string => {
  return [
    `<original_task>${task}</original_task>`,
    `<effective_task>${taskContext.effectiveTask}</effective_task>`,
    `<workspace_paths>${taskContext.workspacePaths.length > 0 ? taskContext.workspacePaths.join(", ") : "none"}</workspace_paths>`,
    continuationRequest
      ? `<current_goal>Continue the task and satisfy the monitor feedback from continuation ${continuationRequest.continuationIndex}.</current_goal>`
      : "<current_goal>Complete the task by using tools, checking the results, and continuing until the work is done.</current_goal>",
    ...(conversationContext.promptBlock
      ? [conversationContext.promptBlock]
      : []),
  ].join("\n");
};
