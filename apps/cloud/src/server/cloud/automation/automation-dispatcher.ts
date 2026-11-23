import {
  triggerMatchesEvent,
  type AutomationEvent,
} from "../../../lib/automation-triggers";
import type { CloudActor } from "../../../lib/cloud-contract";
import type { LoopRejectionReason } from "../../../lib/cloud-loop-contract";
import {
  actionNeedsIssue,
  issuelessTriggerKinds,
} from "../../../lib/cloud-automation-contract";
import { gitEventVariables } from "../../../lib/git-events";
import type { CloudDatabase, CloudSql } from "../database";
import {
  insertAutomationRun,
  issueMatchesConditions,
  storedAutomationColumns,
  type StoredAutomation,
} from "./automation-records";
import { maximumAutomationDepth } from "./automation-events";
import { recordSourceRejection } from "../loops/loop-sources";
import { dispatchDueSchedules } from "./automation-schedules";
import {
  activeRunColumns,
  type ActiveRun,
  type CloudAutomationExecutor,
} from "./automation-executor";

const eventBatchSize = 50;
const runBatchSize = 10;

interface QueuedEvent {
  organizationId: string;
  id: string;
  teamId: string | null;
  issueId: string | null;
  actorId: string | null;
  event: AutomationEvent;
  depth: number;
  originAutomationId: string | null;
  originRunId: string | null;
  source: string | null;
}

function eventVariables(event: AutomationEvent): Record<string, unknown> {
  if (event.kind === "comment_created")
    return { comment: { body: event.body } };
  if (event.kind === "pull_request_changed")
    return {
      pullRequest: {
        id: event.pullRequestId,
        title: event.title,
        url: event.url,
        stage: event.stage,
      },
    };
  if (event.kind === "git_event") return gitEventVariables(event.git);
  if (event.kind === "automation_finished")
    return {
      run: {
        automation: event.automationName,
        outcome: event.outcome,
        error: event.error ?? "",
      },
    };
  if (event.kind === "project_event")
    return {
      project: { id: event.projectId, name: event.projectName },
      event: { kind: event.event },
    };
  if (event.kind === "cycle_event")
    return {
      cycle: { id: event.cycleId, name: event.cycleName },
      event: { kind: event.event },
    };
  if (event.kind === "source_event")
    return {
      source: { name: event.source, title: event.title, body: event.body },
      payload: JSON.stringify(event.payload),
    };
  if (event.kind === "client_event")
    return {
      client: {
        id: event.instanceId,
        name: event.instanceName,
        path: event.path ?? "",
      },
      event: { kind: event.event },
    };
  if (event.kind === "release_event")
    return {
      deployment: {
        id: event.releaseId,
        pipelineId: event.pipelineId,
        environment: event.environment,
        version: event.version,
      },
    };
  return {};
}

async function runIssue(
  sql: CloudSql,
  owner: CloudActor,
  automation: StoredAutomation,
  queued: QueuedEvent,
): Promise<{ issueId: string | null } | null> {
  if ((issuelessTriggerKinds as readonly string[]).includes(queued.event.kind))
    return { issueId: null };
  if (queued.event.kind !== "git_event")
    return queued.issueId &&
      (await issueMatchesConditions(sql, owner, automation, queued.issueId))
      ? { issueId: queued.issueId }
      : null;
  for (const issueId of queued.event.git.issueIds)
    if (await issueMatchesConditions(sql, owner, automation, issueId))
      return { issueId };
  return automation.conditions.length ||
    automation.actions.some(actionNeedsIssue)
    ? null
    : { issueId: null };
}

async function listeningAutomations(
  sql: CloudSql,
  queued: QueuedEvent,
): Promise<StoredAutomation[]> {
  return (
    await sql.query<StoredAutomation & Record<string, unknown>>(
      queued.teamId
        ? `SELECT ${storedAutomationColumns} FROM cloud_automations WHERE organization_id=$1 AND enabled AND trigger_kind=$2 AND team_id=$3 ORDER BY created_at,id`
        : `SELECT ${storedAutomationColumns} FROM cloud_automations WHERE organization_id=$1 AND enabled AND trigger_kind=$2 ORDER BY created_at,id`,
      [
        queued.organizationId,
        queued.event.kind,
        ...(queued.teamId ? [queued.teamId] : []),
      ],
    )
  ).rows;
}

async function sourceAdmitted(
  sql: CloudSql,
  queued: QueuedEvent,
  automation: StoredAutomation,
): Promise<boolean> {
  const loop = (
    await sql.query<{
      loopsEnabled: boolean;
      sourceEnabled: boolean;
      killed: boolean;
      trusted: boolean;
    }>(
      `SELECT COALESCE(st.enabled,true) AS "loopsEnabled",COALESCE(src.enabled,false) AS "sourceEnabled",l.killed_at IS NOT NULL AS killed,
        EXISTS (SELECT 1 FROM cloud_loop_trusted_sources ts WHERE ts.organization_id=l.organization_id AND ts.loop_id=l.id AND ts.source=$3) AS trusted
      FROM cloud_loops l LEFT JOIN cloud_loop_settings st ON st.organization_id=l.organization_id
      LEFT JOIN cloud_loop_sources src ON src.organization_id=l.organization_id AND src.source=$3
      WHERE l.organization_id=$1 AND l.automation_id=$2`,
      [queued.organizationId, automation.id, queued.source],
    )
  ).rows[0];
  const reason: LoopRejectionReason | null = !loop?.loopsEnabled
    ? "loops_disabled"
    : !loop.sourceEnabled
      ? "source_disabled"
      : !loop.trusted
        ? "untrusted"
        : loop.killed
          ? "killed"
          : null;
  if (!reason) return true;
  await recordSourceRejection(sql, {
    organizationId: queued.organizationId,
    source: queued.source!,
    loopId: automation.id,
    reason,
  });
  return false;
}

async function dispatchEvents(sql: CloudSql): Promise<number> {
  const events = (
    await sql.query<QueuedEvent & Record<string, unknown>>(
      `SELECT organization_id AS "organizationId",id,team_id AS "teamId",issue_id AS "issueId",actor_id AS "actorId",event,depth,origin_automation_id AS "originAutomationId",origin_run_id AS "originRunId",source
      FROM cloud_automation_events ORDER BY sequence LIMIT ${eventBatchSize} FOR UPDATE SKIP LOCKED`,
    )
  ).rows;
  for (const queued of events) {
    if (queued.depth < maximumAutomationDepth) {
      for (const automation of await listeningAutomations(sql, queued)) {
        if (
          automation.id === queued.originAutomationId ||
          !triggerMatchesEvent(automation.trigger, queued.event)
        )
          continue;
        const target = await runIssue(
          sql,
          { organizationId: queued.organizationId, userId: automation.ownerId },
          automation,
          queued,
        );
        if (!target) continue;
        if (queued.source && !(await sourceAdmitted(sql, queued, automation)))
          continue;
        await insertAutomationRun(sql, queued.organizationId, automation, {
          dedupeKey: `event:${queued.id}`,
          trigger:
            queued.event.kind === "git_event"
              ? queued.event.git.kind
              : queued.event.kind,
          issueId: target.issueId,
          actorId: queued.actorId,
          depth: queued.depth,
          variables: eventVariables(queued.event),
          payload: { ...queued.event },
          originRunId: queued.originRunId,
        });
      }
    }
    await sql.query(
      "DELETE FROM cloud_automation_events WHERE organization_id=$1 AND id=$2",
      [queued.organizationId, queued.id],
    );
  }
  return events.length;
}

export class CloudAutomationDispatcher {
  constructor(
    private readonly database: CloudDatabase,
    private readonly executor: CloudAutomationExecutor,
  ) {}

  async tick(): Promise<number> {
    const events = await this.database.transaction(dispatchEvents);
    const schedules = await this.database.transaction(dispatchDueSchedules);
    const runs = (
      await this.database.transaction((sql) =>
        sql.query<ActiveRun & Record<string, unknown>>(
          `SELECT ${activeRunColumns} FROM cloud_automation_runs r WHERE state IN ('queued','running','waiting')
          AND NOT (r.state='queued' AND NOT r.dry_run AND EXISTS (
            SELECT 1 FROM cloud_loops l JOIN cloud_automation_runs o ON o.organization_id=l.organization_id AND o.automation_id=l.automation_id
            WHERE l.organization_id=r.organization_id AND l.automation_id=r.automation_id AND l.overlap='queue' AND o.id<>r.id AND NOT o.dry_run
              AND (o.state IN ('running','waiting') OR (o.state='queued' AND (o.created_at,o.id)<(r.created_at,r.id)))))
          ORDER BY updated_at,id LIMIT ${runBatchSize}`,
        ),
      )
    ).rows;
    let firstError: unknown;
    for (const run of runs)
      try {
        await this.executor.advance(run);
      } catch (error) {
        firstError ??= error;
      }
    if (firstError) throw firstError;
    return events + schedules + runs.filter((run) => !run.turnId).length;
  }
}
