import type { CloudActor } from "../../../lib/cloud-contract";
import type {
  CloudDocument,
  CloudDocumentSummary,
  CloudLoop,
  CloudLoopRunDetail,
  CloudLoopSummary,
  LoopConfig,
  LoopMemoryEntry,
  LoopRevision,
  LoopSettings,
  LoopSettingsInput,
  LoopTemplateInstall,
  LoopTranscriptTurn,
} from "../../../lib/cloud-loop-contract";
import {
  loopTemplateProblem,
  loopTemplates,
} from "../../../lib/loop-templates";
import {
  checkRevision,
  CloudError,
  command,
  requireMembership,
  requireTeam,
  teamVisibility,
} from "../access";
import type { CloudDatabase, CloudSql } from "../database";
import {
  insertAutomationRun,
  runColumns,
  runFrom,
} from "../automation/automation-records";
import { insertAutomation, runRejected } from "../automation/automations";
import { readDocument, readDocuments, insertDocument } from "./loop-documents";
import {
  readLoopConfig,
  readLoopIdentity,
  readLoopSummaries,
  requireLoopOwner,
  writeLoopConfig,
  type LoopIdentity,
} from "./loop-records";
import { readLoopSettings, writeLoopSettings } from "./loop-settings";

interface StoredRun extends Record<string, unknown> {
  id: string;
  automationId: string;
  teamId: string;
  ownerId: string;
  trigger: string;
  issueId: string | null;
  state: string;
  payload: Record<string, unknown>;
  triggerVariables: Record<string, unknown>;
  variables: Record<string, unknown>;
  approvedBy: string | null;
}

async function readStoredRun(
  sql: CloudSql,
  actor: CloudActor,
  runId: string,
  write = false,
): Promise<StoredRun> {
  const run = (
    await sql.query<StoredRun>(
      `SELECT r.id,r.automation_id AS "automationId",a.team_id AS "teamId",a.owner_id AS "ownerId",r.trigger,r.issue_id AS "issueId",r.state,
        r.payload,r.trigger_variables AS "triggerVariables",r.variables,r.approved_by AS "approvedBy"
      FROM cloud_automation_runs r JOIN cloud_automations a ON a.organization_id=r.organization_id AND a.id=r.automation_id
      JOIN cloud_teams t ON t.organization_id=a.organization_id AND t.id=a.team_id
      JOIN cloud_memberships m ON m.organization_id=a.organization_id AND m.user_id=$2
      WHERE r.organization_id=$1 AND r.id=$3 AND ${teamVisibility} FOR ${write ? "UPDATE" : "SHARE"} OF r`,
      [actor.organizationId, actor.userId, runId],
    )
  ).rows[0];
  if (!run) throw new CloudError(404, "not_found", "Run is unavailable.");
  return run;
}

function pendingInputKey(run: StoredRun): string | null {
  const pending = run.variables.loopInput as { key?: unknown } | undefined;
  return run.state === "waiting" && typeof pending?.key === "string"
    ? pending.key
    : null;
}

async function requireCodeAccess(
  sql: CloudSql,
  organizationId: string,
  config: LoopConfig,
): Promise<void> {
  const settings = await readLoopSettings(sql, organizationId);
  if (settings.codeAccess === "all") return;
  const allowed = new Set(settings.repositoryIds);
  if (
    config.contextSources.some(
      (source) =>
        source.kind === "repository" && !allowed.has(source.repositoryId),
    )
  )
    throw new CloudError(
      422,
      "loop_code_access",
      "Loops may only read the repositories allowed in loop settings.",
    );
}

function requireAutomationLoop(loop: LoopIdentity): void {
  if (loop.kind !== "automation")
    throw new CloudError(
      422,
      "loop_schedule",
      "Scheduled issue loops cannot be replayed.",
    );
}

export class CloudLoops {
  constructor(
    private readonly database: CloudDatabase,
    private readonly wake: () => void,
  ) {}

  list(actor: CloudActor): Promise<CloudLoopSummary[]> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor);
      return readLoopSummaries(sql, actor, null);
    });
  }

  get(actor: CloudActor, id: string): Promise<CloudLoop> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor);
      return this.read(sql, actor, id);
    });
  }

  private async read(
    sql: CloudSql,
    actor: CloudActor,
    id: string,
  ): Promise<CloudLoop> {
    const identity = await readLoopIdentity(sql, actor, id);
    const summary = (await readLoopSummaries(sql, actor, id))[0]!;
    const parameters = [actor.organizationId, id];
    const memory = (
      await sql.query<LoopMemoryEntry & Record<string, unknown>>(
        "SELECT key,value FROM cloud_loop_memory WHERE organization_id=$1 AND loop_id=$2 ORDER BY key",
        parameters,
      )
    ).rows;
    const revisions = (
      await sql.query<LoopRevision & Record<string, unknown>>(
        `SELECT revision,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt"
        FROM cloud_loop_revisions WHERE organization_id=$1 AND loop_id=$2 ORDER BY revision DESC LIMIT 50`,
        parameters,
      )
    ).rows;
    return {
      ...summary,
      revision: identity.revision,
      consecutiveFailures: identity.consecutiveFailures,
      config: await readLoopConfig(sql, actor.organizationId, id),
      memory,
      revisions,
    };
  }

  updateConfig(
    actor: CloudActor,
    key: string,
    id: string,
    input: { revision: number; config: LoopConfig },
  ): Promise<CloudLoop> {
    return this.database.transaction(async (sql) => {
      const loop = await readLoopIdentity(sql, actor, id, true);
      requireLoopOwner(loop, actor);
      await requireTeam(sql, actor, loop.teamId, "automations.edit");
      await command(
        sql,
        actor,
        key,
        { kind: "loop.update", id, input },
        async () => {
          checkRevision(loop.revision, input.revision);
          await requireCodeAccess(sql, actor.organizationId, input.config);
          await writeLoopConfig(sql, actor, loop, input.config);
          return {};
        },
      );
      return this.read(sql, actor, id);
    });
  }

  setMemory(
    actor: CloudActor,
    key: string,
    id: string,
    entry: LoopMemoryEntry,
  ): Promise<CloudLoop> {
    return this.database.transaction(async (sql) => {
      const loop = await readLoopIdentity(sql, actor, id, true);
      requireLoopOwner(loop, actor);
      await command(
        sql,
        actor,
        key,
        { kind: "loop.memory.set", id, entry },
        async () => {
          await sql.query(
            `INSERT INTO cloud_loop_memory (organization_id,loop_id,key,value) VALUES ($1,$2,$3,$4)
            ON CONFLICT (organization_id,loop_id,key) DO UPDATE SET value=EXCLUDED.value,updated_at=clock_timestamp()`,
            [actor.organizationId, id, entry.key, entry.value],
          );
          return {};
        },
      );
      return this.read(sql, actor, id);
    });
  }

  deleteMemory(
    actor: CloudActor,
    key: string,
    id: string,
    memoryKey: string,
  ): Promise<CloudLoop> {
    return this.database.transaction(async (sql) => {
      const loop = await readLoopIdentity(sql, actor, id, true);
      requireLoopOwner(loop, actor);
      await command(
        sql,
        actor,
        key,
        { kind: "loop.memory.delete", id, memoryKey },
        async () => {
          await sql.query(
            "DELETE FROM cloud_loop_memory WHERE organization_id=$1 AND loop_id=$2 AND key=$3",
            [actor.organizationId, id, memoryKey],
          );
          return {};
        },
      );
      return this.read(sql, actor, id);
    });
  }

  getSettings(actor: CloudActor): Promise<LoopSettings> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor, "ai.manage");
      return readLoopSettings(sql, actor.organizationId);
    });
  }

  updateSettings(
    actor: CloudActor,
    key: string,
    input: { revision: number; settings: LoopSettingsInput },
  ): Promise<LoopSettings> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor, "ai.manage");
      await command(
        sql,
        actor,
        key,
        { kind: "loop.settings", input },
        async () => {
          await writeLoopSettings(sql, actor, input.revision, input.settings);
          return {};
        },
      );
      return readLoopSettings(sql, actor.organizationId);
    });
  }

  listDocuments(
    actor: CloudActor,
    teamId: string | null,
  ): Promise<CloudDocumentSummary[]> {
    return this.database.transaction((sql) =>
      readDocuments(sql, actor, teamId),
    );
  }

  createDocument(
    actor: CloudActor,
    key: string,
    input: { teamId: string; title: string },
  ): Promise<CloudDocumentSummary> {
    return this.database.transaction((sql) =>
      command(
        sql,
        actor,
        key,
        { kind: "document.create", input },
        async (): Promise<CloudDocumentSummary & Record<string, unknown>> => ({
          ...(await insertDocument(sql, actor, input)),
        }),
      ),
    );
  }

  getDocument(actor: CloudActor, id: string): Promise<CloudDocument> {
    return this.database.transaction((sql) => readDocument(sql, actor, id));
  }

  async setKilled(
    actor: CloudActor,
    key: string,
    id: string,
    killed: boolean,
  ): Promise<CloudLoop> {
    const result = await this.database.transaction(async (sql) => {
      const loop = await readLoopIdentity(sql, actor, id, true);
      if (loop.ownerId !== actor.userId || actor.delegation)
        await requireMembership(sql, actor, "teams.manage");
      await command(
        sql,
        actor,
        key,
        { kind: "loop.kill", id, killed },
        async () => {
          await sql.query(
            "UPDATE cloud_loops SET killed_at=CASE WHEN $3 THEN COALESCE(killed_at,clock_timestamp()) END WHERE organization_id=$1 AND id=$2",
            [actor.organizationId, id, killed],
          );
          return {};
        },
      );
      return this.read(sql, actor, id);
    });
    this.wake();
    return result;
  }

  async approve(actor: CloudActor, key: string, runId: string): Promise<void> {
    await this.database.transaction(async (sql) => {
      const run = await readStoredRun(sql, actor, runId, true);
      await requireTeam(sql, actor, run.teamId, "automations.edit");
      await command(
        sql,
        actor,
        key,
        { kind: "loop.approve", runId },
        async () => {
          if (
            run.state !== "waiting" ||
            !run.variables.loopApproval ||
            run.approvedBy
          )
            throw new CloudError(
              409,
              "loop_approval",
              "This run is not waiting for approval.",
            );
          await sql.query(
            "UPDATE cloud_automation_runs SET approved_by=$3 WHERE organization_id=$1 AND id=$2",
            [actor.organizationId, runId, actor.userId],
          );
          return {};
        },
      );
    });
    this.wake();
  }

  async answer(
    actor: CloudActor,
    key: string,
    runId: string,
    value: string,
  ): Promise<void> {
    await this.database.transaction(async (sql) => {
      const run = await readStoredRun(sql, actor, runId, true);
      await requireTeam(sql, actor, run.teamId, "automations.edit");
      await command(
        sql,
        actor,
        key,
        { kind: "loop.answer", runId, value },
        async () => {
          const memoryKey = pendingInputKey(run);
          if (!memoryKey)
            throw new CloudError(
              409,
              "loop_input",
              "This run is not waiting for input.",
            );
          await sql.query(
            `INSERT INTO cloud_loop_memory (organization_id,loop_id,key,value) VALUES ($1,$2,$3,$4)
            ON CONFLICT (organization_id,loop_id,key) DO UPDATE SET value=EXCLUDED.value,updated_at=clock_timestamp()`,
            [actor.organizationId, run.automationId, memoryKey, value],
          );
          return {};
        },
      );
    });
    this.wake();
  }

  async replay(
    actor: CloudActor,
    key: string,
    runId: string,
  ): Promise<{ runId: string }> {
    const result = await this.database.transaction(async (sql) => {
      const run = await readStoredRun(sql, actor, runId);
      const loop = await readLoopIdentity(sql, actor, run.automationId);
      requireLoopOwner(loop, actor);
      return command(sql, actor, key, { kind: "loop.replay", runId }, () =>
        this.rerun(sql, actor, loop, run, `replay:${key}`, false),
      );
    });
    this.wake();
    return result;
  }

  async dryRun(
    actor: CloudActor,
    key: string,
    id: string,
    runId: string | null,
  ): Promise<{ runId: string }> {
    const result = await this.database.transaction(async (sql) => {
      const loop = await readLoopIdentity(sql, actor, id);
      requireLoopOwner(loop, actor);
      requireAutomationLoop(loop);
      const recorded = runId ? await readStoredRun(sql, actor, runId) : null;
      if (recorded && recorded.automationId !== id)
        throw new CloudError(
          422,
          "loop_run",
          "Choose a recorded run of this loop.",
        );
      return command(sql, actor, key, { kind: "loop.dry_run", id, runId }, () =>
        this.rerun(sql, actor, loop, recorded, `dry:${key}`, true),
      );
    });
    this.wake();
    return result;
  }

  private async rerun(
    sql: CloudSql,
    actor: CloudActor,
    loop: LoopIdentity,
    recorded: StoredRun | null,
    dedupeKey: string,
    dryRun: boolean,
  ): Promise<{ runId: string }> {
    requireAutomationLoop(loop);
    const automation = (
      await sql.query<{ id: string; dailyLimit: number }>(
        `SELECT id,daily_limit AS "dailyLimit" FROM cloud_automations WHERE organization_id=$1 AND id=$2`,
        [actor.organizationId, loop.id],
      )
    ).rows[0]!;
    const started = await insertAutomationRun(
      sql,
      actor.organizationId,
      automation,
      {
        dedupeKey,
        trigger: recorded?.trigger ?? "manual",
        issueId: recorded?.issueId ?? null,
        actorId: actor.userId,
        depth: 0,
        variables: recorded?.triggerVariables ?? {},
        payload: recorded?.payload ?? {},
        replayOf: recorded?.id ?? null,
        dryRun,
      },
    );
    if (!started.id) throw runRejected(started.rejection);
    return { runId: started.id };
  }

  runDetail(actor: CloudActor, runId: string): Promise<CloudLoopRunDetail> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor);
      const stored = await readStoredRun(sql, actor, runId);
      const run = (
        await sql.query<
          Omit<
            CloudLoopRunDetail,
            "transcript" | "awaitingApproval" | "awaitingInput"
          > &
            Record<string, unknown>
        >(
          `SELECT ${runColumns},r.payload,r.resolved_context AS "resolvedContext",ap.name AS "approvedByName"
          FROM ${runFrom} LEFT JOIN cloud_users ap ON ap.id=r.approved_by
          WHERE r.organization_id=$1 AND r.id=$3`,
          [actor.organizationId, actor.userId, runId],
        )
      ).rows[0]!;
      const transcript = run.chatId
        ? (
            await sql.query<LoopTranscriptTurn & Record<string, unknown>>(
              "SELECT prompt,answer,steps FROM cloud_chat_turns WHERE organization_id=$1 AND chat_id=$2 ORDER BY sequence",
              [actor.organizationId, run.chatId],
            )
          ).rows
        : [];
      return {
        ...run,
        transcript,
        awaitingApproval:
          stored.state === "waiting" &&
          !!stored.variables.loopApproval &&
          !stored.approvedBy,
        awaitingInput: pendingInputKey(stored),
      };
    });
  }

  async installTemplate(
    actor: CloudActor,
    key: string,
    install: LoopTemplateInstall,
  ): Promise<CloudLoop> {
    if (actor.delegation)
      throw new CloudError(
        403,
        "loop_owner_required",
        "Install loops in the browser.",
      );
    return this.database.transaction(async (sql) => {
      const template = loopTemplates.find(
        (candidate) => candidate.id === install.templateId,
      );
      if (!template)
        throw new CloudError(404, "not_found", "Template is unavailable.");
      const problem = loopTemplateProblem(template, install);
      if (problem) throw new CloudError(422, "loop_template", problem);
      const team = await requireTeam(
        sql,
        actor,
        install.teamId,
        "automations.edit",
      );
      const { id } = await command(
        sql,
        actor,
        key,
        { kind: "loop.template", install },
        async () => {
          const built = template.build(install);
          await requireCodeAccess(sql, actor.organizationId, built.config);
          const id = await insertAutomation(
            sql,
            actor,
            team,
            built.automation,
            false,
          );
          await writeLoopConfig(
            sql,
            actor,
            { id, teamId: team.id },
            built.config,
          );
          return { id };
        },
      );
      return this.read(sql, actor, id);
    });
  }
}
