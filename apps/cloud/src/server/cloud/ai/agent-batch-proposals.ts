import { z } from "zod";
import {
  issuePriorities,
  issueStates,
  type CloudIssue,
} from "../../../lib/cloud-contract";
import type { IssueChangeSet } from "../../../lib/cloud-issue-changes-contract";
import type { AgentActionField } from "../../../lib/cloud-chat-contract";
import {
  relationKinds,
  type RelationKind,
} from "../../../lib/cloud-relation-contract";
import { AgentLookupError } from "./agent-workspace";
import { agentTool, type AgentTool } from "./agent-tool";
import type { CloudAgentSession } from "./agent-tools";
import {
  estimateFor,
  issueReference,
  none,
  optionalReference,
  pendingOutput,
  reference,
} from "./agent-proposal-helpers";

const maximumBatch = 50;
const linkableKinds = relationKinds.filter(
  (kind) => kind !== "duplicated_by",
) as Exclude<RelationKind, "duplicated_by">[];

export const relationPhrases: Record<RelationKind, string> = {
  parent: "is a sub-issue of",
  child: "is the parent of",
  blocks: "blocks",
  blocked_by: "is blocked by",
  related: "relates to",
  duplicate_of: "duplicates",
  duplicated_by: "is duplicated by",
};

async function resolveIssues(
  session: CloudAgentSession,
  references: string[],
): Promise<CloudIssue[]> {
  const issues = new Map<string, CloudIssue>();
  for (const value of references) {
    const issue = await session.resolveIssue(value);
    issues.set(issue.id, issue);
  }
  return [...issues.values()];
}

function identifiers(issues: CloudIssue[]): string {
  const names = issues.map((issue) => issue.identifier);
  return names.length > 12
    ? `${names.slice(0, 12).join(", ")} and ${names.length - 12} more`
    : names.join(", ");
}

function singleTeam(issues: CloudIssue[], field: string): string {
  const teams = new Set(issues.map((issue) => issue.teamId));
  if (teams.size !== 1)
    throw new AgentLookupError(
      `These issues belong to ${teams.size} teams, so ${field} cannot be set for all of them at once. Use statusCategory for status, or propose one change per team.`,
    );
  return issues[0]!.teamId;
}

export const issueBatchProposalTools: AgentTool[] = [
  agentTool({
    name: "propose_bulk_update",
    description:
      "Propose the same change for several issues, for example moving them to another status, cycle or project, reassigning them or re-prioritizing them. Status, project, cycle and estimate need issues of one team; statusCategory works across teams. Nothing changes until the user confirms the proposal.",
    schema: z.strictObject({
      issues: z.array(issueReference).min(1).max(maximumBatch),
      status: reference.optional().describe("Status name of the issues' team."),
      statusCategory: z.enum(issueStates).optional(),
      priority: z.enum(issuePriorities).optional(),
      assignee: optionalReference('Member name or "me".'),
      project: optionalReference("Project name or ID."),
      cycle: optionalReference('Cycle name, ID, "current" or "next".'),
      estimate: optionalReference("Estimate from the team scale."),
      dueOn: z
        .union([z.iso.date(), z.literal(none)])
        .optional()
        .describe('Due date, or "none" to clear it.'),
    }),
    async run(session, input) {
      const { workspace } = session;
      const issues = (await resolveIssues(session, input.issues)).filter(
        (issue) => !issue.archived,
      );
      if (!issues.length)
        throw new AgentLookupError("All of these issues are archived.");
      if (input.status && input.statusCategory)
        throw new AgentLookupError(
          "Choose either a status or a status category.",
        );
      const clear = (value: string | undefined) =>
        value?.toLowerCase() === none;
      const changes: IssueChangeSet = {};
      const fields: AgentActionField[] = [
        { label: "Issues", value: identifiers(issues) },
      ];
      if (input.status) {
        const status = workspace.status(
          singleTeam(issues, "a status"),
          input.status,
        );
        changes.status = { id: status.id, revision: status.revision };
        fields.push({ label: "Status", value: status.name });
      }
      if (input.statusCategory) {
        changes.statusCategory = input.statusCategory;
        fields.push({ label: "Status", value: input.statusCategory });
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
          : workspace.project(input.project, singleTeam(issues, "a project"));
        changes.projectId = project?.id ?? null;
        fields.push({ label: "Project", value: project?.name ?? "No project" });
      }
      if (input.cycle !== undefined) {
        const cycle = clear(input.cycle)
          ? null
          : workspace.cycle(input.cycle, singleTeam(issues, "a cycle"));
        changes.cycleId = cycle?.id ?? null;
        fields.push({ label: "Cycle", value: cycle?.name ?? "No cycle" });
      }
      if (input.estimate !== undefined) {
        changes.estimate = clear(input.estimate)
          ? null
          : estimateFor(
              workspace.teamById(singleTeam(issues, "an estimate"))!,
              input.estimate,
            );
        fields.push({
          label: "Estimate",
          value: changes.estimate ?? "Not estimated",
        });
      }
      if (input.dueOn !== undefined) {
        changes.dueOn = input.dueOn === none ? null : input.dueOn;
        fields.push({ label: "Due", value: changes.dueOn ?? "No due date" });
      }
      if (fields.length === 1)
        throw new AgentLookupError("Propose at least one change.");
      return {
        output: pendingOutput,
        label: `Proposed changes to ${issues.length} issue${issues.length === 1 ? "" : "s"}`,
        proposal: {
          kind: "update_issues",
          title: `Update ${issues.length} issue${issues.length === 1 ? "" : "s"}`,
          fields,
          issueIds: issues.map((issue) => issue.id),
          identifiers: issues.map((issue) => issue.identifier),
          changes,
        },
      };
    },
  }),
  agentTool({
    name: "propose_archive_issues",
    description:
      "Propose removing issues by archiving them, or restoring archived issues with restore=true. Archived issues leave boards, lists and cycles but keep their history. Nothing changes until the user confirms the proposal.",
    schema: z.strictObject({
      issues: z.array(issueReference).min(1).max(maximumBatch),
      restore: z.boolean().optional(),
    }),
    async run(session, input) {
      const restore = input.restore === true;
      const issues = (await resolveIssues(session, input.issues)).filter(
        (issue) => issue.archived === restore,
      );
      if (!issues.length)
        throw new AgentLookupError(
          restore
            ? "None of these issues are archived."
            : "These issues are already archived.",
        );
      const verb = restore ? "Restore" : "Archive";
      const subject =
        issues.length === 1
          ? `${issues[0]!.identifier} · ${issues[0]!.title}`
          : `${issues.length} issues`;
      return {
        output: pendingOutput,
        label: `Proposed to ${verb.toLowerCase()} ${subject}`,
        proposal: {
          kind: "update_issues",
          title: `${verb} ${subject}`,
          fields:
            issues.length === 1
              ? []
              : [{ label: "Issues", value: identifiers(issues) }],
          issueIds: issues.map((issue) => issue.id),
          identifiers: issues.map((issue) => issue.identifier),
          changes: { archived: !restore },
        },
      };
    },
  }),
  agentTool({
    name: "propose_link",
    description:
      "Propose linking two issues (sub-issue, blocking, related or duplicate) or removing such a link with remove=true. relation describes the first issue: issue blocks target, issue is a sub-issue of target (parent), and so on. Nothing changes until the user confirms the proposal.",
    schema: z.strictObject({
      issue: issueReference,
      relation: z.enum(linkableKinds),
      target: issueReference,
      remove: z.boolean().optional(),
    }),
    async run(session, input) {
      const issue = await session.resolveIssue(input.issue);
      const target = await session.resolveIssue(input.target);
      if (issue.id === target.id)
        throw new AgentLookupError("Link two different issues.");
      const sentence = `${issue.identifier} ${relationPhrases[input.relation]} ${target.identifier}`;
      let relationId: string | null = null;
      if (input.remove) {
        const existing = (
          await session.services.relations.list(session.actor, issue.id)
        ).find(
          (relation) =>
            relation.kind === input.relation && relation.issue.id === target.id,
        );
        if (!existing)
          throw new AgentLookupError(`There is no link where ${sentence}.`);
        relationId = existing.id;
      } else if (issue.archived || target.archived)
        throw new AgentLookupError(
          "Restore archived issues before linking them.",
        );
      return {
        output: pendingOutput,
        label: `Proposed to ${input.remove ? "remove the link" : "link"} ${issue.identifier} and ${target.identifier}`,
        proposal: {
          kind: "link",
          title: `${input.remove ? "Remove link" : "Link"} · ${sentence}`,
          fields: [
            { label: issue.identifier, value: issue.title },
            { label: target.identifier, value: target.title },
          ],
          issueId: issue.id,
          identifier: issue.identifier,
          targetId: target.id,
          targetIdentifier: target.identifier,
          relation: input.relation,
          relationId,
        },
      };
    },
  }),
];
