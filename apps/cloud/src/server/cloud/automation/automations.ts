import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { CloudActor } from "../../../lib/cloud-contract";
import {
  actionNeedsIssue,
  type AutomationInput,
  type AutomationSecret,
  type CloudAutomation,
  type CloudAutomationRun,
} from "../../../lib/cloud-automation-contract";
import { nextScheduledRun } from "../../../lib/automation-schedule";
import {
  checkRevision,
  CloudError,
  command,
  requireMembership,
  requireTeam,
  teamVisibility,
} from "../access";
import type { CloudDatabase, CloudSql } from "../database";
import { readIssue } from "../planning";
import {
  automationColumns,
  automationFrom,
  insertAutomationRun,
  issueMatchesConditions,
  readAutomation,
  readRuns,
  storedAutomationColumns,
  type StoredAutomation,
} from "./automation-records";
import { validateAutomation } from "./automation-validation";
import { createScheduledRuns } from "./automation-schedules";

const maximumAutomationsPerTeam = 100;

export function hashWebhookToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function nextRunAt(input: AutomationInput, enabled: boolean): Date | null {
  return enabled && input.trigger.kind === "schedule"
    ? new Date(nextScheduledRun(input.trigger, Date.now()))
    : null;
}

function requireOwner(automation: CloudAutomation, actor: CloudActor): void {
  if (automation.ownerId !== actor.userId || actor.delegation)
    throw new CloudError(
      403,
      "automation_owner_required",
      "Only the automation owner can change it in the browser.",
    );
}

export class CloudAutomations {
  constructor(
    private readonly database: CloudDatabase,
    private readonly origin: string,
    private readonly wake: () => void,
  ) {}

  private webhookUrl(token: string): string {
    return `${this.origin}/api/v1/automations/hooks/${token}`;
  }

  private async issueWebhook(
    sql: CloudSql,
    organizationId: string,
    id: string,
  ): Promise<string> {
    const token = randomBytes(32).toString("base64url");
    await sql.query(
      "UPDATE cloud_automations SET webhook_hash=$3 WHERE organization_id=$1 AND id=$2",
      [organizationId, id, hashWebhookToken(token)],
    );
    return this.webhookUrl(token);
  }

  list(
    actor: CloudActor,
    filters: { teamId?: string } = {},
  ): Promise<CloudAutomation[]> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor);
      return (
        await sql.query<CloudAutomation & Record<string, unknown>>(
          `SELECT ${automationColumns} FROM ${automationFrom} WHERE a.organization_id=$1 AND ${teamVisibility}
          AND ($3::uuid IS NULL OR a.team_id=$3) ORDER BY a.created_at DESC,a.id LIMIT 500`,
          [actor.organizationId, actor.userId, filters.teamId ?? null],
        )
      ).rows;
    });
  }

  get(actor: CloudActor, id: string): Promise<CloudAutomation> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor);
      return readAutomation(sql, actor, id);
    });
  }

  runs(
    actor: CloudActor,
    filters: { automationId?: string; issueId?: string },
  ): Promise<CloudAutomationRun[]> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor);
      if (filters.issueId) await readIssue(sql, actor, filters.issueId);
      return readRuns(sql, actor, filters);
    });
  }

  forIssue(actor: CloudActor, issueId: string): Promise<CloudAutomation[]> {
    return this.database.transaction(async (sql) => {
      const issue = await readIssue(sql, actor, issueId);
      return (
        await sql.query<CloudAutomation & Record<string, unknown>>(
          `SELECT ${automationColumns} FROM ${automationFrom} WHERE a.organization_id=$1 AND ${teamVisibility}
          AND a.team_id=$3 AND a.enabled AND a.trigger_kind='manual' ORDER BY lower(a.name),a.id`,
          [actor.organizationId, actor.userId, issue.teamId],
        )
      ).rows;
    });
  }

  validate(
    actor: CloudActor,
    input: AutomationInput,
    automationId: string | null,
  ): Promise<CloudAutomation | null> {
    if (actor.delegation)
      throw new CloudError(
        403,
        "automation_owner_required",
        "Create automations in the browser.",
      );
    return this.database.transaction(async (sql) => {
      const current = automationId
        ? await readAutomation(sql, actor, automationId)
        : null;
      if (current) {
        requireOwner(current, actor);
        if (current.teamId !== input.teamId)
          throw new CloudError(
            422,
            "automation_team",
            "An automation stays in its original team.",
          );
      }
      const team = await requireTeam(sql, actor, input.teamId, true);
      await validateAutomation(sql, actor, team, input);
      return current;
    });
  }

  create(
    actor: CloudActor,
    key: string,
    input: AutomationInput,
  ): Promise<AutomationSecret> {
    if (actor.delegation)
      throw new CloudError(
        403,
        "automation_owner_required",
        "Create automations in the browser.",
      );
    return this.database.transaction(async (sql) => {
      const team = await requireTeam(sql, actor, input.teamId, true);
      return command(
        sql,
        actor,
        key,
        { kind: "automation.create", input },
        async () => {
          const count = (
            await sql.query<{ count: number }>(
              "SELECT count(*)::integer AS count FROM cloud_automations WHERE organization_id=$1 AND team_id=$2",
              [actor.organizationId, team.id],
            )
          ).rows[0]!.count;
          if (count >= maximumAutomationsPerTeam)
            throw new CloudError(
              409,
              "automation_limit",
              `This team has reached its limit of ${maximumAutomationsPerTeam} automations.`,
            );
          await validateAutomation(sql, actor, team, input);
          const id = randomUUID();
          await sql.query(
            `INSERT INTO cloud_automations (organization_id,id,team_id,owner_id,name,trigger_kind,trigger,conditions,actions,daily_limit,next_run_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
            [
              actor.organizationId,
              id,
              team.id,
              actor.userId,
              input.name,
              input.trigger.kind,
              JSON.stringify(input.trigger),
              JSON.stringify(input.conditions),
              JSON.stringify(input.actions),
              input.dailyLimit,
              nextRunAt(input, true),
            ],
          );
          return {
            id,
            webhookUrl:
              input.trigger.kind === "webhook"
                ? await this.issueWebhook(sql, actor.organizationId, id)
                : null,
          };
        },
      );
    });
  }

  update(
    actor: CloudActor,
    key: string,
    id: string,
    input: { revision: number; automation: AutomationInput },
  ): Promise<AutomationSecret> {
    return this.database.transaction(async (sql) => {
      const current = await readAutomation(sql, actor, id, true);
      requireOwner(current, actor);
      return command(
        sql,
        actor,
        key,
        { kind: "automation.update", id, input },
        async () => {
          checkRevision(current.revision, input.revision);
          const automation = input.automation;
          if (automation.teamId !== current.teamId)
            throw new CloudError(
              422,
              "automation_team",
              "An automation stays in its original team.",
            );
          const team = await requireTeam(sql, actor, current.teamId, true);
          await validateAutomation(sql, actor, team, automation);
          await sql.query(
            `UPDATE cloud_automations SET name=$3,trigger_kind=$4,trigger=$5,conditions=$6,actions=$7,daily_limit=$8,next_run_at=$9,
            webhook_hash=CASE WHEN $4='webhook' THEN webhook_hash END,error=NULL,revision=revision+1 WHERE organization_id=$1 AND id=$2`,
            [
              actor.organizationId,
              id,
              automation.name,
              automation.trigger.kind,
              JSON.stringify(automation.trigger),
              JSON.stringify(automation.conditions),
              JSON.stringify(automation.actions),
              automation.dailyLimit,
              nextRunAt(automation, current.enabled),
            ],
          );
          return {
            id,
            webhookUrl:
              automation.trigger.kind === "webhook" &&
              !current.webhookConfigured
                ? await this.issueWebhook(sql, actor.organizationId, id)
                : null,
          };
        },
      );
    });
  }

  setEnabled(
    actor: CloudActor,
    key: string,
    id: string,
    input: { revision: number; enabled: boolean },
  ): Promise<{ id: string }> {
    return this.database.transaction(async (sql) => {
      const current = await readAutomation(sql, actor, id, true);
      if (input.enabled || current.ownerId === actor.userId)
        requireOwner(current, actor);
      else await requireMembership(sql, actor, "admin");
      return command(
        sql,
        actor,
        key,
        { kind: "automation.state", id, input },
        async () => {
          checkRevision(current.revision, input.revision);
          if (input.enabled) {
            const team = await requireTeam(sql, actor, current.teamId, true);
            await validateAutomation(sql, actor, team, current);
          }
          await sql.query(
            "UPDATE cloud_automations SET enabled=$3,next_run_at=$4,error=NULL,revision=revision+1 WHERE organization_id=$1 AND id=$2",
            [
              actor.organizationId,
              id,
              input.enabled,
              nextRunAt(current, input.enabled),
            ],
          );
          return { id };
        },
      );
    });
  }

  remove(actor: CloudActor, id: string): Promise<void> {
    return this.database.transaction(async (sql) => {
      const current = await readAutomation(sql, actor, id, true);
      if (current.ownerId === actor.userId) requireOwner(current, actor);
      else await requireMembership(sql, actor, "admin");
      await sql.query(
        "DELETE FROM cloud_automations WHERE organization_id=$1 AND id=$2",
        [actor.organizationId, id],
      );
    });
  }

  rotateWebhook(actor: CloudActor, id: string): Promise<AutomationSecret> {
    return this.database.transaction(async (sql) => {
      const current = await readAutomation(sql, actor, id, true);
      requireOwner(current, actor);
      if (current.trigger.kind !== "webhook")
        throw new CloudError(
          409,
          "webhook_unavailable",
          "Only webhook automations have a webhook address.",
        );
      return {
        id,
        webhookUrl: await this.issueWebhook(sql, actor.organizationId, id),
      };
    });
  }

  async run(
    actor: CloudActor,
    key: string,
    id: string,
    input: { issueId: string | null },
  ): Promise<{ runIds: string[] }> {
    const result = await this.database.transaction(async (sql) => {
      await requireMembership(sql, actor, "write");
      const automation = await readAutomation(sql, actor, id, true);
      await requireTeam(sql, actor, automation.teamId, true);
      return command(
        sql,
        actor,
        key,
        { kind: "automation.run", id, input },
        async () => {
          if (!automation.enabled)
            throw new CloudError(
              409,
              "automation_disabled",
              "Enable the automation before running it.",
            );
          const owner = {
            organizationId: actor.organizationId,
            userId: automation.ownerId,
          };
          if (automation.trigger.kind === "schedule")
            return {
              runIds: await createScheduledRuns(
                sql,
                owner,
                automation,
                `manual:${key}`,
                actor.userId,
              ),
            };
          if (automation.trigger.kind !== "manual")
            throw new CloudError(
              409,
              "automation_not_manual",
              "This automation runs on its trigger.",
            );
          if (input.issueId) {
            const issue = await readIssue(sql, actor, input.issueId);
            if (issue.teamId !== automation.teamId)
              throw new CloudError(
                422,
                "automation_team",
                "Choose an issue of the automation's team.",
              );
            if (
              !(await issueMatchesConditions(sql, owner, automation, issue.id))
            )
              throw new CloudError(
                409,
                "automation_conditions",
                "This issue does not match the automation's conditions.",
              );
          } else if (automation.actions.some(actionNeedsIssue))
            throw new CloudError(
              422,
              "automation_issue_required",
              "Choose an issue to run this automation on.",
            );
          const runId = await insertAutomationRun(
            sql,
            actor.organizationId,
            automation,
            {
              dedupeKey: `manual:${key}`,
              trigger: "manual",
              issueId: input.issueId,
              actorId: actor.userId,
              depth: 0,
              variables: {},
            },
          );
          if (!runId)
            throw new CloudError(
              429,
              "automation_daily_limit",
              "This automation reached its daily run limit.",
            );
          return { runIds: [runId] };
        },
      );
    });
    this.wake();
    return result;
  }

  async receiveWebhook(
    token: string,
    payload: unknown,
  ): Promise<{ runId: string }> {
    const result = await this.database.transaction(async (sql) => {
      const automation = (
        await sql.query<
          StoredAutomation & { organizationId: string } & Record<
              string,
              unknown
            >
        >(
          `SELECT ${storedAutomationColumns},organization_id AS "organizationId" FROM cloud_automations WHERE webhook_hash=$1 AND trigger_kind='webhook' FOR SHARE`,
          [hashWebhookToken(token)],
        )
      ).rows[0];
      if (!automation)
        throw new CloudError(404, "not_found", "Webhook is unavailable.");
      if (!automation.enabled)
        throw new CloudError(
          409,
          "automation_disabled",
          "This automation is paused.",
        );
      const owner = {
        organizationId: automation.organizationId,
        userId: automation.ownerId,
      };
      const reference =
        payload &&
        typeof payload === "object" &&
        "issue" in payload &&
        typeof payload.issue === "string"
          ? payload.issue.trim().toUpperCase()
          : null;
      let issueId: string | null = null;
      if (reference) {
        issueId =
          (
            await sql.query<{ id: string }>(
              "SELECT id FROM cloud_issues WHERE organization_id=$1 AND team_id=$2 AND identifier=$3",
              [owner.organizationId, automation.teamId, reference],
            )
          ).rows[0]?.id ?? null;
        if (!issueId)
          throw new CloudError(
            404,
            "issue_unavailable",
            `${reference.slice(0, 40)} is unavailable in this team.`,
          );
        if (!(await issueMatchesConditions(sql, owner, automation, issueId)))
          throw new CloudError(
            409,
            "automation_conditions",
            "The issue does not match the automation's conditions.",
          );
      }
      const runId = await insertAutomationRun(
        sql,
        owner.organizationId,
        automation,
        {
          dedupeKey: `webhook:${randomUUID()}`,
          trigger: "webhook",
          issueId,
          actorId: null,
          depth: 0,
          variables: { payload },
        },
      );
      if (!runId)
        throw new CloudError(
          429,
          "automation_daily_limit",
          "This automation reached its daily run limit.",
        );
      return { runId };
    });
    this.wake();
    return result;
  }
}
