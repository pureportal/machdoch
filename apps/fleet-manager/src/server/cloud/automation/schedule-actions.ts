import { randomUUID } from "node:crypto";
import type { CloudActor, CloudTeam } from "../../../lib/cloud-contract";
import type {
  ScheduleAction,
  CloudSchedule,
} from "../../../lib/cloud-schedule-contract";
import { CloudError } from "../access";
import type { CloudSql } from "../database";
import {
  createIssueInTransaction,
  readIssue,
  validateIssueLinks,
} from "../planning";
import { readProfile } from "../execution/records";
import { admitRun } from "../execution/admission";
import { readInferenceProvider } from "../ai/budgets";
import { resolveIssueStatus } from "../workflow-records";
import { taskContextLimit } from "../execution/task-context";

function requireTaskRevision(
  actual: number,
  expected: number,
  resource: "profile" | "subject",
): void {
  if (actual !== expected)
    throw new CloudError(
      409,
      `schedule_${resource}_changed`,
      `${resource === "profile" ? "The execution profile" : "The task subject"} changed. Reload task settings and review them before saving.`,
    );
}

export async function validateScheduleAction(
  sql: CloudSql,
  actor: CloudActor,
  team: CloudTeam,
  action: ScheduleAction,
): Promise<{
  providerRevision: number | null;
  tokenReservation: number;
  action: ScheduleAction;
}> {
  if (action.kind === "create-issue") {
    if (action.issue.teamId !== team.id)
      throw new CloudError(
        422,
        "schedule_team",
        "Choose this schedule's team for the issue.",
      );
    await validateIssueLinks(sql, actor, team, {
      ...action.issue,
      cycleId: null,
      dueOn: null,
    });
    const status = await resolveIssueStatus(
      sql,
      actor,
      team.id,
      action.issue.status,
    );
    return {
      providerRevision: null,
      tokenReservation: 0,
      action: {
        ...action,
        issue: {
          ...action.issue,
          status: { id: status.id, revision: status.revision },
        },
      },
    };
  }
  const profile = await readProfile(sql, actor, action.run.profileId, true);
  requireTaskRevision(profile.revision, action.profileRevision, "profile");
  if (!profile.enabled)
    throw new CloudError(
      409,
      "profile_disabled",
      "Choose an enabled execution profile.",
    );
  if (profile.teamId !== team.id)
    throw new CloudError(
      422,
      "schedule_team",
      "Choose an execution profile in this schedule's team.",
    );
  if (action.run.subject.kind === "issue") {
    const issue = await readIssue(sql, actor, action.run.subject.id);
    requireTaskRevision(issue.revision, action.run.subject.revision, "subject");
    if (issue.projectId !== profile.projectId)
      throw new CloudError(
        422,
        "project_mismatch",
        "Choose a profile for this issue's project.",
      );
    if (issue.archived || ["complete", "canceled"].includes(issue.state))
      throw new CloudError(
        409,
        "issue_closed",
        "Reopen the issue or choose another task subject.",
      );
    if (!issue.acceptanceCriteria.trim())
      throw new CloudError(
        422,
        "acceptance_required",
        "Add acceptance criteria to the issue before scheduling it.",
      );
    taskContextLimit({
      title: issue.title,
      objective: `${issue.title}\n\n${issue.description}`.trim(),
      acceptanceCriteria: issue.acceptanceCriteria.trim(),
      profile,
    });
  } else {
    if (action.run.subject.id !== profile.projectId)
      throw new CloudError(
        422,
        "project_mismatch",
        "Choose a profile for this project.",
      );
    const project = (
      await sql.query<{ revision: number }>(
        "SELECT revision FROM cloud_projects WHERE organization_id=$1 AND id=$2",
        [actor.organizationId, profile.projectId],
      )
    ).rows[0]!;
    requireTaskRevision(
      project.revision,
      action.run.subject.revision,
      "subject",
    );
    taskContextLimit({
      title: action.run.subject.objective.split("\n", 1)[0]!.slice(0, 300),
      objective: action.run.subject.objective,
      acceptanceCriteria: action.run.subject.acceptanceCriteria,
      profile,
    });
  }
  const provider = await readInferenceProvider(
    sql,
    actor.organizationId,
    profile.providerId,
  );
  if (!provider.models.includes(profile.model))
    throw new CloudError(
      422,
      "model_unavailable",
      "Choose a configured model for this profile.",
    );
  return {
    action,
    providerRevision: provider.inferenceRevision,
    tokenReservation: profile.maxTokens,
  };
}

export async function requireScheduleAllowance(
  sql: CloudSql,
  schedule: Pick<
    CloudSchedule,
    "action" | "admittedRuns" | "usedTokens" | "reservedTokens"
  >,
  waitingForRun = false,
): Promise<void> {
  if (schedule.action.kind !== "run-task") return;
  const valid = (
    await sql.query<{ valid: boolean }>(
      "SELECT $1::timestamptz>clock_timestamp() AS valid",
      [schedule.action.expiresAt],
    )
  ).rows[0]!.valid;
  if (!valid)
    throw new CloudError(
      409,
      "schedule_expired",
      "The task authorization expired. Review its expiry before enabling the schedule.",
    );
  if (
    schedule.admittedRuns >= schedule.action.maxRuns ||
    schedule.usedTokens + (waitingForRun ? 0 : schedule.reservedTokens) >=
      schedule.action.maxTokens
  )
    throw new CloudError(
      409,
      "schedule_budget",
      "The task allowance is exhausted. Review its limits before enabling the schedule.",
    );
}

export async function executeScheduleAction(
  sql: CloudSql,
  actor: CloudActor,
  team: CloudTeam,
  schedule: CloudSchedule,
  at: number,
): Promise<{ runId: string | null; completedAt: number | null }> {
  const action = schedule.action;
  let outcome: "created" | "admitted" | "overlap",
    issueId: string | null = null,
    runId: string | null = null,
    reason: string | null = null;
  let reservation = 0;
  if (action.kind === "create-issue") {
    issueId = (
      await createIssueInTransaction(sql, actor, team, {
        ...action.issue,
        cycleId: null,
        dueOn: null,
      })
    ).id;
    outcome = "created";
  } else {
    const grant = await validateScheduleAction(sql, actor, team, action);
    if (grant.providerRevision !== schedule.providerRevision)
      throw new CloudError(
        409,
        "schedule_provider_changed",
        "The AI provider changed. Review the task settings before enabling the schedule.",
      );
    const active = await sql.query(
      "SELECT r.id FROM cloud_runs r WHERE r.organization_id=$1 AND r.state NOT IN ('succeeded','failed','canceled','timed_out') AND (EXISTS(SELECT 1 FROM cloud_schedule_occurrences o WHERE o.schedule_id=$2 AND o.run_id=r.id) OR ($3::uuid IS NOT NULL AND r.issue_id=$3)) LIMIT 1",
      [
        actor.organizationId,
        schedule.id,
        action.run.subject.kind === "issue" ? action.run.subject.id : null,
      ],
    );
    if (active.rows.length) {
      outcome = "overlap";
      reason = "An earlier task is still active.";
    } else {
      await requireScheduleAllowance(sql, schedule);
      reservation = Math.min(
        grant.tokenReservation,
        action.maxTokens - schedule.usedTokens - schedule.reservedTokens,
      );
      const authority = (
        await sql.query<{
          membershipEpoch: string;
          userEpoch: string;
          teamEpoch: string;
        }>(
          'SELECT owner_epoch::text AS "membershipEpoch",user_epoch::text AS "userEpoch",team_epoch::text AS "teamEpoch" FROM cloud_schedules WHERE id=$1',
          [schedule.id],
        )
      ).rows[0]!;
      runId = (
        await admitRun(sql, actor, randomUUID(), action.run, {
          tokenLimit: reservation,
          grant: {
            scheduleId: schedule.id,
            revision: schedule.revision,
            expiresAt: action.expiresAt,
            ...authority,
          },
        })
      ).id;
      outcome = "admitted";
      schedule.reservedTokens += reservation;
      schedule.admittedRuns++;
      await sql.query(
        "UPDATE cloud_schedules SET admitted_runs=$2,reserved_tokens=$3 WHERE id=$1",
        [schedule.id, schedule.admittedRuns, schedule.reservedTokens],
      );
    }
  }
  const receipt = await sql.query<{ completedAt: number | null }>(
    'INSERT INTO cloud_schedule_occurrences(organization_id,schedule_id,revision,nominal_at,accounted_through,outcome,issue_id,run_id,reason,reserved_tokens,budget_dirty,completed_at) VALUES($1,$2,$3,$4,$4,$5,$6,$7,$8,$9,$10,CASE WHEN $7::uuid IS NULL THEN clock_timestamp() ELSE NULL END) RETURNING floor(extract(epoch FROM completed_at)*1000)::float8 AS "completedAt"',
    [
      actor.organizationId,
      schedule.id,
      schedule.revision,
      at,
      outcome,
      issueId,
      runId,
      reason,
      reservation,
      runId !== null,
    ],
  );
  return { runId, completedAt: receipt.rows[0]!.completedAt };
}
