import { randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  AgentModelImageInput,
  AgentModelToolCall,
  AgentModelToolSpec,
} from "@machdoch/model-runtime/types";
import {
  issuePriorities,
  issueStates,
  type CloudActor,
  type IssueFilters,
} from "../../../lib/cloud-contract";
import type {
  AgentAction,
  AgentQuestion,
  AgentStep,
} from "../../../lib/cloud-chat-contract";
import {
  noneFilterValue,
  type IssueFilterCondition,
} from "../../../lib/issue-filter-model";
import {
  AgentLookupError,
  AgentWorkspace,
  agentFailureMessage,
} from "./agent-workspace";
import { proposalTools } from "./agent-proposals";
import { releaseTools } from "./agent-release-tools";
import { automationTools } from "./agent-automation-tools";
import { attachmentTools } from "./agent-attachment-tools";
import { clientTools } from "./agent-client-tools";
import { agentTool, type AgentServices, type AgentTool } from "./agent-tool";

export interface AgentToolResult {
  output: string;
  isError: boolean;
  terminal: boolean;
  step: AgentStep;
  question?: AgentQuestion;
  action?: AgentAction;
}

const maximumToolOutputCharacters = 12_000;
const recentCommentCount = 12;
const commentPageCharacters = 9_000;
const commentListLimit = 50;
const reference = z.string().trim().min(1).max(120);
const issueReference = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .describe("Issue identifier such as ENG-42, or the issue ID.");

function serialize(value: unknown): string {
  const text = JSON.stringify(value);
  return text.length > maximumToolOutputCharacters
    ? `${text.slice(0, maximumToolOutputCharacters)}… (truncated; narrow the request for more)`
    : text;
}

function excerpt(text: string, length: number): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > length ? `${compact.slice(0, length - 1)}…` : compact;
}

const readTools: AgentTool[] = [
  agentTool({
    name: "search_issues",
    description:
      "Search accessible issues. Combine filters; omit statusCategories to exclude completed and canceled issues. Returns at most `limit` issues ordered by the chosen sort.",
    schema: z.strictObject({
      query: z
        .string()
        .trim()
        .max(200)
        .optional()
        .describe("Text matched against identifier, title and description."),
      team: reference.optional().describe("Team key or name."),
      project: reference.optional().describe("Project name or ID."),
      cycle: reference
        .optional()
        .describe('Cycle name, ID, "current" or "next".'),
      assignee: reference
        .optional()
        .describe('Member name, "me" or "unassigned".'),
      label: reference.optional().describe("Label name; requires team."),
      priority: z.enum(issuePriorities).optional(),
      statusCategories: z
        .array(z.enum(issueStates))
        .min(1)
        .max(issueStates.length)
        .optional(),
      sort: z.enum(["updated", "created", "priority", "due"]).optional(),
      limit: z.number().int().min(1).max(50).optional(),
    }),
    async run(session, input) {
      const workspace = session.workspace;
      const team = input.team ? workspace.team(input.team) : undefined;
      const conditions: IssueFilterCondition[] = [];
      const condition = (field: IssueFilterCondition["field"], value: string) =>
        conditions.push({ field, negated: false, values: [value] });
      if (input.project)
        condition("project", workspace.project(input.project, team?.id).id);
      if (input.cycle)
        condition("cycle", workspace.cycle(input.cycle, team?.id).id);
      if (input.priority) condition("priority", input.priority);
      if (input.assignee)
        condition(
          "assignee",
          input.assignee.toLowerCase() === "unassigned"
            ? noneFilterValue
            : workspace.member(input.assignee).id,
        );
      const filters: IssueFilters = {
        query: input.query,
        teamId: team?.id,
        states: input.statusCategories ?? [
          "triage",
          "backlog",
          "ready",
          "active",
          "blocked",
          "review",
        ],
        conditions,
        sort: input.sort,
      };
      if (input.label) {
        if (!team)
          return {
            output: { error: "Filter by team when filtering by label." },
            label: "Searched issues",
          };
        const labels = await session.services.labels.list(
          session.actor,
          team.id,
        );
        const label = labels.find(
          (entry) => entry.name.toLowerCase() === input.label!.toLowerCase(),
        );
        if (!label)
          return {
            output: {
              error: `No label "${input.label}". Labels: ${labels.map((entry) => entry.name).join(", ")}.`,
            },
            label: "Searched issues",
          };
        condition("label", label.id);
      }
      const limit = input.limit ?? 25;
      const issues = await session.services.planning.listIssueSummaries(
        session.actor,
        filters,
        limit + 1,
      );
      return {
        output: {
          issues: issues
            .slice(0, limit)
            .map((issue) => workspace.issueSummary(issue)),
          more: issues.length > limit,
        },
        label: `Found ${Math.min(issues.length, limit)}${issues.length > limit ? "+" : ""} issue${issues.length === 1 ? "" : "s"}${input.query ? ` for “${excerpt(input.query, 40)}”` : ""}`,
      };
    },
  }),
  agentTool({
    name: "get_issue",
    description:
      "Read an issue with its description, acceptance criteria, labels, parent, sub-issues, dependencies, linked GitHub pull requests, attachments, its 12 newest comments, change history and AI tasks. When olderComments is true, read the rest with list_comments. Open an attachment with view_attachment.",
    schema: z.strictObject({ issue: issueReference }),
    async run(session, input) {
      const { actor, services, workspace } = session;
      const issue = await session.resolveIssue(input.issue);
      const [
        labels,
        relations,
        comments,
        history,
        runs,
        milestones,
        pullRequests,
        attachments,
      ] = await Promise.all([
        services.labels.getIssue(actor, issue.id),
        services.relations.list(actor, issue.id),
        services.comments.list(actor, issue.id, null),
        services.planning.history(actor, issue.id),
        services.runs.list(actor, issue.id),
        issue.projectId
          ? services.milestones.list(actor, issue.projectId)
          : Promise.resolve([]),
        services.pullRequests.forIssue(actor, issue.id),
        services.attachments.list(actor, issue.id),
      ]);
      const visibleComments = comments.filter((comment) => !comment.deleted);
      const related = (kind: string) =>
        relations
          .filter((relation) => relation.kind === kind)
          .map((relation) => ({
            identifier: relation.issue.identifier,
            link: `/cloud/issues/${relation.issue.id}`,
            title: relation.issue.title,
            status: relation.issue.statusName,
          }));
      return {
        output: {
          identifier: issue.identifier,
          link: `/cloud/issues/${issue.id}`,
          team: workspace.teamById(issue.teamId)?.key ?? null,
          title: issue.title,
          description: issue.description,
          acceptanceCriteria: issue.acceptanceCriteria,
          status: issue.statusName,
          statusCategory: issue.state,
          priority: issue.priority,
          assignee: workspace.memberName(issue.assigneeId),
          project: workspace.projectName(issue.projectId),
          milestone:
            milestones.find((entry) => entry.id === issue.milestoneId)?.name ??
            null,
          cycle: workspace.cycleName(issue.cycleId),
          estimate: issue.estimate,
          dueOn: issue.dueOn,
          archived: issue.archived,
          labels: labels.labels.map((label) => label.name),
          parent: related("parent")[0] ?? null,
          subIssues: related("child"),
          blocks: related("blocks"),
          blockedBy: related("blocked_by"),
          related: related("related"),
          duplicateOf: related("duplicate_of")[0] ?? null,
          duplicates: related("duplicated_by"),
          comments: visibleComments
            .slice(0, recentCommentCount)
            .reverse()
            .map((comment) => ({
              author: comment.author,
              createdAt: comment.createdAt.slice(0, 16),
              body: excerpt(comment.body, 1200),
            })),
          olderComments: visibleComments.length > recentCommentCount,
          recentChanges: history.slice(0, 10).map((entry) => ({
            actor: entry.actor,
            at: entry.createdAt.slice(0, 16),
            status: entry.statusName,
            assignee: workspace.memberName(entry.snapshot.assigneeId),
            priority: entry.snapshot.priority,
          })),
          pullRequests: pullRequests.map((pullRequest) => ({
            reference: `${pullRequest.repository}#${pullRequest.number}`,
            title: pullRequest.title,
            stage: pullRequest.stage,
            checks: pullRequest.checks,
            review: pullRequest.review,
            branch: pullRequest.headRef,
            base: pullRequest.baseRef,
            mergeableState: pullRequest.mergeableState,
            closesIssue: pullRequest.closes,
            url: pullRequest.url,
          })),
          attachments: attachments.map((attachment) => ({
            attachment: attachment.id,
            name: attachment.name,
            kind: attachment.kind,
            url: attachment.url,
          })),
          aiTasks: runs.slice(0, 3).map((run) => ({
            title: run.title,
            state: run.state,
            createdAt: run.createdAt.slice(0, 10),
            summary: run.summary ? excerpt(run.summary, 400) : null,
          })),
        },
        label: `Read ${issue.identifier}`,
      };
    },
  }),
  agentTool({
    name: "list_comments",
    description:
      "Read an issue's comments with their full Markdown text, newest first. Pass `before` with the `older` value of a previous result to read further back.",
    schema: z.strictObject({
      issue: issueReference,
      before: z.uuid().optional().describe("Comment ID to read before."),
    }),
    async run(session, input) {
      const issue = await session.resolveIssue(input.issue);
      const listed = await session.services.comments.list(
        session.actor,
        issue.id,
        input.before ?? null,
      );
      const comments = listed.filter((comment) => !comment.deleted);
      const page: typeof comments = [];
      let characters = 0;
      for (const comment of comments) {
        if (
          page.length &&
          characters + comment.body.length > commentPageCharacters
        )
          break;
        page.push(comment);
        characters += comment.body.length;
      }
      return {
        output: {
          issue: issue.identifier,
          comments: page.map((comment) => ({
            id: comment.id,
            author: comment.author,
            createdAt: comment.createdAt.slice(0, 16),
            edited: comment.updatedAt !== comment.createdAt,
            body: comment.body.slice(0, commentPageCharacters),
          })),
          older:
            page.length < comments.length || listed.length === commentListLimit
              ? (page.at(-1)?.id ?? null)
              : null,
        },
        label: `Read ${page.length} comment${page.length === 1 ? "" : "s"} on ${issue.identifier}`,
      };
    },
  }),
  agentTool({
    name: "list_projects",
    description:
      "List accessible projects with status, health, lead, dates and issue progress.",
    schema: z.strictObject({
      team: reference.optional().describe("Team key or name."),
      includeClosed: z
        .boolean()
        .optional()
        .describe("Include completed and canceled projects."),
    }),
    async run(session, input) {
      const { workspace } = session;
      const team = input.team ? workspace.team(input.team) : undefined;
      const [progress, updates] = await Promise.all([
        session.services.projects.progress(session.actor),
        session.services.projectUpdates.latest(session.actor),
      ]);
      const projects = workspace.snapshot.projects.filter(
        (project) =>
          (!team || project.teamId === team.id) &&
          (input.includeClosed ||
            !["completed", "canceled"].includes(project.status)),
      );
      return {
        output: projects.map((project) => {
          const counts = progress.find(
            (entry) => entry.projectId === project.id,
          );
          const update = updates.find(
            (entry) => entry.projectId === project.id,
          );
          return {
            name: project.name,
            link: `/cloud/projects/${project.id}`,
            team: workspace.teamById(project.teamId)?.key ?? null,
            status: project.status,
            health: update?.health ?? null,
            lastUpdate: update
              ? `${update.createdAt.slice(0, 10)}: ${excerpt(update.body, 200)}`
              : null,
            lead: workspace.memberName(project.leadId),
            startsOn: project.startsOn,
            targetOn: project.targetOn,
            issues: counts?.total ?? 0,
            completedIssues: counts?.completed ?? 0,
            startedIssues: counts?.started ?? 0,
          };
        }),
        label: `Listed ${projects.length} project${projects.length === 1 ? "" : "s"}`,
      };
    },
  }),
  agentTool({
    name: "get_project",
    description:
      "Read a project with milestones, recent status updates and its open issues.",
    schema: z.strictObject({
      project: reference.describe("Project name or ID."),
    }),
    async run(session, input) {
      const { actor, services, workspace } = session;
      const project = workspace.project(input.project);
      const [detail, milestones, updates, issues] = await Promise.all([
        services.projects.get(actor, project.id),
        services.milestones.list(actor, project.id),
        services.projectUpdates.list(actor, project.id),
        services.planning.listIssueSummaries(
          actor,
          {
            conditions: [
              { field: "project", negated: false, values: [project.id] },
            ],
            sort: "priority",
          },
          40,
        ),
      ]);
      return {
        output: {
          name: detail.name,
          link: `/cloud/projects/${detail.id}`,
          description: excerpt(detail.description, 2000),
          status: detail.status,
          lead: workspace.memberName(detail.leadId),
          startsOn: detail.startsOn,
          targetOn: detail.targetOn,
          milestones: milestones.map((milestone) => ({
            name: milestone.name,
            targetOn: milestone.targetOn,
            completed: milestone.completed,
            openIssues: issues.filter(
              (issue) =>
                issue.milestoneId === milestone.id &&
                !["complete", "canceled"].includes(issue.state),
            ).length,
          })),
          updates: updates.slice(0, 5).map((update) => ({
            health: update.health,
            author: update.author,
            createdAt: update.createdAt.slice(0, 10),
            body: excerpt(update.body, 600),
          })),
          issues: issues.map((issue) => workspace.issueSummary(issue)),
        },
        label: `Read project ${detail.name}`,
      };
    },
  }),
  agentTool({
    name: "list_initiatives",
    description:
      "List initiatives (groups of projects) with status, owner, target date, derived health, issue progress and their projects.",
    schema: z.strictObject({}),
    async run(session) {
      const { workspace } = session;
      const initiatives = await session.services.initiatives.list(
        session.actor,
      );
      return {
        output: initiatives.map((initiative) => ({
          name: initiative.name,
          link: `/cloud/initiatives/${initiative.id}`,
          status: initiative.status,
          owner: workspace.memberName(initiative.ownerId),
          targetOn: initiative.targetOn,
          health: initiative.health,
          issues: initiative.issues,
          completedIssues: initiative.completedIssues,
          projects: initiative.projectIds.map((id) => ({
            name: workspace.projectName(id),
            link: `/cloud/projects/${id}`,
          })),
          description: excerpt(initiative.description, 400),
        })),
        label: `Listed ${initiatives.length} initiative${initiatives.length === 1 ? "" : "s"}`,
      };
    },
  }),
  agentTool({
    name: "list_cycles",
    description: "List accessible cycles with dates, status and capacity.",
    schema: z.strictObject({
      team: reference.optional().describe("Team key or name."),
      status: z.enum(["planned", "active", "closed"]).optional(),
    }),
    async run(session, input) {
      const { workspace } = session;
      const team = input.team ? workspace.team(input.team) : undefined;
      const cycles = workspace.snapshot.cycles.filter(
        (cycle) =>
          (!team || cycle.teamId === team.id) &&
          (input.status
            ? cycle.status === input.status
            : cycle.status !== "closed"),
      );
      return {
        output: cycles.map((cycle) => ({
          name: cycle.name,
          link: `/cloud/cycles/${cycle.id}`,
          team: workspace.teamById(cycle.teamId)?.key ?? null,
          status: cycle.status,
          startsOn: cycle.startsOn,
          endsOn: cycle.endsOn,
          capacity: cycle.capacity,
        })),
        label: `Listed ${cycles.length} cycle${cycles.length === 1 ? "" : "s"}`,
      };
    },
  }),
  agentTool({
    name: "get_cycle",
    description:
      "Read a cycle's scope, committed scope, completion totals and issues.",
    schema: z.strictObject({
      cycle: reference.describe('Cycle name, ID, "current" or "next".'),
      team: reference.optional().describe("Team key or name."),
    }),
    async run(session, input) {
      const { workspace } = session;
      const team = input.team ? workspace.team(input.team) : undefined;
      const cycle = workspace.cycle(input.cycle, team?.id);
      const detail = await session.services.cycles.get(session.actor, cycle.id);
      return {
        output: {
          name: detail.cycle.name,
          link: `/cloud/cycles/${detail.cycle.id}`,
          status: detail.cycle.status,
          startsOn: detail.cycle.startsOn,
          endsOn: detail.cycle.endsOn,
          capacity: detail.cycle.capacity,
          totals: detail.totals,
          committedTotals: detail.committedTotals,
          issues: detail.issues.slice(0, 60).map((issue) => ({
            identifier: issue.identifier,
            link: `/cloud/issues/${issue.id}`,
            title: issue.title,
            status: detail.statusNames[issue.id] ?? issue.state,
            statusCategory: issue.state,
            priority: issue.priority,
            assignee: workspace.memberName(issue.assigneeId),
            estimate: issue.estimate,
          })),
        },
        label: `Read ${detail.cycle.name}`,
      };
    },
  }),
  agentTool({
    name: "get_team",
    description:
      "Read a team's workflow statuses, labels, members and active cycle.",
    schema: z.strictObject({ team: reference.describe("Team key or name.") }),
    async run(session, input) {
      const { workspace } = session;
      const team = workspace.team(input.team);
      const labels = await session.services.labels.list(session.actor, team.id);
      return {
        output: {
          name: team.name,
          key: team.key,
          visibility: team.visibility,
          statuses: workspace.statuses(team.id).map((status) => ({
            name: status.name,
            category: status.category,
          })),
          labels: labels
            .filter((label) => !label.archived)
            .map((label) => label.name),
          estimateScale: team.estimateScale.map((card) => card.label),
          members: workspace.snapshot.members.map((member) => ({
            name: member.name,
            role: member.role,
          })),
          activeCycle:
            workspace.snapshot.cycles.find(
              (cycle) => cycle.teamId === team.id && cycle.status === "active",
            )?.name ?? null,
        },
        label: `Read team ${team.name}`,
      };
    },
  }),
  agentTool({
    name: "ask_user",
    description:
      "Ask the user one clarifying question when the request is ambiguous in a way that changes the answer. Offer 2–6 short answer options. This ends your turn; do not repeat the question in text.",
    schema: z.strictObject({
      question: z.string().trim().min(1).max(300),
      options: z.array(z.string().trim().min(1).max(80)).min(2).max(6),
    }),
    terminal: true,
    async run(_session, input) {
      return {
        output: { asked: true },
        label: "Asked a question",
        question: {
          text: input.question,
          options: [...new Set(input.options)],
        },
      };
    },
  }),
];

const tools = [
  ...readTools,
  ...proposalTools,
  ...releaseTools,
  ...automationTools,
  ...attachmentTools,
  ...clientTools,
];

function schemaDocument(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _, ...document } = z.toJSONSchema(schema, {
    io: "input",
    override: ({ jsonSchema }) => {
      if (jsonSchema.format === "uuid") delete jsonSchema.pattern;
    },
  }) as Record<string, unknown>;
  return document;
}

export const agentToolSpecs: AgentModelToolSpec[] = tools.map((tool) => ({
  name: tool.name,
  description: tool.description,
  inputSchema: schemaDocument(tool.schema),
}));

export interface AgentConversationModel {
  providerId: string;
  model: string;
}

export class CloudAgentSession {
  readonly viewedImages: AgentModelImageInput[] = [];

  constructor(
    readonly services: AgentServices,
    readonly actor: CloudActor,
    readonly workspace: AgentWorkspace,
    readonly model: AgentConversationModel,
  ) {}

  async resolveIssue(referenceValue: string) {
    const value = referenceValue.trim();
    if (z.uuid().safeParse(value).success)
      return this.services.planning.getIssue(this.actor, value);
    const issue = await this.services.planning.findIssue(this.actor, value);
    if (!issue)
      throw new AgentLookupError(
        `No accessible issue is named ${value.toUpperCase()}.`,
      );
    return issue;
  }

  async execute(call: AgentModelToolCall): Promise<AgentToolResult> {
    const tool = tools.find((entry) => entry.name === call.name);
    const step = (label: string, failed: boolean): AgentStep => ({
      id: call.id,
      tool: call.name,
      label,
      failed,
    });
    if (!tool)
      return {
        output: serialize({ error: `Unknown tool ${call.name}.` }),
        isError: true,
        terminal: false,
        step: step(`Unknown tool ${call.name}`, true),
      };
    const input = tool.schema.safeParse(call.arguments);
    if (!input.success || call.argumentError)
      return {
        output: serialize({
          error: "Invalid arguments.",
          issues: input.success
            ? [call.argumentError]
            : input.error.issues.map(
                (issue) =>
                  `${issue.path.join(".") || "input"}: ${issue.message}`,
              ),
        }),
        isError: true,
        terminal: false,
        step: step(`Retried ${tool.name.replaceAll("_", " ")}`, true),
      };
    try {
      const outcome = await tool.run(this, input.data);
      return {
        output: serialize(outcome.output),
        isError: false,
        terminal: tool.terminal === true,
        step: step(outcome.label, false),
        question: outcome.question,
        action: outcome.proposal
          ? ({
              ...outcome.proposal,
              id: randomUUID(),
              state: "pending",
              error: null,
              result: null,
            } as AgentAction)
          : undefined,
      };
    } catch (error) {
      const message = agentFailureMessage(error);
      if (message === null) throw error;
      return {
        output: serialize({ error: message }),
        isError: true,
        terminal: false,
        step: step(message, true),
      };
    }
  }
}

export class CloudAgentTools {
  constructor(private readonly services: AgentServices) {}

  async open(
    actor: CloudActor,
    model: AgentConversationModel,
  ): Promise<CloudAgentSession> {
    return new CloudAgentSession(
      this.services,
      actor,
      new AgentWorkspace(actor, await this.services.planning.workspace(actor)),
      model,
    );
  }
}
