import type { AutomationAction } from "./cloud-automation-contract";
import {
  renderAutomationText,
  type AutomationVariables,
} from "./automation-text";

const previewLength = 160;

function preview(template: string, variables: AutomationVariables): string {
  const text = renderAutomationText(template, variables, previewLength + 1)
    .replace(/\s+/g, " ")
    .trim();
  return text.length > previewLength
    ? `${text.slice(0, previewLength - 1)}…`
    : text;
}

function count(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? "" : "s"}`;
}

export function dryRunDetail(
  action: AutomationAction,
  variables: AutomationVariables,
): string {
  switch (action.kind) {
    case "set_status":
      return "Would change the status";
    case "set_priority":
      return `Would set priority to ${action.priority}`;
    case "assign":
      return `Would assign ${action.assignee === "trigger_actor" ? "the trigger actor" : action.assignee === "unassigned" ? "nobody" : action.assignee === "ai" ? "Agent" : "a member"}`;
    case "add_labels":
      return `Would add ${count(action.labelIds.length, "label")}`;
    case "remove_labels":
      return `Would remove ${count(action.labelIds.length, "label")}`;
    case "delegate":
      return `Would open a pull request to ${action.task}${action.instructions ? `: ${preview(action.instructions, variables)}` : ""}`;
    case "prepare_release":
      return `Would write release notes for ${preview(action.version, variables)}`;
    case "write_release_posts":
      return "Would write release notes";
    case "write_project_updates":
      return action.projectIds.length
        ? `Would post updates for ${count(action.projectIds.length, "project")}`
        : "Would post updates for active projects";
    case "comment":
      return `Would comment: ${preview(action.body, variables)}`;
    case "create_issue":
      return `Would create ${action.subIssue ? "sub-issue" : "issue"}: ${preview(action.title, variables)}`;
    case "ask_agent":
      return `Would ask Agent: ${preview(action.prompt, variables)}`;
    case "goal":
      return `Would pursue goal in up to ${action.maxIterations} iterations: ${preview(action.objective, variables)}`;
    case "remember":
      return `Would remember ${action.key}: ${preview(action.value, variables)}`;
    case "request_input":
      return `Would ask for ${action.key}: ${preview(action.prompt, variables)}`;
    case "append_document_section":
      return `Would append section: ${preview(action.heading, variables)}`;
    case "notify":
      return `Would notify ${action.target} via ${action.channel}: ${preview(action.body, variables)}`;
    case "send_webhook":
      return `Would send webhook to ${new URL(action.url).host}`;
    case "fan_out":
      return `Would run another automation on up to ${action.concurrency} issues at a time`;
    default:
      return `Would ${action.kind.replaceAll("_", " ")}`;
  }
}

export interface GoalVerdict {
  passed: boolean;
  feedback: string;
}

export function parseGoalVerdict(answer: string): GoalVerdict {
  const trimmed = answer.trim();
  const [first = "", ...rest] = trimmed.split("\n");
  const verdict = first.replace(/[^a-z]/gi, "").toUpperCase();
  const feedback = rest.join("\n").trim();
  if (verdict.startsWith("PASS")) return { passed: true, feedback };
  return {
    passed: false,
    feedback: verdict.startsWith("FAIL") ? feedback : trimmed,
  };
}

export function goalWorkerPrompt(input: {
  objective: string;
  successCriteria: string;
  iteration: number;
  feedback: string;
}): string {
  return [
    input.objective,
    `Success criteria:\n${input.successCriteria}`,
    input.iteration > 1 && input.feedback
      ? `Attempt ${input.iteration}. The last attempt did not pass:\n${input.feedback}`
      : "",
    "Nobody can answer questions, so do not call ask_user.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function goalEvaluatorPrompt(input: {
  objective: string;
  successCriteria: string;
  result: string;
}): string {
  return [
    "Judge whether the result meets every success criterion.",
    `Objective:\n${input.objective}`,
    `Success criteria:\n${input.successCriteria}`,
    `Result:\n${input.result}`,
    "Answer PASS or FAIL on the first line. After FAIL, list what is missing.",
  ].join("\n\n");
}
