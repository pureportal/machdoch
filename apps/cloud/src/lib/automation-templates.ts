import type { CloudIssue } from "./cloud-contract";
import type {
  AutomationAction,
  AutomationInput,
  AutomationTrigger,
} from "./cloud-automation-contract";
import type { GitEventKind } from "./git-events";
import type { IssueFilterCondition } from "./issue-filter-model";

export interface AutomationTemplateContext {
  teamId: string;
  statuses: { id: string; name: string; category: CloudIssue["state"] }[];
  labels: { id: string; name: string }[];
  agent: { providerId: string; model: string } | null;
  profileId: string | null;
  productId: string | null;
  client: { instanceId: string; workspace: string } | null;
  timeZone: string;
}

export type AutomationTemplateCategory = "agent" | "workflow" | "integration";

export interface AutomationTemplate {
  id: string;
  name: string;
  category: AutomationTemplateCategory;
  trigger: AutomationTrigger["kind"];
  requires: ("agent" | "profile" | "product" | "client")[];
  build: (context: AutomationTemplateContext) => AutomationInput;
}

function statusIds(
  context: AutomationTemplateContext,
  ...categories: CloudIssue["state"][]
): string[] {
  return context.statuses
    .filter((status) => categories.includes(status.category))
    .map((status) => status.id);
}

function statusCondition(
  context: AutomationTemplateContext,
  ...categories: CloudIssue["state"][]
): IssueFilterCondition[] {
  const values = statusIds(context, ...categories);
  return values.length ? [{ field: "status", negated: false, values }] : [];
}

function labelIds(context: AutomationTemplateContext, ...names: string[]) {
  return context.labels
    .filter((label) => names.includes(label.name.toLowerCase()))
    .map((label) => label.id);
}

function askAgent(
  context: AutomationTemplateContext,
  prompt: string,
  options: { postAnswer: boolean; applyProposals: boolean },
): AutomationAction {
  return {
    kind: "ask_agent",
    prompt,
    providerId: context.agent?.providerId ?? "",
    model: context.agent?.model ?? "",
    ...options,
  };
}

function gitTrigger(
  events: GitEventKind[],
): Extract<AutomationTrigger, { kind: "git_event" }> {
  return {
    kind: "git_event",
    events,
    repositoryIds: [],
    branches: [],
    headBranches: [],
    actors: [],
    contains: "",
  };
}

function automation(
  context: AutomationTemplateContext,
  name: string,
  trigger: AutomationTrigger,
  actions: AutomationAction[],
  conditions: IssueFilterCondition[] = [],
): AutomationInput {
  return {
    name,
    teamId: context.teamId,
    trigger,
    conditions,
    actions,
    dailyLimit: 100,
  };
}

function schedule(
  context: AutomationTemplateContext,
  frequency: "daily" | "weekdays" | "weekly",
  time: string,
  forEachIssue: boolean,
  weekday = 1,
): AutomationTrigger {
  return {
    kind: "schedule",
    frequency,
    time,
    weekday,
    timeZone: context.timeZone,
    forEachIssue,
  };
}

export const automationTemplates: AutomationTemplate[] = [
  {
    id: "agent-mention",
    name: "Answer @agent in comments",
    category: "agent",
    trigger: "comment_created",
    requires: ["agent"],
    build: (context) =>
      automation(
        context,
        "Answer @agent in comments",
        { kind: "comment_created", contains: "@agent" },
        [
          askAgent(
            context,
            "{{actor.name}} wrote on {{issue.identifier}}:\n\n{{comment.body}}",
            { postAnswer: true, applyProposals: false },
          ),
        ],
      ),
  },
  {
    id: "agent-triage",
    name: "Triage new issues with Agent",
    category: "agent",
    trigger: "issue_created",
    requires: ["agent"],
    build: (context) =>
      automation(
        context,
        "Triage new issues with Agent",
        { kind: "issue_created" },
        [
          askAgent(
            context,
            "Triage {{issue.identifier}}. Look for duplicates, then set priority, labels and an estimate when they are clear. Explain your decision in two sentences.",
            { postAnswer: true, applyProposals: true },
          ),
        ],
        statusCondition(context, "triage", "backlog"),
      ),
  },
  {
    id: "agent-breakdown",
    name: "Break issues into sub-issues",
    category: "agent",
    trigger: "manual",
    requires: ["agent"],
    build: (context) =>
      automation(context, "Break into sub-issues", { kind: "manual" }, [
        askAgent(
          context,
          "Break {{issue.identifier}} into 3 to 8 sub-issues. Give each a clear title and acceptance criteria.",
          { postAnswer: false, applyProposals: true },
        ),
      ]),
  },
  {
    id: "agent-acceptance",
    name: "Write acceptance criteria",
    category: "agent",
    trigger: "manual",
    requires: ["agent"],
    build: (context) =>
      automation(context, "Write acceptance criteria", { kind: "manual" }, [
        askAgent(
          context,
          "Write testable acceptance criteria for {{issue.identifier}} as a Markdown task list and update the issue.",
          { postAnswer: false, applyProposals: true },
        ),
      ]),
  },
  {
    id: "agent-review-pull-requests",
    name: "Review new pull requests",
    category: "agent",
    trigger: "git_event",
    requires: ["agent"],
    build: (context) =>
      automation(
        context,
        "Review new pull requests",
        gitTrigger(["pull_request_opened", "pull_request_ready"]),
        [
          askAgent(
            context,
            "Review {{repository.name}}#{{pullRequest.number}} “{{pullRequest.title}}” ({{pullRequest.headRef}} → {{pullRequest.baseRef}}). Read it with read_pull_request, then submit one review with propose_pull_request_review: approve only when you find no problems, otherwise request changes with concrete feedback per file.",
            { postAnswer: false, applyProposals: true },
          ),
        ],
      ),
  },
  {
    id: "agent-pull-request-mention",
    name: "Answer @agent on pull requests",
    category: "agent",
    trigger: "git_event",
    requires: ["agent"],
    build: (context) =>
      automation(
        context,
        "Answer @agent on pull requests",
        { ...gitTrigger(["comment_created"]), contains: "@agent" },
        [
          askAgent(
            context,
            "{{comment.author}} asked on {{repository.name}}#{{pullRequest.number}}:\n\n{{comment.body}}\n\nRead the pull request with read_pull_request and answer with propose_pull_request_comment.",
            { postAnswer: false, applyProposals: true },
          ),
        ],
      ),
  },
  {
    id: "retarget-stacks",
    name: "Retarget stacked pull requests",
    category: "integration",
    trigger: "git_event",
    requires: [],
    build: (context) =>
      automation(
        context,
        "Retarget stacked pull requests",
        gitTrigger(["stack_base_merged"]),
        [{ kind: "git_retarget", identity: "organization" }],
      ),
  },
  {
    id: "agent-pull-request",
    name: "Investigate pull requests that need attention",
    category: "agent",
    trigger: "pull_request_changed",
    requires: ["agent"],
    build: (context) =>
      automation(
        context,
        "Investigate pull requests that need attention",
        { kind: "pull_request_changed", stages: ["attention"] },
        [
          askAgent(
            context,
            "The pull request [{{pullRequest.title}}]({{pullRequest.url}}) for {{issue.identifier}} needs attention because of conflicts, failing checks or requested changes. Read it and list the likely causes and next steps.",
            { postAnswer: true, applyProposals: false },
          ),
        ],
      ),
  },
  {
    id: "agent-summary",
    name: "Summarize completed issues",
    category: "agent",
    trigger: "status_changed",
    requires: ["agent"],
    build: (context) =>
      automation(
        context,
        "Summarize completed issues",
        {
          kind: "status_changed",
          statusIds: statusIds(context, "complete"),
        },
        [
          askAgent(
            context,
            "{{issue.identifier}} was completed. Summarize what was done and anything left open in at most five bullet points.",
            { postAnswer: true, applyProposals: false },
          ),
        ],
      ),
  },
  {
    id: "agent-stale-review",
    name: "Unblock stalled reviews",
    category: "agent",
    trigger: "schedule",
    requires: ["agent"],
    build: (context) =>
      automation(
        context,
        "Unblock stalled reviews",
        schedule(context, "weekdays", "09:00", true),
        [
          askAgent(
            context,
            "{{issue.identifier}} has been in review for over a week without updates. Summarize what blocks it and suggest the next step.",
            { postAnswer: true, applyProposals: false },
          ),
        ],
        [
          ...statusCondition(context, "review"),
          { field: "updated", negated: true, values: ["week"] },
        ],
      ),
  },
  {
    id: "agent-project-updates",
    name: "Weekly project updates",
    category: "agent",
    trigger: "schedule",
    requires: ["agent"],
    build: (context) =>
      automation(
        context,
        "Weekly project updates",
        schedule(context, "weekly", "16:00", false, 5),
        [
          askAgent(
            context,
            "Post a project status update for every active project of this team. Base the health on progress, overdue issues and blockers, and keep each update under 120 words.",
            { postAnswer: false, applyProposals: true },
          ),
        ],
      ),
  },
  {
    id: "release-autopilot",
    name: "Weekly release on autopilot",
    category: "agent",
    trigger: "schedule",
    requires: ["agent", "product"],
    build: (context) =>
      automation(
        context,
        "Weekly release on autopilot",
        schedule(context, "weekly", "15:00", false, 5),
        [
          {
            kind: "prepare_release",
            productId: context.productId ?? "",
            version: "{{date}}",
            name: "Weekly update",
            providerId: context.agent?.providerId ?? null,
            model: context.agent?.model ?? "",
            instructions:
              "Summarize this week's shipped work for customers. Keep every post skimmable.",
          },
        ],
      ),
  },
  {
    id: "release-linkedin",
    name: "LinkedIn post when enough has shipped",
    category: "agent",
    trigger: "release_created",
    requires: ["agent", "product"],
    build: (context) =>
      automation(
        context,
        "LinkedIn post when enough has shipped",
        { kind: "release_created", productIds: [] },
        [
          {
            kind: "write_release_posts",
            channelKinds: ["linkedin"],
            providerId: context.agent?.providerId ?? "",
            model: context.agent?.model ?? "",
            instructions:
              "Lead with the most valuable change for customers and keep the post skimmable.",
            measure: "issues",
            minimumChanges: 5,
          },
        ],
      ),
  },
  {
    id: "delegate-label",
    name: "Delegate labeled issues to an AI task",
    category: "agent",
    trigger: "label_added",
    requires: ["profile"],
    build: (context) =>
      automation(
        context,
        "Delegate labeled issues to an AI task",
        { kind: "label_added", labelIds: labelIds(context, "agent", "ai") },
        [
          {
            kind: "delegate",
            profileId: context.profileId ?? "",
            instructions: "",
            acceptanceCriteria: "",
          },
        ],
      ),
  },
  {
    id: "delegate-failed-checks",
    name: "Fix failing pull request checks with an AI task",
    category: "agent",
    trigger: "git_event",
    requires: ["profile"],
    build: (context) =>
      automation(
        context,
        "Fix failing pull request checks with an AI task",
        gitTrigger(["checks_failed"]),
        [
          {
            kind: "delegate",
            profileId: context.profileId ?? "",
            instructions:
              "The checks failed on {{repository.name}}#{{pullRequest.number}} “{{pullRequest.title}}” ({{pullRequest.headRef}}). Find the cause and fix it without changing unrelated code.",
            acceptanceCriteria:
              "The failing checks pass and no other check starts failing.",
          },
        ],
      ),
  },
  {
    id: "client-goal",
    name: "Implement labeled issues on a client in goal mode",
    category: "agent",
    trigger: "label_added",
    requires: ["client"],
    build: (context) =>
      automation(
        context,
        "Implement labeled issues on a client",
        { kind: "label_added", labelIds: labelIds(context, "agent", "ai") },
        [
          {
            kind: "start_client_session",
            instanceId: context.client?.instanceId ?? "",
            workspace: context.client?.workspace ?? "",
            title: "{{issue.identifier}} {{issue.title}}",
            prompt:
              "Implement {{issue.identifier}}: {{issue.title}}\n\n{{issue.description}}\n\nIssue: {{issue.url}}\n\nWork on a new branch named after the issue, run the checks and finish with a summary of what changed.",
            goal: true,
          },
          {
            kind: "comment",
            body: "A connected client is working on this in goal mode.",
          },
        ],
      ),
  },
  {
    id: "assign-on-start",
    name: "Assign issues to whoever starts them",
    category: "workflow",
    trigger: "status_changed",
    requires: [],
    build: (context) =>
      automation(
        context,
        "Assign issues to whoever starts them",
        { kind: "status_changed", statusIds: statusIds(context, "active") },
        [{ kind: "assign", assignee: "trigger_actor" }],
        [{ field: "assignee", negated: false, values: ["none"] }],
      ),
  },
  {
    id: "urgent-to-ready",
    name: "Move urgent issues to the top",
    category: "workflow",
    trigger: "priority_changed",
    requires: [],
    build: (context) =>
      automation(
        context,
        "Move urgent issues to the top",
        { kind: "priority_changed", priorities: ["urgent"] },
        statusIds(context, "ready")
          .slice(0, 1)
          .map((statusId) => ({ kind: "set_status" as const, statusId })),
        statusCondition(context, "triage", "backlog"),
      ),
  },
  {
    id: "close-stale",
    name: "Close stale backlog issues",
    category: "workflow",
    trigger: "schedule",
    requires: [],
    build: (context) =>
      automation(
        context,
        "Close stale backlog issues",
        schedule(context, "weekly", "08:00", true),
        [
          {
            kind: "comment",
            body: "Closed automatically after a month without activity. Reopen it when it becomes relevant again.",
          },
          ...statusIds(context, "canceled")
            .slice(0, 1)
            .map((statusId) => ({ kind: "set_status" as const, statusId })),
        ],
        [
          ...statusCondition(context, "backlog"),
          { field: "updated", negated: true, values: ["month"] },
        ],
      ),
  },
  {
    id: "webhook-intake",
    name: "Create issues from a webhook",
    category: "integration",
    trigger: "webhook",
    requires: [],
    build: (context) =>
      automation(context, "Create issues from a webhook", { kind: "webhook" }, [
        {
          kind: "create_issue",
          title: "{{payload.title}}",
          description: "{{payload.description}}\n\n```json\n{{payload}}\n```",
          statusId: statusIds(context, "triage", "backlog")[0] ?? null,
          priority: "none",
          assigneeId: null,
          labelIds: [],
          subIssue: false,
        },
      ]),
  },
];
