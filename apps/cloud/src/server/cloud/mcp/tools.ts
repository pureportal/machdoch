import { z } from "zod";
import {
  relationInputSchema,
  childIssueInputSchema,
} from "../../../lib/cloud-relation-contract";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { CloudPermission } from "../../../lib/cloud-permissions";
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
import { projectUpdateInputSchema } from "../../../lib/cloud-project-update-contract";
import {
  initiativeInputSchema,
  initiativeUpdateSchema,
} from "../../../lib/cloud-initiative-contract";
import { triageDecisionSchema } from "../../../lib/cloud-triage-contract";
import { issueChangesSchema } from "../../../lib/cloud-issue-changes-contract";
import { chatMessageSchema } from "../../../lib/cloud-chat-contract";
import {
  postStateSchema,
  postUpdateSchema,
  releaseInputSchema,
  releaseLaunchSchema,
  releaseWriteSchema,
} from "../../../lib/cloud-release-contract";
import { visualInputSchema } from "../../../lib/cloud-release-media-contract";
import {
  gitCommentInputSchema,
  gitMergeInputSchema,
  gitRetargetInputSchema,
  gitReviewInputSchema,
  gitUpdateBranchInputSchema,
  pullRequestListQuerySchema,
} from "../../../lib/cloud-git-contract";
import { automationMarker } from "../../../lib/git-events";
import { issueFilterConditionSchema } from "../../../lib/issue-filter-model";
import { issueIdentifierFormat } from "../../../lib/issue-links";
import { CloudError } from "../access";
import type { CloudRuntime } from "../runtime";
import {
  recurrencePreviewSchema,
  recurrencePreviewDocumentation,
} from "../../../lib/cloud-recurrence-contract";

export interface CloudMcpTool {
  definition: Tool;
  scope: CloudOAuthScope;
  permission: CloudPermission | null;
  call: (actor: CloudActor, input: unknown) => Promise<unknown>;
}

const toolPermissions: Partial<Record<string, CloudPermission>> = {
  get_issue_pull_requests: "git.view",
  list_pull_requests: "git.view",
  get_pull_request: "git.view",
  get_pull_request_files: "git.view",
  update_pull_request_branch: "git.act",
  merge_pull_request: "git.act",
  comment_on_pull_request: "git.act",
  review_pull_request: "git.act",
  retarget_pull_request: "git.act",
  add_issue_relation: "issues.edit",
  remove_issue_relation: "issues.edit",
  create_sub_issue: "issues.edit",
  change_issues: "issues.edit",
  create_label: "issues.edit",
  update_label: "issues.edit",
  set_issue_labels: "issues.edit",
  create_issue: "issues.edit",
  update_issue: "issues.edit",
  decide_triage: "issues.edit",
  create_poker: "issues.edit",
  vote_poker: "issues.edit",
  change_poker: "issues.edit",
  create_project: "planning.edit",
  update_project: "planning.edit",
  create_initiative: "planning.edit",
  update_initiative: "planning.edit",
  create_project_update: "planning.edit",
  create_cycle: "planning.edit",
  change_cycle: "planning.edit",
  create_comment: "comments.write",
  update_comment: "comments.write",
  start_run: "ai.tasks",
  cancel_run: "ai.tasks",
  run_automation: "automations.edit",
  ask_agent: "ai.chat",
  apply_agent_proposal: "ai.chat",
  list_agent_models: "ai.chat",
  list_products: "releases.view",
  list_releases: "releases.view",
  get_release: "releases.view",
  create_release: "releases.edit",
  update_release_post: "releases.edit",
  change_release_post: "releases.edit",
  launch_release: "releases.edit",
  create_release_visual: "releases.edit",
  write_release_content: "releases.edit",
  list_roles: "members.manage",
};
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
      permission: toolPermissions[name] ?? null,
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
  const issueIdentifier = z
    .string()
    .trim()
    .regex(issueIdentifierFormat, "Use an identifier such as PLAT-12.");
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
    "get_my_access",
    "Read your role, whether you see the whole organization or only assigned teams, your permissions and the teams you can see. Tools you lack permission for are not listed.",
    "cloud:read",
    empty,
    (a) => runtime.roles.mine(a),
  );
  add(
    "list_roles",
    "List the organization's roles with their permissions, scope and member counts.",
    "cloud:read",
    empty,
    (a) => runtime.roles.list(a),
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
    'Search accessible issues. Each condition matches any of its values; negated conditions exclude them. Values are IDs, priorities, "me", "none", estimate none/set, due overdue/week/month/none or created day/week/month. Returns up to 100; use offset for subsequent pages.',
    "cloud:read",
    z.strictObject({
      teamId: cloudId.optional(),
      conditions: z.array(issueFilterConditionSchema).max(20).optional(),
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
    "get_issue_pull_requests",
    "List the GitHub pull requests and GitLab merge requests linked to an issue by branch name, title or closing words.",
    "cloud:read",
    id,
    (a, i) => runtime.git.pullRequests.forIssue(a, i.id),
  );
  add(
    "list_pull_requests",
    "List open and recently closed pull requests and merge requests of connected repositories, with their stack (the pull request each one is based on and the ones based on it), optionally for one stage: attention (conflicts, failing checks or requested changes), ready, review, draft, merged or closed.",
    "cloud:read",
    pullRequestListQuerySchema,
    (a, i) => runtime.git.pullRequests.list(a, i.stage),
  );
  add(
    "get_pull_request",
    "Read a pull request or merge request with its mergeability, check runs, reviews, code review comments, stack and linked issues.",
    "cloud:read",
    id,
    (a, i) => runtime.git.pullRequests.details(a, i.id),
  );
  add(
    "get_pull_request_files",
    "Read the changed files of a pull request with their patches.",
    "cloud:read",
    id,
    (a, i) => runtime.git.pullRequests.files(a, i.id),
  );
  add(
    "update_pull_request_branch",
    "Bring an open pull request up to date with its base branch (GitLab rebases it). Pass headSha from get_pull_request. Acts with your connected account when you have one.",
    "cloud:write",
    gitUpdateBranchInputSchema.safeExtend({ id: cloudId }),
    async (a, i) => {
      await runtime.git.pullRequests.updateBranch(a, i.id, i.headSha);
      return { ok: true };
    },
  );
  add(
    "merge_pull_request",
    "Merge an open pull request. Pass headSha from get_pull_request so newer commits are never merged unseen. Acts with your connected account when you have one.",
    "cloud:write",
    gitMergeInputSchema.safeExtend({ id: cloudId }),
    (a, { id: pullRequestId, ...input }) =>
      runtime.git.pullRequests.merge(a, pullRequestId, input),
  );
  add(
    "comment_on_pull_request",
    "Post a comment on an open pull request. Acts with your connected account when you have one.",
    "cloud:write",
    gitCommentInputSchema.safeExtend({ id: cloudId }),
    (a, i) =>
      runtime.git.pullRequests.comment(
        a,
        i.id,
        `${i.body}

${automationMarker}`,
      ),
  );
  add(
    "review_pull_request",
    "Submit a review on an open pull request: approve, request_changes or comment. A message is required unless approving.",
    "cloud:write",
    gitReviewInputSchema.safeExtend({ id: cloudId }),
    (a, { id: pullRequestId, ...input }) =>
      runtime.git.pullRequests.review(a, pullRequestId, {
        decision: input.decision,
        body: input.body
          ? `${input.body}

${automationMarker}`
          : "",
      }),
  );
  add(
    "retarget_pull_request",
    "Change the base branch of an open pull request, for example onto the base of a merged pull request it was stacked on (see stack.retargetTo).",
    "cloud:write",
    gitRetargetInputSchema.safeExtend({ id: cloudId }),
    (a, i) => runtime.git.pullRequests.retarget(a, i.id, i.baseRef),
  );
  add(
    "find_issue",
    "Read an accessible issue by its identifier, such as PLAT-12.",
    "cloud:read",
    z.strictObject({ identifier: issueIdentifier }),
    async (a, i) => {
      const issue = await runtime.planning.findIssue(a, i.identifier);
      if (!issue)
        throw new CloudError(404, "not_found", "Issue is unavailable.");
      return issue;
    },
  );
  add(
    "change_issues",
    "Change up to 100 accessible issues at once: status or statusCategory, priority, assignee, project, milestone, cycle, estimate from the team scale, due date, or archived to archive and restore. Omitted fields stay unchanged and null clears a field. Title, description and acceptance criteria apply to one issue at its current revision.",
    "cloud:write",
    issueChangesSchema.safeExtend(command),
    (a, { commandId, ...input }) =>
      runtime.issueChanges.apply(a, commandId, input),
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
    "list_initiatives",
    "List initiatives with their projects, derived health and issue progress.",
    "cloud:read",
    empty,
    (a) => runtime.initiatives.list(a),
  );
  add(
    "get_initiative",
    "Read an initiative and its revision.",
    "cloud:read",
    id,
    (a, i) => runtime.initiatives.get(a, i.id),
  );
  add(
    "create_initiative",
    "Create an initiative grouping accessible projects.",
    "cloud:write",
    z.strictObject({ ...command, initiative: initiativeInputSchema }),
    (a, i) => runtime.initiatives.create(a, i.commandId, i.initiative),
  );
  add(
    "update_initiative",
    "Replace an initiative's fields and accessible projects using its current revision.",
    "cloud:write",
    z.strictObject({
      ...command,
      id: cloudId,
      initiative: initiativeUpdateSchema,
    }),
    (a, i) => runtime.initiatives.update(a, i.commandId, i.id, i.initiative),
  );
  add(
    "list_triage",
    "Read issues waiting in triage, newest first. Omit teamId for every accessible team.",
    "cloud:read",
    z.strictObject({ teamId: cloudId.nullable().default(null) }),
    (a, i) => runtime.triage.list(a, i.teamId),
  );
  add(
    "decide_triage",
    "Settle an issue in triage at its current revision: accept it into an open status, decline it with an optional reason, or mark it as a duplicate of another issue.",
    "cloud:write",
    z.strictObject({ ...command, id: cloudId, decision: triageDecisionSchema }),
    (a, i) => runtime.triage.decide(a, i.commandId, i.id, i.decision),
  );
  add(
    "list_milestones",
    "Read a project's milestones with their target dates.",
    "cloud:read",
    z.strictObject({ projectId: cloudId }),
    (a, i) => runtime.milestones.list(a, i.projectId),
  );
  add(
    "list_project_updates",
    "Read a project's status updates with health, newest first.",
    "cloud:read",
    z.strictObject({ projectId: cloudId }),
    (a, i) => runtime.projectUpdates.list(a, i.projectId),
  );
  add(
    "create_project_update",
    "Post a project status update with its health: on_track, at_risk or off_track.",
    "cloud:write",
    z.strictObject({
      ...command,
      projectId: cloudId,
      update: projectUpdateInputSchema,
    }),
    (a, i) =>
      runtime.projectUpdates.create(a, i.commandId, i.projectId, i.update),
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
  add(
    "list_automations",
    "List accessible automations with their triggers, conditions, actions, state and recent usage.",
    "cloud:read",
    z.strictObject({ teamId: cloudId.optional() }),
    (a, i) => runtime.automations.service.list(a, i),
  );
  add(
    "list_automation_runs",
    "Read the 50 newest runs of an automation or an issue, including each step's outcome.",
    "cloud:read",
    z.strictObject({
      automationId: cloudId.optional(),
      issueId: cloudId.optional(),
    }),
    (a, i) => runtime.automations.service.runs(a, i),
  );
  add(
    "run_automation",
    "Run a manual automation, optionally on an issue of its team, or run a scheduled automation now. Its actions run with the automation owner's permissions and may consume provider budget.",
    "cloud:execute",
    z.strictObject({
      ...command,
      id: cloudId,
      issueId: cloudId.nullable().default(null),
    }),
    (a, i) =>
      runtime.automations.service.run(a, i.commandId, i.id, {
        issueId: i.issueId,
      }),
  );
  add(
    "list_agent_models",
    "List the AI providers and models available to Agent.",
    "cloud:read",
    empty,
    async (a) =>
      (await runtime.aiProviders.list(a)).providers.map((provider) => ({
        id: provider.id,
        name: provider.name,
        models: provider.models,
      })),
  );
  add(
    "ask_agent",
    "Send a message to Agent, the workspace assistant, with your permissions. Start a conversation with chatId and revision null, or continue one with its current revision. The answer is produced in the background; read it with get_agent_conversation. Consumes provider budget.",
    "cloud:execute",
    z.strictObject({ ...command, message: chatMessageSchema }),
    (a, i) => runtime.chat.store.submit(a, i.commandId, i.message),
  );
  add(
    "get_agent_conversation",
    "Read an Agent conversation: its revision, context and newest turns with state, answer, lookups, question and proposals.",
    "cloud:read",
    id,
    (a, i) => runtime.chat.store.get(a, i.id),
  );
  add(
    "apply_agent_proposal",
    "Apply a pending Agent proposal from a conversation turn as yourself. Fails without changes when your access no longer allows it or the subject changed.",
    "cloud:write",
    z.strictObject({ turnId: cloudId, actionId: cloudId }),
    (a, i) => runtime.chat.actions.apply(a, i.turnId, i.actionId),
  );
  add(
    "list_products",
    "List products with their brand kit, voice rules and channel counts.",
    "cloud:read",
    empty,
    (a) => runtime.releases.products.list(a),
  );
  add(
    "list_releases",
    "List releases with their status, channels and next scheduled publication.",
    "cloud:read",
    z.strictObject({ productId: cloudId.optional() }),
    (a, i) => runtime.releases.releases.list(a, i),
  );
  add(
    "get_release",
    "Read a release: notes, highlights, shipped issues, channel posts with their delivery state, and background jobs.",
    "cloud:read",
    id,
    (a, i) => runtime.releases.releases.get(a, i.id),
  );
  add(
    "create_release",
    "Create a release for a product. Completed issues of the product's teams since the previous release are collected, and a draft post is added for every enabled channel.",
    "cloud:write",
    z.strictObject({ ...command, release: releaseInputSchema }),
    (a, i) => runtime.releases.releases.create(a, i.commandId, i.release),
  );
  add(
    "update_release_post",
    "Edit a channel post of a release using its current revision. Editing returns it to draft for approval.",
    "cloud:write",
    z.strictObject({ ...command, id: cloudId, post: postUpdateSchema }),
    (a, i) =>
      runtime.releases.releases.updatePost(a, i.commandId, i.id, i.post),
  );
  add(
    "change_release_post",
    "Approve, reopen, schedule, publish now or retry a channel post. Scheduling and publishing require publishing permission for the product.",
    "cloud:write",
    z.strictObject({ ...command, id: cloudId, change: postStateSchema }),
    (a, i) =>
      runtime.releases.releases.changePost(a, i.commandId, i.id, i.change),
  );
  add(
    "launch_release",
    "Schedule or publish every ready post of a release at once: approved posts, and drafts of channels that skip approval. Requires publishing permission for the product.",
    "cloud:write",
    z.strictObject({ ...command, id: cloudId, launch: releaseLaunchSchema }),
    (a, i) => runtime.releases.releases.launch(a, i.commandId, i.id, i.launch),
  );
  add(
    "create_release_visual",
    "Render a branded visual for a release from the product's brand kit and add it to the release media.",
    "cloud:write",
    z.strictObject({ id: cloudId, visual: visualInputSchema }),
    (a, i) => runtime.releases.studio.createVisual(a, i.id, i.visual),
  );
  add(
    "write_release_content",
    "Let Agent write the release notes, one native post per channel and branded visuals in the background. Read the outcome with get_release. Consumes provider budget.",
    "cloud:execute",
    z.strictObject({ ...command, id: cloudId, input: releaseWriteSchema }),
    (a, i) => runtime.releases.studio.startWrite(a, i.commandId, i.id, i.input),
  );
  return tools;
}
