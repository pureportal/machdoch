import { holderCan, type PermissionHolder } from "./cloud-permissions";
export interface AgentQuickAction {
  id: string;
  label: string;
  clients: boolean;
  prompt: (identifier: string) => string;
}

export const issueAgentActions: AgentQuickAction[] = [
  {
    id: "summarize",
    label: "Summarize",
    clients: false,
    prompt: (issue) =>
      `Summarize ${issue}: the goal, decisions from the discussion, open questions and what happens next.`,
  },
  {
    id: "criteria",
    label: "Write acceptance criteria",
    clients: false,
    prompt: (issue) =>
      `Propose acceptance criteria for ${issue} as a checklist of testable conditions.`,
  },
  {
    id: "breakdown",
    label: "Break into sub-issues",
    clients: false,
    prompt: (issue) =>
      `Break ${issue} into sub-issues that each take about a day and propose them as sub-issues of ${issue}.`,
  },
  {
    id: "plan",
    label: "Draft implementation plan",
    clients: false,
    prompt: (issue) =>
      `Draft an implementation plan for ${issue} with the approach, affected areas, risks and test plan, and propose it as a comment.`,
  },
  {
    id: "related",
    label: "Find related issues",
    clients: false,
    prompt: (issue) =>
      `Find issues that are related to, block or duplicate ${issue} and propose links for clear matches.`,
  },
  {
    id: "estimate",
    label: "Suggest priority and estimate",
    clients: false,
    prompt: (issue) =>
      `Suggest a priority, estimate and labels for ${issue} based on similar issues, and propose them.`,
  },
  {
    id: "client",
    label: "Implement on a client",
    clients: true,
    prompt: (issue) =>
      `Implement ${issue} on a connected client: choose a suitable client and workspace and propose a goal-mode session with complete instructions, including working on a new branch and running the checks.`,
  },
];

export function availableIssueAgentActions(
  holder: PermissionHolder,
): AgentQuickAction[] {
  const clients = holderCan(holder, "clients.manage");
  return issueAgentActions.filter((action) => clients || !action.clients);
}
