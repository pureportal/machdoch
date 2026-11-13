import type { CloudActor } from "../../../lib/cloud-contract";
import { issueInputSchema } from "../../../lib/cloud-contract";
import type {
  AutomationAction,
  AutomationStep,
} from "../../../lib/cloud-automation-contract";
import type { AgentAction } from "../../../lib/cloud-chat-contract";
import {
  renderAutomationText,
  type AutomationVariables,
} from "../../../lib/automation-text";
import { CloudError, isCloudError, requireMembership } from "../access";
import { derivedCommandId } from "../command-ids";
import type { CloudDatabase } from "../database";
import type { CloudPlanning } from "../planning";
import type { CloudIssueChanges } from "../issue-changes";
import type { CloudLabels } from "../labels";
import type { CloudComments } from "../comments";
import type { CloudIssueRelations } from "../relations";
import type { CloudRuns } from "../execution/runs";
import type { CloudChatStore } from "../ai/chat-store";
import type { CloudAgentActions } from "../ai/agent-actions";
import type { CloudReleases } from "../releases/releases";
import type { CloudReleaseStudio } from "../releases/release-studio";
import type { CloudAttachments } from "../attachments/attachments";
import { uploadInstructions } from "../attachments/upload-instructions";
import { clientSessionHref, type CloudClients } from "../clients/clients";
import { releaseTitle } from "../../../lib/release-posts";
import { gitEventKinds } from "../../../lib/git-events";
import type { CloudGitPullRequests } from "../git/pull-requests";
import { executeGitAction } from "./automation-git-actions";
import { automationScope } from "./automation-events";
import { changesSinceLastPost } from "./release-automations";
import {
  storedAutomationColumns,
  type StoredAutomation,
} from "./automation-records";

export interface AutomationServices {
  database: CloudDatabase;
  origin: string;
  planning: CloudPlanning;
  issueChanges: CloudIssueChanges;
  labels: CloudLabels;
  comments: CloudComments;
  relations: CloudIssueRelations;
  runs: CloudRuns;
  chat: CloudChatStore;
  agentActions: CloudAgentActions;
  releases: CloudReleases;
  studio: CloudReleaseStudio;
  attachments: CloudAttachments;
  clients: CloudClients;
  pullRequests: CloudGitPullRequests;
  fetch: typeof fetch;
}

export interface ActiveRun {
  organizationId: string;
  id: string;
  automationId: string;
  trigger: string;
  issueId: string | null;
  actorId: string | null;
  depth: number;
  variables: AutomationVariables;
  step: number;
  steps: AutomationStep[];
  chatId: string | null;
  turnId: string | null;
  agentActorId: string | null;
}

export const activeRunColumns = `organization_id AS "organizationId",id,automation_id AS "automationId",trigger,issue_id AS "issueId",actor_id AS "actorId",depth,variables,step,steps,
  chat_id AS "chatId",turn_id AS "turnId",agent_actor_id AS "agentActorId"`;

const humanTriggers = new Set<string>([
  ...gitEventKinds,
  "manual",
  "issue_created",
  "status_changed",
  "priority_changed",
  "assignee_changed",
  "label_added",
  "comment_created",
]);
const accessErrors = new Set([
  "membership_required",
  "permission_denied",
  "delegation_denied",
]);
const webhookTimeoutMs = 10_000;
const pullRequestTriggers = new Set<string>([
  ...gitEventKinds,
  "pull_request_changed",
]);
const defaultPullRequestInstructions =
  "Fix the failing checks and address the review comments on this pull request.";
const defaultPullRequestCriteria =
  "The checks pass and every review comment is addressed.";

type StepOutcome = (Omit<AutomationStep, "kind"> & { halt?: true }) | "waiting";

function succeeded(detail: string, link: string | null = null): StepOutcome {
  return { state: "succeeded", detail, link };
}

function skipped(detail: string): StepOutcome {
  return { state: "skipped", detail, link: null };
}

export class CloudAutomationExecutor {
  constructor(private readonly services: AutomationServices) {}

  async advance(run: ActiveRun): Promise<void> {
    const automation = (
      await this.services.database.transaction((sql) =>
        sql.query<StoredAutomation & Record<string, unknown>>(
          `SELECT ${storedAutomationColumns} FROM cloud_automations WHERE organization_id=$1 AND id=$2`,
          [run.organizationId, run.automationId],
        ),
      )
    ).rows[0];
    if (!automation?.enabled) {
      await this.finish(run, "skipped", "The automation was paused.");
      return;
    }
    const owner = {
      organizationId: run.organizationId,
      userId: automation.ownerId,
    };
    await this.save(run, { state: run.turnId ? "waiting" : "running" });
    await automationScope.run(
      { automationId: automation.id, depth: run.depth + 1 },
      () => this.perform(run, automation, owner),
    );
  }

  private async perform(
    run: ActiveRun,
    automation: StoredAutomation,
    owner: CloudActor,
  ): Promise<void> {
    for (let index = run.step; index < automation.actions.length; index++) {
      const action = automation.actions[index]!;
      let outcome: StepOutcome;
      try {
        outcome = await this.execute(run, automation, owner, action, index);
      } catch (error) {
        if (!isCloudError(error) || error.status >= 500) throw error;
        run.steps.push({
          kind: action.kind,
          state: "failed",
          detail: error.message.slice(0, 500),
          link: null,
        });
        await this.finish(run, "failed", error.message);
        if (accessErrors.has(error.code))
          await this.disable(
            run,
            "The owner's access ended. The owner can enable this automation after access is restored.",
          );
        return;
      }
      if (outcome === "waiting") return;
      const { halt, ...step } = outcome;
      run.steps.push({ kind: action.kind, ...step });
      if (halt) {
        await this.finish(run, "skipped", null);
        return;
      }
      run.step = index + 1;
      run.turnId = null;
      await this.save(run, { state: "running" });
    }
    await this.finish(run, "succeeded", null);
  }

  private async variables(
    run: ActiveRun,
    automation: StoredAutomation,
    owner: CloudActor,
  ): Promise<AutomationVariables> {
    const actor = run.actorId
      ? await this.services.database.transaction(
          async (sql) =>
            (
              await sql.query<{ name: string }>(
                "SELECT name FROM cloud_users WHERE id=$1",
                [run.actorId],
              )
            ).rows[0] ?? null,
        )
      : null;
    const issue = run.issueId
      ? await this.services.planning.getIssue(owner, run.issueId)
      : null;
    const releaseId = this.releaseId(run);
    const release = releaseId
      ? await this.services.releases.get(owner, releaseId)
      : null;
    return {
      ...run.variables,
      automation: { name: automation.name },
      date: new Date().toISOString().slice(0, 10),
      actor: { name: actor?.name ?? "" },
      issue: issue && {
        identifier: issue.identifier,
        title: issue.title,
        description: issue.description,
        status: issue.statusName,
        priority: issue.priority,
        url: `${this.services.origin}/cloud/issues/${issue.identifier}`,
      },
      release: release && {
        id: release.id,
        title: releaseTitle({ name: release.productName }, release),
        version: release.version,
        url: `${this.services.origin}/cloud/releases/${release.id}`,
      },
    };
  }

  private releaseId(run: ActiveRun): string | null {
    const release = run.variables.release as { id?: unknown } | undefined;
    return typeof release?.id === "string" ? release.id : null;
  }

  private requireIssue(run: ActiveRun): string {
    if (!run.issueId)
      throw new CloudError(
        422,
        "issue_required",
        "This action needs an issue.",
      );
    return run.issueId;
  }

  private async statusReference(owner: CloudActor, statusId: string) {
    const status = (
      await this.services.database.transaction((sql) =>
        sql.query<{ id: string; revision: number }>(
          "SELECT id,revision FROM cloud_workflow_statuses WHERE organization_id=$1 AND id=$2 AND NOT archived",
          [owner.organizationId, statusId],
        ),
      )
    ).rows[0];
    if (!status)
      throw new CloudError(
        422,
        "status_unavailable",
        "The chosen status is unavailable. Edit the automation.",
      );
    return status;
  }

  private async execute(
    run: ActiveRun,
    automation: StoredAutomation,
    owner: CloudActor,
    action: AutomationAction,
    index: number,
  ): Promise<StepOutcome> {
    const key = (purpose: string) =>
      derivedCommandId(`${run.id}:${index}`, purpose);
    const { planning, issueChanges, labels, comments } = this.services;
    const variables = await this.variables(run, automation, owner);
    switch (action.kind) {
      case "set_status": {
        const issueId = this.requireIssue(run);
        await issueChanges.apply(owner, key("status"), {
          issues: [{ id: issueId }],
          changes: {
            status: await this.statusReference(owner, action.statusId),
          },
        });
        return succeeded("Status changed");
      }
      case "set_priority":
        await issueChanges.apply(owner, key("priority"), {
          issues: [{ id: this.requireIssue(run) }],
          changes: { priority: action.priority },
        });
        return succeeded("Priority changed");
      case "assign": {
        const issueId = this.requireIssue(run);
        const assigneeId =
          action.assignee === "unassigned"
            ? null
            : action.assignee === "trigger_actor"
              ? run.actorId
              : action.assignee;
        if (action.assignee === "trigger_actor" && !assigneeId)
          return skipped("Nobody triggered this run.");
        await issueChanges.apply(owner, key("assign"), {
          issues: [{ id: issueId }],
          changes: { assigneeId },
        });
        return succeeded(assigneeId ? "Assigned" : "Unassigned");
      }
      case "add_labels":
      case "remove_labels": {
        const issueId = this.requireIssue(run);
        const current = await labels.getIssue(owner, issueId);
        const existing = current.labels.map((label) => label.id);
        const labelIds =
          action.kind === "add_labels"
            ? [...new Set([...existing, ...action.labelIds])]
            : existing.filter((id) => !action.labelIds.includes(id));
        await labels.setIssue(owner, key("labels"), issueId, {
          revision: current.revision,
          labelIds,
        });
        return succeeded(
          action.kind === "add_labels" ? "Labels added" : "Labels removed",
        );
      }
      case "comment":
        await comments.create(
          owner,
          key("comment"),
          this.requireIssue(run),
          renderAutomationText(action.body, variables, 20_000),
        );
        return succeeded("Comment added");
      case "create_issue":
        return this.createIssue(run, automation, owner, action, variables, key);
      case "ask_agent":
        return this.askAgent(run, automation, owner, action, variables, key);
      case "delegate": {
        const pullRequest = variables.pullRequest as
          | { id?: unknown; headSha?: unknown }
          | null
          | undefined;
        if (
          typeof pullRequest?.id === "string" &&
          (pullRequestTriggers.has(run.trigger) || !run.issueId)
        ) {
          const current = await this.services.pullRequests.get(
            owner,
            pullRequest.id,
          );
          const created = await this.services.runs.createForPullRequest(
            owner,
            key("task"),
            {
              profileId: action.profileId,
              subject: {
                kind: "pull_request",
                id: current.id,
                headSha:
                  typeof pullRequest.headSha === "string"
                    ? pullRequest.headSha
                    : current.headSha,
                objective:
                  renderAutomationText(
                    action.instructions,
                    variables,
                    20_000,
                  ).trim() || defaultPullRequestInstructions,
                acceptanceCriteria:
                  renderAutomationText(
                    action.acceptanceCriteria,
                    variables,
                    20_000,
                  ).trim() || defaultPullRequestCriteria,
              },
            },
          );
          return succeeded(
            `AI task started on #${current.number}`,
            `/cloud/tasks/${created.id}`,
          );
        }
        const issue = await planning.getIssue(owner, this.requireIssue(run));
        const created = await this.services.runs.create(owner, key("task"), {
          profileId: action.profileId,
          subject: { kind: "issue", id: issue.id, revision: issue.revision },
        });
        return succeeded("AI task started", `/cloud/tasks/${created.id}`);
      }
      case "git_comment":
      case "git_review":
      case "git_merge":
      case "git_update_branch":
      case "git_retarget":
        return executeGitAction(
          this.services.pullRequests,
          owner,
          action,
          variables,
        );
      case "send_webhook":
        return this.sendWebhook(owner, automation, action, variables);
      case "start_client_session":
        return this.startClientSession(run, owner, action, variables, key);
      case "write_release_posts":
        return this.writeReleasePosts(run, owner, action, variables, key);
      case "prepare_release": {
        const release = await this.services.releases.create(
          owner,
          key("release"),
          {
            productId: action.productId,
            version:
              renderAutomationText(action.version, variables, 40).trim() ||
              String(variables.date),
            name: renderAutomationText(action.name, variables, 120).trim(),
            since: null,
            targetDate: null,
          },
        );
        if (action.providerId)
          await this.services.studio.startWrite(
            owner,
            key("release-write"),
            release.id,
            {
              providerId: action.providerId,
              model: action.model,
              scope: "all",
              channelIds: [],
              instructions: renderAutomationText(
                action.instructions,
                variables,
                2_000,
              ),
            },
          );
        run.variables = { ...run.variables, release: { id: release.id } };
        return succeeded(
          action.providerId
            ? "Release created · Agent is writing"
            : "Release created",
          `/cloud/releases/${release.id}`,
        );
      }
    }
  }

  private async createIssue(
    run: ActiveRun,
    automation: StoredAutomation,
    owner: CloudActor,
    action: Extract<AutomationAction, { kind: "create_issue" }>,
    variables: AutomationVariables,
    key: (purpose: string) => string,
  ): Promise<StepOutcome> {
    const { planning, relations, labels } = this.services;
    const issue = issueInputSchema.parse({
      teamId: automation.teamId,
      title:
        renderAutomationText(action.title, variables, 300).trim() ||
        automation.name,
      description: renderAutomationText(action.description, variables, 30_000),
      status: action.statusId
        ? await this.statusReference(owner, action.statusId)
        : null,
      priority: action.priority,
      assigneeId: action.assigneeId,
    });
    const created = action.subIssue
      ? await relations.createChild(
          owner,
          key("create"),
          this.requireIssue(run),
          {
            parentRevision: (
              await planning.getIssue(owner, this.requireIssue(run))
            ).revision,
            issue,
          },
        )
      : await planning.createIssue(owner, key("create"), issue);
    if (action.labelIds.length) {
      const current = await labels.getIssue(owner, created.id);
      if (!current.labels.length)
        await labels.setIssue(owner, key("labels"), created.id, {
          revision: current.revision,
          labelIds: action.labelIds,
        });
    }
    const identifier = (await planning.getIssue(owner, created.id)).identifier;
    return succeeded(`Created ${identifier}`, `/cloud/issues/${identifier}`);
  }

  private async askAgent(
    run: ActiveRun,
    automation: StoredAutomation,
    owner: CloudActor,
    action: Extract<AutomationAction, { kind: "ask_agent" }>,
    variables: AutomationVariables,
    key: (purpose: string) => string,
  ): Promise<StepOutcome> {
    const issue = variables.issue as { identifier: string } | null;
    if (!run.turnId) {
      const agentActor =
        run.actorId && humanTriggers.has(run.trigger)
          ? { organizationId: run.organizationId, userId: run.actorId }
          : owner;
      const prompt = [
        renderAutomationText(action.prompt, variables, 8_000),
        "---",
        `The automation "${automation.name}" sent this request. Nobody can answer questions, so do not call ask_user.`,
        action.applyProposals
          ? "Your proposals are applied automatically. Propose only changes you are confident about."
          : "Your proposals wait for confirmation.",
        action.postAnswer && issue
          ? `Your answer is posted as a comment on ${issue.identifier}. Write it for the team.`
          : "",
      ]
        .filter(Boolean)
        .join("\n\n");
      const submission = await this.services.chat.startHiddenChat(
        agentActor,
        key("agent"),
        {
          owner: { automationId: automation.id },
          providerId: action.providerId,
          model: action.model,
          prompt,
          context: run.issueId
            ? [{ kind: "issue", id: run.issueId }]
            : [{ kind: "team", id: automation.teamId }],
        },
      );
      run.chatId = submission.chatId;
      run.turnId = submission.turnId;
      run.agentActorId = agentActor.userId;
      await this.save(run, { state: "waiting" });
      return "waiting";
    }
    const turn = (
      await this.services.database.transaction((sql) =>
        sql.query<{
          state: string;
          answer: string;
          error_code: string | null;
          question: { text: string } | null;
          actions: AgentAction[];
        }>(
          "SELECT state,answer,error_code,question,actions FROM cloud_chat_turns WHERE organization_id=$1 AND id=$2",
          [run.organizationId, run.turnId],
        ),
      )
    ).rows[0];
    if (!turn)
      throw new CloudError(
        409,
        "agent_unavailable",
        "The Agent conversation is unavailable.",
      );
    if (["queued", "running", "cancel_requested"].includes(turn.state))
      return "waiting";
    if (turn.state !== "complete")
      throw new CloudError(
        409,
        "agent_failed",
        `Agent did not finish${turn.error_code ? ` (${turn.error_code.replaceAll("_", " ")})` : ""}.`,
      );
    const agentActor = {
      organizationId: run.organizationId,
      userId: run.agentActorId ?? owner.userId,
    };
    const results: AgentAction[] = [];
    if (action.applyProposals)
      for (const proposal of turn.actions.filter(
        (entry) => entry.state === "pending" && entry.kind !== "automation",
      ))
        results.push(
          await this.services.agentActions.apply(
            agentActor,
            run.turnId,
            proposal.id,
          ),
        );
    const answer = [turn.answer, turn.question?.text ?? ""]
      .filter((part) => part.trim())
      .join("\n\n");
    run.variables = { ...run.variables, agent: { answer } };
    if (action.postAnswer && run.issueId && answer.trim())
      await this.services.comments.create(
        agentActor,
        key("answer"),
        run.issueId,
        `**Agent**\n\n${answer}`.slice(0, 20_000),
      );
    const applied = results.filter((entry) => entry.state === "applied");
    const failed = results.filter((entry) => entry.state === "failed");
    const detail = [
      action.postAnswer && run.issueId && answer.trim() ? "Answered" : "",
      applied.length
        ? `Applied ${applied.length} ${applied.length === 1 ? "proposal" : "proposals"}`
        : "",
      failed.length
        ? `${failed.length} failed: ${failed.map((entry) => entry.error).join("; ")}`
        : "",
    ]
      .filter(Boolean)
      .join(" · ");
    return {
      state: failed.length && !applied.length ? "failed" : "succeeded",
      detail: (detail || "Answered").slice(0, 500),
      link: run.chatId ? `/cloud/chat/${run.chatId}` : null,
    };
  }

  private async writeReleasePosts(
    run: ActiveRun,
    owner: CloudActor,
    action: Extract<AutomationAction, { kind: "write_release_posts" }>,
    variables: AutomationVariables,
    key: (purpose: string) => string,
  ): Promise<StepOutcome> {
    const releaseId = this.releaseId(run);
    if (!releaseId)
      throw new CloudError(
        422,
        "release_required",
        "This action needs a release.",
      );
    const link = `/cloud/releases/${releaseId}`;
    const release = await this.services.releases.get(owner, releaseId);
    const posts = release.posts.filter(
      (post) =>
        (!action.channelKinds.length ||
          action.channelKinds.includes(post.channelKind)) &&
        !["publishing", "published"].includes(post.state),
    );
    if (!posts.length)
      return skipped("No matching channel is waiting for a post.");
    const changes = await this.services.database.transaction((sql) =>
      changesSinceLastPost(
        sql,
        run.organizationId,
        releaseId,
        posts.map((post) => post.channelId),
        action.measure,
      ),
    );
    const unit = action.measure === "points" ? "points" : "issues";
    const channelName = (channelId: string) =>
      posts.find((post) => post.channelId === channelId)!.channelName;
    const ready = changes.filter(
      (entry) => entry.value >= action.minimumChanges,
    );
    if (!ready.length)
      return {
        state: "skipped",
        detail: `Not enough changes since the last post: ${changes
          .map(
            (entry) =>
              `${channelName(entry.channelId)} ${entry.value} of ${action.minimumChanges} ${unit}`,
          )
          .join(", ")}`.slice(0, 500),
        link,
        halt: true,
      };
    const backlog = ready
      .filter((entry) => entry.earlier.length)
      .map((entry) =>
        [
          `The ${channelName(entry.channelId)} post also covers releases that were not announced there${entry.lastPostedVersion ? ` since ${entry.lastPostedVersion}` : ""}. Present them together with this release:`,
          ...entry.earlier.map(
            (earlier) =>
              `- ${earlier.version}${
                earlier.items.length
                  ? `: ${earlier.items
                      .slice(0, 20)
                      .map((item) => `${item.identifier} ${item.title}`)
                      .join("; ")}`
                  : ""
              }`,
          ),
        ].join("\n"),
      );
    await this.services.studio.startWrite(
      owner,
      key("release-posts"),
      releaseId,
      {
        providerId: action.providerId,
        model: action.model,
        scope: "posts",
        channelIds: ready.map((entry) => entry.channelId),
        instructions: [
          renderAutomationText(action.instructions, variables, 2_000),
          ...backlog,
        ]
          .filter((part) => part.trim())
          .join("\n\n")
          .slice(0, 6_000),
      },
    );
    return succeeded(
      `Agent is writing ${ready
        .map(
          (entry) =>
            `${channelName(entry.channelId)} (${entry.value} ${unit} since the last post)`,
        )
        .join(", ")}`.slice(0, 500),
      link,
    );
  }

  private async startClientSession(
    run: ActiveRun,
    owner: CloudActor,
    action: Extract<AutomationAction, { kind: "start_client_session" }>,
    variables: AutomationVariables,
    key: (purpose: string) => string,
  ): Promise<StepOutcome> {
    const { attachments, clients, origin, planning } = this.services;
    const prompt = renderAutomationText(action.prompt, variables, 8_000);
    const issue = run.issueId
      ? await planning.getIssue(owner, run.issueId)
      : null;
    const upload = issue
      ? await attachments.createUploadLink(owner, issue.id)
      : null;
    const started = await clients.start(
      owner,
      key("client-session"),
      {
        instanceId: action.instanceId,
        workspace: action.workspace,
        title:
          renderAutomationText(action.title, variables, 120).trim() ||
          "Automation",
        prompt:
          issue && upload
            ? [
                prompt,
                uploadInstructions(
                  `${origin}/api/v1/attachment-uploads/${upload.token}`,
                  issue.identifier,
                ),
              ].join("\n\n")
            : prompt,
        goalObjective: action.goal ? prompt.slice(0, 4_000) : null,
      },
      AbortSignal.timeout(60_000),
    );
    return succeeded(
      `Started on ${started.displayName}`,
      clientSessionHref(started),
    );
  }

  private async sendWebhook(
    owner: CloudActor,
    automation: StoredAutomation,
    action: Extract<AutomationAction, { kind: "send_webhook" }>,
    variables: AutomationVariables,
  ): Promise<StepOutcome> {
    await this.services.database.transaction((sql) =>
      requireMembership(sql, owner, "settings.manage"),
    );
    const body = action.body.trim()
      ? renderAutomationText(action.body, variables, 64 * 1024)
      : JSON.stringify({
          automation: { id: automation.id, name: automation.name },
          issue: variables.issue,
          actor: variables.actor,
          comment: variables.comment,
          pullRequest: variables.pullRequest,
          event: variables.event,
          repository: variables.repository,
          branch: variables.branch,
          sender: variables.sender,
          push: variables.push,
          review: variables.review,
          release: variables.release,
          agent: variables.agent,
        });
    let json = true;
    try {
      JSON.parse(body);
    } catch {
      json = false;
    }
    let response: Response;
    try {
      response = await this.services.fetch(action.url, {
        method: "POST",
        headers: {
          "Content-Type": json ? "application/json" : "text/plain",
          "User-Agent": "machdoch-cloud-automation",
        },
        body,
        redirect: "error",
        signal: AbortSignal.timeout(webhookTimeoutMs),
      });
    } catch {
      throw new CloudError(
        422,
        "webhook_unreachable",
        "The webhook address could not be reached.",
      );
    }
    if (!response.ok)
      throw new CloudError(
        422,
        "webhook_rejected",
        `The webhook responded with status ${response.status}.`,
      );
    return succeeded(`Sent (${response.status})`);
  }

  private async save(
    run: ActiveRun,
    patch: { state: "running" | "waiting" },
  ): Promise<void> {
    await this.services.database.transaction((sql) =>
      sql.query(
        `UPDATE cloud_automation_runs SET state=$3,step=$4,steps=$5,variables=$6,chat_id=$7,turn_id=$8,agent_actor_id=$9,updated_at=clock_timestamp()
        WHERE organization_id=$1 AND id=$2`,
        [
          run.organizationId,
          run.id,
          patch.state,
          run.step,
          JSON.stringify(run.steps),
          JSON.stringify(run.variables),
          run.chatId,
          run.turnId,
          run.agentActorId,
        ],
      ),
    );
  }

  private async finish(
    run: ActiveRun,
    state: "succeeded" | "failed" | "skipped",
    error: string | null,
  ): Promise<void> {
    await this.services.database.transaction((sql) =>
      sql.query(
        `UPDATE cloud_automation_runs SET state=$3,steps=$4,error=$5,turn_id=NULL,updated_at=clock_timestamp(),finished_at=clock_timestamp()
        WHERE organization_id=$1 AND id=$2`,
        [
          run.organizationId,
          run.id,
          state,
          JSON.stringify(run.steps),
          error?.slice(0, 500) ?? null,
        ],
      ),
    );
  }

  private async disable(run: ActiveRun, error: string): Promise<void> {
    await this.services.database.transaction((sql) =>
      sql.query(
        "UPDATE cloud_automations SET enabled=false,next_run_at=NULL,error=$3,revision=revision+1 WHERE organization_id=$1 AND id=$2",
        [run.organizationId, run.automationId, error],
      ),
    );
  }
}
