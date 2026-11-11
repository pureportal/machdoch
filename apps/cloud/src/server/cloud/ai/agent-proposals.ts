import { z } from "zod";
import {
  issuePriorities,
  type CloudTeam,
  type IssueInput,
} from "../../../lib/cloud-contract";
import type { IssueChangeSet } from "../../../lib/cloud-issue-changes-contract";
import type { AgentActionField } from "../../../lib/cloud-chat-contract";
import {
  projectHealthLabels,
  projectHealths,
} from "../../../lib/cloud-project-update-contract";
import { AgentLookupError } from "./agent-workspace";
import { agentTool, type AgentTool } from "./agent-tool";
import type { CloudAgentSession } from "./agent-tools";

const reference = z.string().trim().min(1).max(120);
const issueReference = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .describe("Issue identifier such as ENG-42, or the issue ID.");
const none = "none";
const optionalReference = (description: string) =>
  reference.optional().describe(`${description} Use "none" to clear it.`);
const pendingOutput = {
  proposed: true,
  note: "Recorded as a proposal. The user must confirm it before anything changes.",
};

function estimateFor(team: CloudTeam, estimate: string): string {
  const card = team.estimateScale.find(
    (entry) => entry.label.toLowerCase() === estimate.toLowerCase(),
  );
  if (!card)
    throw new AgentLookupError(
      `Estimate "${estimate}" is not on the ${team.key} scale: ${team.estimateScale.map((entry) => entry.label).join(", ")}.`,
    );
  return card.label;
}

async function labelIdsFor(
  session: CloudAgentSession,
  team: CloudTeam,
  names: string[],
) {
  const labels = (
    await session.services.labels.list(session.actor, team.id)
  ).filter((label) => !label.archived);
  return names.map((name) => {
    const label = labels.find(
      (entry) => entry.name.toLowerCase() === name.toLowerCase(),
    );
    if (!label)
      throw new AgentLookupError(
        `No label "${name}" in ${team.key}. Labels: ${labels.map((entry) => entry.name).join(", ") || "none"}.`,
      );
    return label;
  });
}

async function milestoneFor(
  session: CloudAgentSession,
  projectId: string | null,
  name: string,
) {
  if (!projectId)
    throw new AgentLookupError("Choose a project before choosing a milestone.");
  const milestones = await session.services.milestones.list(
    session.actor,
    projectId,
  );
  const milestone = milestones.find(
    (entry) =>
      entry.id === name || entry.name.toLowerCase() === name.toLowerCase(),
  );
  if (!milestone)
    throw new AgentLookupError(
      `No milestone "${name}" in this project. Milestones: ${milestones.map((entry) => entry.name).join(", ") || "none"}.`,
    );
  return milestone;
}

function field(label: string, value: string | null | undefined) {
  return value ? [{ label, value }] : [];
}

export const proposalTools: AgentTool[] = [
  agentTool({
    name: "propose_issue",
    description:
      "Propose a new issue. Nothing is created until the user confirms the proposal in the conversation.",
    schema: z.strictObject({
      team: reference.describe("Team key or name."),
      title: z.string().trim().min(1).max(300),
      description: z.string().max(30_000).optional(),
      status: reference.optional().describe("Status name or category."),
      priority: z.enum(issuePriorities).optional(),
      assignee: reference.optional().describe('Member name or "me".'),
      project: reference.optional().describe("Project name or ID."),
      milestone: reference
        .optional()
        .describe("Milestone of the chosen project."),
      cycle: reference
        .optional()
        .describe('Cycle name, ID, "current" or "next".'),
      estimate: z.string().trim().max(16).optional(),
      dueOn: z.iso.date().optional(),
      labels: z.array(reference).max(10).optional(),
      parent: issueReference.optional().describe("Parent issue."),
    }),
    async run(session, input) {
      const { workspace } = session;
      const team = workspace.team(input.team);
      const status = input.status
        ? workspace.status(team.id, input.status)
        : undefined;
      const assignee = input.assignee
        ? workspace.member(input.assignee)
        : undefined;
      const project = input.project
        ? workspace.project(input.project, team.id)
        : undefined;
      const cycle = input.cycle
        ? workspace.cycle(input.cycle, team.id)
        : undefined;
      const milestone = input.milestone
        ? await milestoneFor(session, project?.id ?? null, input.milestone)
        : undefined;
      const estimate = input.estimate
        ? estimateFor(team, input.estimate)
        : null;
      const labels = await labelIdsFor(session, team, input.labels ?? []);
      const parent = input.parent
        ? await session.resolveIssue(input.parent)
        : undefined;
      if (parent && parent.teamId !== team.id)
        throw new AgentLookupError(
          `${parent.identifier} belongs to another team; a sub-issue must use the parent's team.`,
        );
      const issue: IssueInput = {
        teamId: team.id,
        title: input.title,
        description: input.description ?? "",
        acceptanceCriteria: "",
        status: status ? { id: status.id, revision: status.revision } : null,
        priority: input.priority ?? "none",
        projectId: project?.id ?? null,
        milestoneId: milestone?.id ?? null,
        cycleId: cycle?.id ?? null,
        assigneeId: assignee?.id ?? null,
        estimate,
        dueOn: input.dueOn ?? null,
      };
      const fields: AgentActionField[] = [
        { label: "Team", value: team.name },
        ...field("Status", status?.name),
        ...field("Priority", input.priority !== "none" ? input.priority : null),
        ...field("Assignee", assignee?.name),
        ...field("Project", project?.name),
        ...field("Milestone", milestone?.name),
        ...field("Cycle", cycle?.name),
        ...field("Estimate", estimate),
        ...field("Due", input.dueOn),
        ...field("Labels", labels.map((label) => label.name).join(", ")),
        ...field("Parent", parent?.identifier),
      ];
      return {
        output: pendingOutput,
        label: `Proposed issue “${input.title.slice(0, 60)}”`,
        proposal: {
          kind: "create_issue",
          title: input.title,
          fields,
          issue,
          labelIds: labels.map((label) => label.id),
          parentId: parent?.id ?? null,
        },
      };
    },
  }),
  agentTool({
    name: "propose_issue_update",
    description:
      "Propose changes to an existing issue. Read the issue first. Nothing changes until the user confirms the proposal.",
    schema: z.strictObject({
      issue: issueReference,
      title: z.string().trim().min(1).max(300).optional(),
      description: z.string().max(30_000).optional(),
      status: reference.optional().describe("Status name or category."),
      priority: z.enum(issuePriorities).optional(),
      assignee: optionalReference('Member name or "me".'),
      project: optionalReference("Project name or ID."),
      milestone: optionalReference("Milestone of the issue's project."),
      cycle: optionalReference('Cycle name, ID, "current" or "next".'),
      estimate: optionalReference("Estimate from the team scale."),
      dueOn: z
        .union([z.iso.date(), z.literal(none)])
        .optional()
        .describe('Due date, or "none" to clear it.'),
    }),
    async run(session, input) {
      const { workspace } = session;
      const issue = await session.resolveIssue(input.issue);
      const team = workspace.teamById(issue.teamId)!;
      const changes: IssueChangeSet = {};
      const fields: AgentActionField[] = [];
      const clear = (value: string | undefined) =>
        value?.toLowerCase() === none;
      if (input.title !== undefined) {
        changes.title = input.title;
        fields.push({ label: "Title", value: input.title });
      }
      if (input.description !== undefined) {
        changes.description = input.description;
        fields.push({ label: "Description", value: "Updated" });
      }
      if (input.status) {
        const status = workspace.status(team.id, input.status);
        changes.status = { id: status.id, revision: status.revision };
        fields.push({ label: "Status", value: status.name });
      }
      if (input.priority) {
        changes.priority = input.priority;
        fields.push({ label: "Priority", value: input.priority });
      }
      if (input.assignee !== undefined) {
        const assignee = clear(input.assignee)
          ? null
          : workspace.member(input.assignee);
        changes.assigneeId = assignee?.id ?? null;
        fields.push({
          label: "Assignee",
          value: assignee?.name ?? "Unassigned",
        });
      }
      if (input.project !== undefined) {
        const project = clear(input.project)
          ? null
          : workspace.project(input.project, team.id);
        changes.projectId = project?.id ?? null;
        fields.push({ label: "Project", value: project?.name ?? "No project" });
      }
      if (input.milestone !== undefined) {
        const projectId =
          changes.projectId === undefined ? issue.projectId : changes.projectId;
        const milestone = clear(input.milestone)
          ? null
          : await milestoneFor(session, projectId, input.milestone);
        changes.milestoneId = milestone?.id ?? null;
        fields.push({
          label: "Milestone",
          value: milestone?.name ?? "No milestone",
        });
      }
      if (input.cycle !== undefined) {
        const cycle = clear(input.cycle)
          ? null
          : workspace.cycle(input.cycle, team.id);
        changes.cycleId = cycle?.id ?? null;
        fields.push({ label: "Cycle", value: cycle?.name ?? "No cycle" });
      }
      if (input.estimate !== undefined) {
        changes.estimate = clear(input.estimate)
          ? null
          : estimateFor(team, input.estimate);
        fields.push({
          label: "Estimate",
          value: changes.estimate ?? "Not estimated",
        });
      }
      if (input.dueOn !== undefined) {
        changes.dueOn = input.dueOn === none ? null : input.dueOn;
        fields.push({ label: "Due", value: changes.dueOn ?? "No due date" });
      }
      if (!fields.length)
        throw new AgentLookupError("Propose at least one change.");
      return {
        output: pendingOutput,
        label: `Proposed changes to ${issue.identifier}`,
        proposal: {
          kind: "update_issue",
          title: `Update ${issue.identifier} · ${issue.title}`,
          fields,
          issueId: issue.id,
          identifier: issue.identifier,
          revision: issue.revision,
          changes,
        },
      };
    },
  }),
  agentTool({
    name: "propose_comment",
    description:
      "Draft a comment on an issue. It is posted under the user's name only after the user confirms it.",
    schema: z.strictObject({
      issue: issueReference,
      body: z.string().trim().min(1).max(20_000),
    }),
    async run(session, input) {
      const issue = await session.resolveIssue(input.issue);
      return {
        output: pendingOutput,
        label: `Drafted a comment on ${issue.identifier}`,
        proposal: {
          kind: "comment",
          title: `Comment on ${issue.identifier} · ${issue.title}`,
          fields: [{ label: "Comment", value: input.body }],
          issueId: issue.id,
          identifier: issue.identifier,
          body: input.body,
        },
      };
    },
  }),
  agentTool({
    name: "propose_triage",
    description:
      "Propose settling an issue that is in triage: accept it into an open status, decline it with a reason, or mark it as a duplicate of an existing issue. Search for likely duplicates first. Nothing changes until the user confirms the proposal.",
    schema: z.strictObject({
      issue: issueReference,
      decision: z.enum(["accept", "decline", "duplicate"]),
      status: reference
        .optional()
        .describe(
          "Status to accept into; defaults to the team's first open status.",
        ),
      duplicateOf: issueReference
        .optional()
        .describe("Existing issue that this one duplicates."),
      reason: z
        .string()
        .trim()
        .max(20_000)
        .optional()
        .describe("Comment posted when declining."),
    }),
    async run(session, input) {
      const issue = await session.resolveIssue(input.issue);
      if (issue.state !== "triage" || issue.archived)
        throw new AgentLookupError(`${issue.identifier} is not in triage.`);
      const proposal = {
        kind: "triage" as const,
        title: `Triage ${issue.identifier} · ${issue.title}`,
        issueId: issue.id,
        identifier: issue.identifier,
      };
      if (input.decision === "duplicate") {
        if (!input.duplicateOf)
          throw new AgentLookupError(
            "Name the issue that this one duplicates.",
          );
        const original = await session.resolveIssue(input.duplicateOf);
        if (original.id === issue.id)
          throw new AgentLookupError(
            "Choose a different issue as the original.",
          );
        return {
          output: pendingOutput,
          label: `Proposed marking ${issue.identifier} as a duplicate`,
          proposal: {
            ...proposal,
            fields: [
              {
                label: "Duplicate of",
                value: `${original.identifier} ${original.title}`,
              },
            ],
            decision: {
              decision: "duplicate",
              revision: issue.revision,
              duplicateOfId: original.id,
            },
          },
        };
      }
      if (input.decision === "decline")
        return {
          output: pendingOutput,
          label: `Proposed declining ${issue.identifier}`,
          proposal: {
            ...proposal,
            fields: [
              { label: "Decision", value: "Decline" },
              ...field("Reason", input.reason),
            ],
            decision: {
              decision: "decline",
              revision: issue.revision,
              reason: input.reason ?? "",
            },
          },
        };
      const status = input.status
        ? session.workspace.status(issue.teamId, input.status)
        : null;
      if (status?.category === "triage")
        throw new AgentLookupError("Choose a status outside triage.");
      return {
        output: pendingOutput,
        label: `Proposed accepting ${issue.identifier}`,
        proposal: {
          ...proposal,
          fields: [
            { label: "Decision", value: "Accept" },
            ...field("Status", status?.name),
          ],
          decision: {
            decision: "accept",
            revision: issue.revision,
            status: status
              ? { id: status.id, revision: status.revision }
              : null,
          },
        },
      };
    },
  }),
  agentTool({
    name: "propose_project_update",
    description:
      "Draft a project status update with its health. It is posted under the user's name only after the user confirms it. Read the project first.",
    schema: z.strictObject({
      project: reference.describe("Project name or ID."),
      health: z.enum(projectHealths),
      body: z.string().trim().min(1).max(20_000),
    }),
    async run(session, input) {
      const project = session.workspace.project(input.project);
      return {
        output: pendingOutput,
        label: `Drafted an update for ${project.name}`,
        proposal: {
          kind: "project_update",
          title: `Update for ${project.name}`,
          fields: [
            { label: "Health", value: projectHealthLabels[input.health] },
            { label: "Update", value: input.body },
          ],
          projectId: project.id,
          projectName: project.name,
          health: input.health,
          body: input.body,
        },
      };
    },
  }),
];
