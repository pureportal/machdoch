import {
  triggerMatchesEvent,
  type AutomationEvent,
} from "../../../lib/automation-triggers";
import type { CloudActor } from "../../../lib/cloud-contract";
import { actionNeedsIssue } from "../../../lib/cloud-automation-contract";
import { gitEventVariables } from "../../../lib/git-events";
import type { CloudDatabase, CloudSql } from "../database";
import {
  insertAutomationRun,
  issueMatchesConditions,
  storedAutomationColumns,
  type StoredAutomation,
} from "./automation-records";
import { maximumAutomationDepth } from "./automation-events";
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
  return {};
}

async function runIssue(
  sql: CloudSql,
  owner: CloudActor,
  automation: StoredAutomation,
  queued: QueuedEvent,
): Promise<{ issueId: string | null } | null> {
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

async function dispatchEvents(sql: CloudSql): Promise<number> {
  const events = (
    await sql.query<QueuedEvent & Record<string, unknown>>(
      `SELECT organization_id AS "organizationId",id,team_id AS "teamId",issue_id AS "issueId",actor_id AS "actorId",event,depth,origin_automation_id AS "originAutomationId"
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
          `SELECT ${activeRunColumns} FROM cloud_automation_runs WHERE state IN ('queued','running','waiting') ORDER BY updated_at,id LIMIT ${runBatchSize}`,
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
