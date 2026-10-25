import { z } from "zod";
import {
  relationInputSchema,
  childIssueInputSchema,
} from "../../../lib/cloud-relation-contract";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  cloudId,
  revision,
  issueInputSchema,
  issueUpdateSchema,
  projectInputSchema,
  projectUpdateSchema,
  cycleInputSchema,
  pokerInputSchema,
  pokerCommandSchema,
  pokerVoteSchema,
  type CloudActor,
} from "../../../lib/cloud-contract";
import {
  commentInputSchema,
  commentUpdateSchema,
} from "../../../lib/cloud-comment-contract";
import { cycleCommandSchema } from "../../../lib/cloud-cycle-contract";
import {
  scheduleListSchema,
  scheduleHistorySchema,
} from "../../../lib/cloud-schedule-contract";
import {
  labelInputSchema,
  labelUpdateSchema,
  issueLabelsUpdateSchema,
} from "../../../lib/cloud-label-contract";
import { runInputSchema } from "@machdoch/fleet-protocol/cloud-execution";
import type { CloudOAuthScope } from "../../../lib/cloud-oauth-contract";
import type { CloudRuntime } from "../runtime";
import {
  recurrencePreviewSchema,
  recurrencePreviewDocumentation,
} from "../../../lib/cloud-recurrence-contract";

export interface CloudMcpTool {
  definition: Tool;
  scope: CloudOAuthScope;
  call: (actor: CloudActor, input: unknown) => Promise<unknown>;
}
export function cloudMcpTools(runtime: CloudRuntime): CloudMcpTool[] {
  const tools: CloudMcpTool[] = [];
  function add<T>(
    name: string,
    description: string,
    scope: CloudOAuthScope,
    schema: z.ZodType<T>,
    call: (actor: CloudActor, input: T) => Promise<unknown>,
    documentation: z.ZodType = schema,
  ) {
    tools.push({
      scope,
      definition: {
        name,
        description,
        inputSchema: z.toJSONSchema(documentation, {
          io: "input",
        }) as Tool["inputSchema"],
        annotations: {
          readOnlyHint: scope === "cloud:read",
          destructiveHint: scope !== "cloud:read",
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      call: (actor, input) => call(actor, schema.parse(input)),
    });
  }
  const empty = z.strictObject({});
  const id = z.strictObject({ id: cloudId });
  const command = {
    commandId: cloudId.describe(
      "Generate one UUID for this action; reuse it only when retrying identical arguments.",
    ),
  };
  add(
    "get_issue_relations",
    "Read accessible parent, sub-issue, dependency and related links. Private links are omitted.",
    "cloud:read",
    id,
    (a, i) => runtime.relations.list(a, i.id),
  );
  add(
    "add_issue_relation",
    "Link two accessible issues using their current revisions. Parent means the target is the parent; child means the target is a sub-issue.",
    "cloud:write",
    z.strictObject({ ...command, id: cloudId, relation: relationInputSchema }),
    (a, i) => runtime.relations.add(a, i.commandId, i.id, i.relation),
  );
  add(
    "remove_issue_relation",
    "Remove an accessible issue link by its immutable ID.",
    "cloud:write",
    z.strictObject({ ...command, id: cloudId, relationId: cloudId }),
    (a, i) => runtime.relations.remove(a, i.commandId, i.id, i.relationId),
  );
  add(
    "create_sub_issue",
    "Create an issue and attach it to its parent atomically using the parent's current revision.",
    "cloud:write",
    z.strictObject({
      ...command,
      parentId: cloudId,
      child: childIssueInputSchema,
    }),
    (a, i) =>
      runtime.relations.createChild(a, i.commandId, i.parentId, i.child),
  );
  add(
    "get_workspace",
    "List accessible teams, workflows, members, projects, and cycles.",
    "cloud:read",
    empty,
    (a) => runtime.planning.workspace(a),
  );
  add(
    "get_team_workflow",
    "Read a team's ordered statuses, semantic categories, default status and current status revisions. Use a status ID and revision when creating or updating an issue.",
    "cloud:read",
    z.strictObject({ teamId: cloudId }),
    (a, i) => runtime.workflows.get(a, i.teamId),
  );
  add(
    "preview_recurrence",
    "Calculate upcoming occurrences using the supplied recurrence and calendar snapshot.",
    "cloud:read",
    recurrencePreviewSchema,
    (actor, input) => runtime.recurrence.preview(actor, input),
    recurrencePreviewDocumentation,
  );
  add(
    "list_schedules",
    "List accessible recurring schedules, up to 200 per page; use offset for more.",
    "cloud:read",
    scheduleListSchema,
    (actor, input) => runtime.schedules.list(actor, input),
  );
  add(
    "get_schedule",
    "Read a schedule, its owner, revision and next occurrence.",
    "cloud:read",
    id,
    (actor, input) => runtime.schedules.get(actor, input.id),
  );
  add(
    "schedule_history",
    "Read 100 schedule occurrences with task usage. Pass the last at/revision as beforeAt/beforeRevision for earlier history.",
    "cloud:read",
    scheduleHistorySchema.safeExtend({ id: cloudId }),
    (actor, input) => runtime.schedules.history(actor, input.id, input),
  );
  add(
    "list_issues",
    "Search accessible issues. Returns up to 100; use offset for subsequent pages.",
    "cloud:read",
    z.strictObject({
      teamId: cloudId.optional(),
      projectId: cloudId.optional(),
      cycleId: cloudId.optional(),
      labelId: cloudId.optional(),
      statusId: cloudId.optional(),
      query: z.string().max(200).optional(),
      archived: z.boolean().optional(),
      offset: z.number().int().min(0).max(1_000_000).optional(),
    }),
    (a, i) => runtime.planning.listIssues(a, i),
  );
  add(
    "get_issue",
    "Read an issue and its revision.",
    "cloud:read",
    id,
    (a, i) => runtime.planning.getIssue(a, i.id),
  );
  add(
    "list_labels",
    "List a team's labels, including archived labels.",
    "cloud:read",
    z.strictObject({ teamId: cloudId }),
    (a, i) => runtime.labels.list(a, i.teamId),
  );
  add(
    "create_label",
    "Create a label in an accessible team.",
    "cloud:write",
    z.strictObject({ ...command, teamId: cloudId, label: labelInputSchema }),
    (a, i) => runtime.labels.create(a, i.commandId, i.teamId, i.label),
  );
  add(
    "update_label",
    "Rename, recolor, archive or restore a label using its current revision.",
    "cloud:write",
    z.strictObject({ ...command, id: cloudId, label: labelUpdateSchema }),
    (a, i) => runtime.labels.update(a, i.commandId, i.id, i.label),
  );
  add(
    "get_issue_labels",
    "Read an issue's labels and their assignment revision.",
    "cloud:read",
    id,
    (a, i) => runtime.labels.getIssue(a, i.id),
  );
  add(
    "set_issue_labels",
    "Replace an issue's labels using its current label-assignment revision.",
    "cloud:write",
    z.strictObject({
      ...command,
      id: cloudId,
      labels: issueLabelsUpdateSchema,
    }),
    (a, i) => runtime.labels.setIssue(a, i.commandId, i.id, i.labels),
  );
  add(
    "get_issue_history",
    "Read an issue's change history.",
    "cloud:read",
    id,
    (a, i) => runtime.planning.history(a, i.id),
  );
  add(
    "create_issue",
    "Create an issue. Omit status to use the team default, or supply a current status ID and revision from get_team_workflow.",
    "cloud:write",
    z.strictObject({ ...command, issue: issueInputSchema }),
    (a, i) => runtime.planning.createIssue(a, i.commandId, i.issue),
  );
  add(
    "update_issue",
    "Update an issue using its current issue revision and status reference. Read get_issue and get_team_workflow before changing status; reload after a conflict.",
    "cloud:write",
    z.strictObject({ ...command, id: cloudId, issue: issueUpdateSchema }),
    (a, i) => runtime.planning.updateIssue(a, i.commandId, i.id, i.issue),
  );
  add(
    "create_project",
    "Create a project in an accessible team.",
    "cloud:write",
    z.strictObject({ ...command, project: projectInputSchema }),
    (a, i) => runtime.projects.create(a, i.commandId, i.project),
  );
  add(
    "get_project",
    "Read a project and its revision.",
    "cloud:read",
    id,
    (a, i) => runtime.projects.get(a, i.id),
  );
  add(
    "update_project",
    "Update a project using its current revision. Reload after a revision conflict.",
    "cloud:write",
    z.strictObject({ ...command, id: cloudId, project: projectUpdateSchema }),
    (a, i) => runtime.projects.update(a, i.commandId, i.id, i.project),
  );
  add(
    "create_cycle",
    "Create a cycle.",
    "cloud:write",
    z.strictObject({ ...command, cycle: cycleInputSchema }),
    (a, i) => runtime.planning.createCycle(a, i.commandId, i.cycle),
  );
  add(
    "get_cycle",
    "Read cycle scope, commitment, and progress.",
    "cloud:read",
    id,
    (a, i) => runtime.cycles.get(a, i.id),
  );
  add(
    "change_cycle",
    "Start or close a cycle with the current revision.",
    "cloud:write",
    z.strictObject({ ...command, id: cloudId, change: cycleCommandSchema }),
    (a, i) => runtime.cycles.act(a, i.commandId, i.id, i.change),
  );
  add(
    "list_comments",
    "Read issue comments. Pass the oldest returned ID as before for older comments.",
    "cloud:read",
    z.strictObject({
      issueId: cloudId,
      before: cloudId.nullable().default(null),
    }),
    (a, i) => runtime.comments.list(a, i.issueId, i.before),
  );
  add(
    "create_comment",
    "Add a comment to an issue.",
    "cloud:write",
    z.strictObject({
      ...command,
      issueId: cloudId,
      comment: commentInputSchema,
    }),
    (a, i) =>
      runtime.comments.create(a, i.commandId, i.issueId, i.comment.body),
  );
  add(
    "update_comment",
    "Edit your comment or remove a comment when your role allows it.",
    "cloud:write",
    z.strictObject({ ...command, id: cloudId, comment: commentUpdateSchema }),
    (a, i) => runtime.comments.update(a, i.commandId, i.id, i.comment),
  );
  add(
    "list_poker",
    "List an issue's planning poker rounds.",
    "cloud:read",
    z.strictObject({ issueId: cloudId }),
    (a, i) => runtime.poker.list(a, i.issueId),
  );
  add(
    "get_poker",
    "Read a poker round. Unrevealed votes remain private.",
    "cloud:read",
    id,
    (a, i) => runtime.poker.get(a, i.id),
  );
  add(
    "create_poker",
    "Start planning poker for an issue at its current revision.",
    "cloud:write",
    z.strictObject({ ...command, round: pokerInputSchema }),
    (a, i) =>
      runtime.poker.create(
        a,
        i.commandId,
        i.round.issueId,
        i.round.issueRevision,
      ),
  );
  add(
    "vote_poker",
    "Cast your planning poker vote.",
    "cloud:write",
    z.strictObject({ ...command, id: cloudId, vote: pokerVoteSchema }),
    (a, i) =>
      runtime.poker.vote(a, i.commandId, i.id, i.vote.revision, i.vote.card),
  );
  add(
    "change_poker",
    "Reveal, restart, or decide a round when your role allows it.",
    "cloud:write",
    z.strictObject({ ...command, id: cloudId, change: pokerCommandSchema }),
    (a, i) => runtime.poker.act(a, i.commandId, i.id, i.change),
  );
  add(
    "list_execution_profiles",
    "Read configured execution profiles.",
    "cloud:read",
    z.strictObject({ projectId: cloudId.optional() }),
    (a, i) => runtime.execution.profiles.list(a, i.projectId),
  );
  add(
    "list_runs",
    "Read recent AI task runs, optionally for an issue.",
    "cloud:read",
    z.strictObject({ issueId: cloudId.optional() }),
    (a, i) => runtime.execution.runs.list(a, i.issueId),
  );
  add(
    "get_run",
    "Read a task's status, attempt, and result.",
    "cloud:read",
    id,
    (a, i) => runtime.execution.runs.get(a, i.id),
  );
  add(
    "start_run",
    "Queue an AI task using a configured execution profile. May consume provider budget when a worker accepts it.",
    "cloud:execute",
    z.strictObject({ ...command, run: runInputSchema }),
    (a, i) => runtime.execution.runs.create(a, i.commandId, i.run),
  );
  add(
    "cancel_run",
    "Request task cancellation at its current revision.",
    "cloud:execute",
    z.strictObject({ ...command, id: cloudId, revision }),
    (a, i) => runtime.execution.runs.cancel(a, i.commandId, i.id, i.revision),
  );
  return tools;
}
