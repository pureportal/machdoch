import { createHash, randomUUID } from "node:crypto";
import type { CloudActor } from "../../../lib/cloud-contract";
import type {
  RunInput,
  RunManifest,
} from "@machdoch/fleet-protocol/cloud-execution";
import { checkRevision, CloudError, command } from "../access";
import type { CloudSql } from "../database";
import { readIssue } from "../planning";
import { issuePlanningState } from "../issue-graph";
import { taskContextLimit } from "./task-context";
import { readInferenceProvider } from "../ai/budgets";
import {
  expireRuns,
  lockExecution,
  readProfile,
  recordRun,
  requireSandboxProvider,
} from "./records";

export async function admitRun(
  sql: CloudSql,
  actor: CloudActor,
  key: string,
  input: RunInput,
  automated?: {
    grant: NonNullable<RunManifest["automation"]>;
    tokenLimit: number;
  },
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
  const profile = automated
    ? {
        ...configuredProfile,
        maxTokens: Math.min(configuredProfile.maxTokens, automated.tokenLimit),
      }
    : configuredProfile;
  const automation = automated?.grant;
  let title: string;
  let objective: string;
  let acceptanceCriteria: string;
  if (input.subject.kind === "issue") {
    const issue = await readIssue(sql, actor, input.subject.id);
    if (issue.projectId !== profile.projectId)
      throw new CloudError(
        422,
        "project_mismatch",
        "Choose an execution profile for this issue's project.",
      );
    title = issue.title;
    objective = `${issue.title}\n\n${issue.description}`.trim();
    acceptanceCriteria =
      issue.acceptanceCriteria.trim() || "The issue is resolved as described.";
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
    { kind: "run.create", input, ...(automated ? { automated } : {}) },
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
      } else {
        const project = (
          await sql.query<{ revision: number }>(
            "SELECT revision FROM cloud_projects WHERE organization_id=$1 AND id=$2",
            [actor.organizationId, profile.projectId],
          )
        ).rows[0]!;
        checkRevision(project.revision, input.subject.revision);
      }
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
        requireSandboxProvider(configured);
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
      const contextLimitBytes = taskContextLimit({
        title,
        objective,
        acceptanceCriteria,
        profile,
      });
      const manifest: RunManifest = {
        ...(automation ? { automation } : {}),
        contextLimitBytes,
        subject: input.subject,
        title,
        objective,
        acceptanceCriteria,
        profile,
        provider,
        actorId: actor.userId,
      };
      const serialized = JSON.stringify(manifest);
      const id = randomUUID();
      await sql.query(
        `INSERT INTO cloud_runs (organization_id,id,team_id,project_id,profile_id,issue_id,actor_id,title,manifest,input_digest,deadline_at,planning_digest)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,clock_timestamp()+$11*interval '1 second',$12)`,
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
