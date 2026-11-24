import { createHash, randomUUID } from "node:crypto";
import type { CloudActor } from "../../../lib/cloud-contract";
import type {
  ClientAgent,
  ExecutionProfile,
  PullRequestRunSubject,
  RunInput,
  RunManifest,
} from "@machdoch/fleet-protocol/cloud-execution";
import { readVisiblePullRequest } from "../git/pull-requests";
import { defaultBranch, sameRepository } from "../git/repository-access";
import { checkRevision, CloudError, command } from "../access";
import type { CloudSql } from "../database";
import { readIssue } from "../planning";
import { issuePlanningState } from "../issue-graph";
import { taskContextLimit } from "./task-context";
import { readInferenceProvider } from "../ai/budgets";
import { expireRuns, lockExecution, readProfile, recordRun } from "./records";

export interface RunExecutor {
  workerId: string | null;
  providerId: string | null;
  agent: ClientAgent | null;
  model: string;
  instructions: string | null;
}

function executorProfile(
  profile: ExecutionProfile,
  executor: RunExecutor,
): ExecutionProfile {
  if (profile.target === "client") {
    if (!executor.agent)
      throw new CloudError(
        422,
        "executor_mismatch",
        "Choose an agent for this linked client.",
      );
    return { ...profile, agent: executor.agent, model: executor.model };
  }
  if (!executor.providerId)
    throw new CloudError(
      422,
      "executor_mismatch",
      "Choose a provider for this executor.",
    );
  return { ...profile, providerId: executor.providerId, model: executor.model };
}

async function requirePinnedWorker(
  sql: CloudSql,
  organizationId: string,
  profileId: string,
  workerId: string,
): Promise<void> {
  const worker = await sql.query(
    `SELECT w.id FROM cloud_execution_workers w JOIN cloud_execution_profiles p ON p.organization_id=w.organization_id AND p.id=w.profile_id
    WHERE w.organization_id=$1 AND w.id=$2 AND w.profile_id=$3 AND w.enabled AND w.expires_at>clock_timestamp() AND w.profile_revision=p.revision
    AND (p.definition->>'target'<>'client' OR w.workspace_binding IS NOT NULL)`,
    [organizationId, workerId, profileId],
  );
  if (!worker.rows.length)
    throw new CloudError(
      409,
      "worker_unavailable",
      "This device can no longer run tasks. Choose another one.",
    );
}

export async function admitRun(
  sql: CloudSql,
  actor: CloudActor,
  key: string,
  input: RunInput | { profileId: string; subject: PullRequestRunSubject },
  automated?: {
    grant: NonNullable<RunManifest["automation"]>;
    tokenLimit: number;
  },
  executor?: RunExecutor,
): Promise<{ id: string }> {
  await lockExecution(sql, actor.organizationId);
  await expireRuns(sql, actor.organizationId);
  const configuredProfile = await readProfile(
    sql,
    actor,
    input.profileId,
    true,
  );
  if (
    automated &&
    (!Number.isSafeInteger(automated.tokenLimit) || automated.tokenLimit < 1)
  )
    throw new CloudError(
      409,
      "schedule_budget",
      "The task token allowance is exhausted.",
    );
  const limitedProfile = automated
    ? {
        ...configuredProfile,
        maxTokens: Math.min(configuredProfile.maxTokens, automated.tokenLimit),
      }
    : configuredProfile;
  const profile = executor
    ? executorProfile(limitedProfile, executor)
    : limitedProfile;
  const automation = automated?.grant;
  let title: string;
  let objective: string;
  let acceptanceCriteria: string;
  let branch = configuredProfile.branch ?? null;
  if (input.subject.kind === "issue") {
    const issue = await readIssue(sql, actor, input.subject.id);
    if (issue.projectId !== profile.projectId)
      throw new CloudError(
        422,
        "project_mismatch",
        "Choose an execution profile for this issue's project.",
      );
    title = issue.title;
    objective = [issue.title, issue.description, executor?.instructions]
      .filter(Boolean)
      .join("\n\n")
      .trim()
      .slice(0, 30_302);
    acceptanceCriteria =
      issue.acceptanceCriteria.trim() || "The issue is resolved as described.";
  } else if (input.subject.kind === "pull_request") {
    const pullRequest = await readVisiblePullRequest(
      sql,
      actor,
      input.subject.id,
    );
    if (
      !pullRequest.repositoryUrl ||
      !sameRepository(pullRequest.repositoryUrl, profile.repository)
    )
      throw new CloudError(
        422,
        "repository_mismatch",
        "Choose an execution profile for this pull request's repository.",
      );
    if (pullRequest.state !== "open")
      throw new CloudError(409, "git_closed", "This pull request is closed.");
    if (pullRequest.headSha !== input.subject.headSha)
      throw new CloudError(
        409,
        "git_head_changed",
        "The pull request has new commits. Start the task again.",
      );
    const prefix =
      input.subject.purpose === "check"
        ? "Check "
        : input.subject.purpose === "resolve"
          ? "Resolve conflicts in "
          : "";
    title =
      `${prefix}${pullRequest.repository}#${pullRequest.number} ${pullRequest.title}`.slice(
        0,
        300,
      );
    objective = [
      input.subject.objective,
      `Pull request: ${pullRequest.url}`,
      `Branch: ${pullRequest.headRef} into ${pullRequest.baseRef}, checked out at ${pullRequest.headSha}.`,
    ].join("\n\n");
    acceptanceCriteria = input.subject.acceptanceCriteria;
    branch = pullRequest.headRef;
  } else {
    if (input.subject.id !== profile.projectId)
      throw new CloudError(
        422,
        "project_mismatch",
        "Choose an execution profile for this project.",
      );
    title = input.subject.objective.split("\n", 1)[0]!.slice(0, 300);
    objective = input.subject.objective;
    acceptanceCriteria = input.subject.acceptanceCriteria;
  }
  return command(
    sql,
    actor,
    key,
    {
      kind: "run.create",
      input,
      ...(automated ? { automated } : {}),
      ...(executor ? { executor } : {}),
    },
    async () => {
      let planningDigest: string | null = null;
      if (!profile.enabled)
        throw new CloudError(
          409,
          "profile_disabled",
          "Choose an enabled execution profile.",
        );
      if (input.subject.kind === "issue") {
        const issue = await readIssue(sql, actor, input.subject.id);
        checkRevision(issue.revision, input.subject.revision);
        const planning = await issuePlanningState(
          sql,
          actor.organizationId,
          issue.id,
        );
        if (!planning.ready)
          throw new CloudError(
            409,
            "issue_dependencies",
            "This task is unavailable. Review the issue's prerequisites with a team administrator.",
          );
        planningDigest = planning.digest;
        if (issue.archived || ["complete", "canceled"].includes(issue.state))
          throw new CloudError(
            409,
            "issue_closed",
            "Reopen the issue before starting an implementation task.",
          );
        const active = await sql.query(
          "SELECT id FROM cloud_runs WHERE organization_id=$1 AND issue_id=$2 AND state NOT IN ('succeeded','failed','canceled','timed_out')",
          [actor.organizationId, issue.id],
        );
        if (active.rows.length)
          throw new CloudError(
            409,
            "run_active",
            "This issue already has an active task. Open it to continue or cancel it.",
          );
      } else if (input.subject.kind === "project") {
        const project = (
          await sql.query<{ revision: number }>(
            "SELECT revision FROM cloud_projects WHERE organization_id=$1 AND id=$2",
            [actor.organizationId, profile.projectId],
          )
        ).rows[0]!;
        checkRevision(project.revision, input.subject.revision);
      }
      if (executor?.workerId)
        await requirePinnedWorker(
          sql,
          actor.organizationId,
          profile.id,
          executor.workerId,
        );
      if (!acceptanceCriteria)
        throw new CloudError(
          422,
          "acceptance_required",
          "Add acceptance criteria before starting a task.",
        );
      const capacity = (
        await sql.query<{ organization: number; project: number }>(
          "SELECT count(*)::integer AS organization,count(*) FILTER (WHERE project_id=$2)::integer AS project FROM cloud_runs WHERE organization_id=$1 AND state NOT IN ('succeeded','failed','canceled','timed_out')",
          [actor.organizationId, profile.projectId],
        )
      ).rows[0]!;
      if (capacity.organization >= 1000 || capacity.project >= 100)
        throw new CloudError(
          409,
          "task_capacity",
          "Too many active tasks. Complete or cancel tasks before queuing another.",
        );
      let provider: RunManifest["provider"] = null;
      if (profile.target !== "client") {
        const configured = await readInferenceProvider(
          sql,
          actor.organizationId,
          profile.providerId,
        );
        if (!configured.models.includes(profile.model))
          throw new CloudError(
            422,
            "model_unavailable",
            "Choose a configured model for this execution profile.",
          );
        provider = {
          id: configured.id,
          name: configured.name,
          provider: configured.provider,
          inferenceRevision: configured.inferenceRevision,
          maxOutputTokens: configured.maxOutputTokens,
        };
      }
      const manifestBranch =
        branch ??
        (await defaultBranch(sql, actor.organizationId, profile.repository));
      const contextLimitBytes = taskContextLimit({
        title,
        objective,
        acceptanceCriteria,
        profile,
        branch: manifestBranch,
        subject: input.subject,
      });
      const manifest: RunManifest = {
        ...(automation ? { automation } : {}),
        contextLimitBytes,
        subject: input.subject,
        title,
        objective,
        acceptanceCriteria,
        profile,
        branch: manifestBranch,
        provider,
        actorId: actor.userId,
      };
      const serialized = JSON.stringify(manifest);
      const id = randomUUID();
      await sql.query(
        `INSERT INTO cloud_runs (organization_id,id,team_id,project_id,profile_id,issue_id,actor_id,title,manifest,input_digest,deadline_at,planning_digest,pinned_worker_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,clock_timestamp()+$11*interval '1 second',$12,$13)`,
        [
          actor.organizationId,
          id,
          profile.teamId,
          profile.projectId,
          profile.id,
          input.subject.kind === "issue" ? input.subject.id : null,
          actor.userId,
          title,
          serialized,
          createHash("sha256").update(serialized).digest("hex"),
          profile.maxDurationSeconds,
          planningDigest,
          executor?.workerId ?? null,
        ],
      );
      if (automation)
        await sql.query(
          "UPDATE cloud_runs SET deadline_at=LEAST(deadline_at,$2::timestamptz) WHERE id=$1",
          [id, automation.expiresAt],
        );
      await recordRun(sql, actor.organizationId, id, "Task queued");
      return { id };
    },
  );
}
