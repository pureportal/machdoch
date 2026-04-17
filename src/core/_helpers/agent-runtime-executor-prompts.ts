import type {
  AgentModelToolSpec,
  ResolvedTaskContext,
  RuntimeConfig,
} from "../types.js";
import type { ExecutorContinuationRequest } from "./agent-runtime-types.js";
import type { PreparedConversationPromptContext } from "./conversation-prompt-context.js";

const hasTool = (
  tools: AgentModelToolSpec[],
  toolName: string,
): boolean => {
  return tools.some((tool) => tool.name === toolName);
};

const createResearchContract = (tools: AgentModelToolSpec[]): string => {
  const canSearchWeb = hasTool(tools, "search_web");
  const canFetchUrl = hasTool(tools, "fetch_url");

  if (canSearchWeb) {
    return [
      "<research_contract>",
      "When the task would benefit from current external knowledge, do not be shy about researching first.",
      "Use `search_web` proactively for official documentation, best practices, version-sensitive APIs, breaking changes, security guidance, release notes, ambiguous runtime errors, and framework or library behavior that may have changed since your training cutoff.",
      canFetchUrl
        ? "After you find promising sources, use `fetch_url` to inspect the underlying documentation or page before making specific claims."
        : "Inspect the returned sources carefully before making specific claims.",
      "Prefer primary sources such as official docs, standards, vendor pages, and maintainer-authored guidance. Cross-check when sources conflict or look stale.",
      "Skip web research when the workspace itself already provides the answer or when the task is purely local and version-insensitive.",
      "</research_contract>",
    ].join("\n");
  }

  return [
    "<research_contract>",
    canFetchUrl
      ? "Broader web search is not currently available. If the user provides a URL or the task clearly depends on a known remote page, use `fetch_url` directly and say when broader discovery could not be performed in this run."
      : "No web-research tool is currently available. Rely on workspace and tool-grounded local evidence, and explicitly note when current external documentation or best-practice validation would have helped.",
    "Do not pretend you verified online guidance when you could not actually fetch or search for it.",
    "</research_contract>",
  ].join("\n");
};

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
    createResearchContract(tools),
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
    conversationContext.uiControlEnabled
      ? [
          "<ui_control_contract>",
          conversationContext.uiControl?.available
            ? `Desktop UI control is enabled on ${conversationContext.uiControl.platform}. Use the UI tools to inspect windows or screens before acting, then verify the outcome with another capture.`
            : "Desktop UI control was requested for this run, but the native bridge is currently unavailable.",
          conversationContext.uiControl?.available
            ? `Capabilities: screenshots=${conversationContext.uiControl.supportsScreenshots ? "yes" : "no"}, windows=${conversationContext.uiControl.supportsWindowEnumeration ? "yes" : "no"}, input=${conversationContext.uiControl.supportsInput ? "yes" : "no"}, window_handles=${conversationContext.uiControl.supportsWindowHandles ? "yes" : "no"}.`
            : undefined,
          conversationContext.uiControl?.supportsWindowHandles
            ? "On Windows, prefer handle-based window and control operations when they are available because they are more stable than blind coordinate clicks."
            : "Use absolute desktop coordinates carefully and recapture after each meaningful UI action.",
          "After opening apps, switching windows, or triggering navigation, budget for startup/render time by waiting explicitly before assuming the UI has settled.",
          "</ui_control_contract>",
        ]
          .filter((line): line is string => typeof line === "string")
          .join("\n")
      : undefined,
    "<final_response_contract>When the task is complete, call `submit_final_response` exactly once and make it the only tool call in that turn. The markdown must stay compact, use standard Markdown, prefer short bullet lists over long prose, and only mention files or checks that are grounded in actual tool output. Put workspace file references in `relatedFiles` instead of inventing inline file URLs.</final_response_contract>",
    "<completion_requirements>Only stop when the user request is actually satisfied and you have tool-grounded evidence for that conclusion. Do not end with freeform prose alone when you can return the structured final response.</completion_requirements>",
  ]
    .filter((section): section is string => typeof section === "string")
    .join("\n\n");
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
