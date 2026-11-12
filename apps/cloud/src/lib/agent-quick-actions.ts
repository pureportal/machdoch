export interface AgentQuickAction {
  id: string;
  label: string;
  administrator: boolean;
  prompt: (identifier: string) => string;
}

export const issueAgentActions: AgentQuickAction[] = [
  {
    id: "summarize",
    label: "Summarize",
    administrator: false,
    prompt: (issue) =>
      `Summarize ${issue}: the goal, decisions from the discussion, open questions and what happens next.`,
  },
  {
    id: "criteria",
    label: "Write acceptance criteria",
    administrator: false,
    prompt: (issue) =>
      `Propose acceptance criteria for ${issue} as a checklist of testable conditions.`,
  },
  {
    id: "breakdown",
    label: "Break into sub-issues",
    administrator: false,
    prompt: (issue) =>
      `Break ${issue} into sub-issues that each take about a day and propose them as sub-issues of ${issue}.`,
  },
  {
    id: "plan",
    label: "Draft implementation plan",
    administrator: false,
    prompt: (issue) =>
      `Draft an implementation plan for ${issue} with the approach, affected areas, risks and test plan, and propose it as a comment.`,
  },
  {
    id: "related",
    label: "Find related issues",
    administrator: false,
    prompt: (issue) =>
      `Find issues that are related to, block or duplicate ${issue} and propose links for clear matches.`,
  },
  {
    id: "estimate",
    label: "Suggest priority and estimate",
    administrator: false,
    prompt: (issue) =>
      `Suggest a priority, estimate and labels for ${issue} based on similar issues, and propose them.`,
  },
  {
    id: "client",
    label: "Implement on a client",
    administrator: true,
    prompt: (issue) =>
      `Implement ${issue} on a connected client: choose a suitable client and workspace and propose a goal-mode session with complete instructions, including working on a new branch and running the checks.`,
  },
];

export function availableIssueAgentActions(role: string): AgentQuickAction[] {
  const administrator = role === "owner" || role === "admin";
  return issueAgentActions.filter(
    (action) => administrator || !action.administrator,
  );
}
