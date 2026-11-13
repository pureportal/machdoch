import type { CloudActor } from "../../../lib/cloud-contract";
import type { AgentAction } from "../../../lib/cloud-chat-contract";
import {
  defaultPulseInstructions,
  type PulseInstructions,
  type PulseJob,
  type PulseWriteInput,
} from "../../../lib/cloud-pulse-contract";
import { isCloudError, requireMembership } from "../access";
import { derivedCommandId } from "../command-ids";
import type { CloudDatabase, CloudSql } from "../database";
import { readProject } from "../projects";
import type { CloudChatStore } from "../ai/chat-store";
import type { CloudAgentActions } from "../ai/agent-actions";

const timestamp = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;
const jobColumns = `id,project_ids AS "projectIds",state,detail,error,chat_id AS "chatId",
  to_char(created_at AT TIME ZONE 'UTC',${timestamp}) AS "createdAt",
  to_char(finished_at AT TIME ZONE 'UTC',${timestamp}) AS "finishedAt"`;

interface WaitingJob {
  organizationId: string;
  id: string;
  actorId: string;
  projectIds: string[];
  turnId: string;
}

async function readInstructions(
  sql: CloudSql,
  organizationId: string,
): Promise<PulseInstructions> {
  const stored = (
    await sql.query<{ pulse_instructions: string | null }>(
      "SELECT pulse_instructions FROM cloud_organizations WHERE id=$1",
      [organizationId],
    )
  ).rows[0]?.pulse_instructions;
  return stored
    ? { instructions: stored, custom: true }
    : { instructions: defaultPulseInstructions, custom: false };
}

async function readJob(
  sql: CloudSql,
  organizationId: string,
  id: string,
): Promise<PulseJob> {
  return (
    await sql.query<PulseJob & Record<string, unknown>>(
      `SELECT ${jobColumns} FROM cloud_pulse_jobs WHERE organization_id=$1 AND id=$2`,
      [organizationId, id],
    )
  ).rows[0]!;
}

export function pulsePrompt(
  projects: { id: string; name: string }[],
  instructions: string,
): string {
  return [
    projects.length === 1
      ? "Write the Pulse update for this project:"
      : `Write Pulse updates for these ${projects.length} projects:`,
    ...projects.map((project) => `- ${project.name} (ID ${project.id})`),
    "",
    "Read each project with get_project. Then call propose_project_update exactly once per project with its health, TL;DR and body.",
    "",
    "Follow these Pulse instructions:",
    "<pulse-instructions>",
    instructions,
    "</pulse-instructions>",
    "",
    "Nobody can answer questions, so do not call ask_user. Your updates are posted automatically.",
  ].join("\n");
}

export function pulseUpdatesToPost(
  actions: AgentAction[],
  projectIds: string[],
): AgentAction[] {
  const latest = new Map<string, AgentAction>();
  for (const action of actions)
    if (
      action.state === "pending" &&
      action.kind === "project_update" &&
      projectIds.includes(action.projectId)
    )
      latest.set(action.projectId, action);
  return [...latest.values()];
}

export class CloudPulse {
  constructor(
    private readonly database: CloudDatabase,
    private readonly chat: CloudChatStore,
    private readonly agentActions: CloudAgentActions,
    private readonly wake: () => void,
  ) {}

  instructions(actor: CloudActor): Promise<PulseInstructions> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor);
      return readInstructions(sql, actor.organizationId);
    });
  }

  setInstructions(
    actor: CloudActor,
    instructions: string,
  ): Promise<PulseInstructions> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor, "ai.manage");
      const custom = instructions && instructions !== defaultPulseInstructions;
      await sql.query(
        "UPDATE cloud_organizations SET pulse_instructions=$2 WHERE id=$1",
        [actor.organizationId, custom ? instructions : null],
      );
      return readInstructions(sql, actor.organizationId);
    });
  }

  jobs(actor: CloudActor): Promise<PulseJob[]> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor);
      return (
        await sql.query<PulseJob & Record<string, unknown>>(
          `SELECT ${jobColumns} FROM cloud_pulse_jobs WHERE organization_id=$1 AND actor_id=$2
          AND created_at>clock_timestamp()-interval '1 day' ORDER BY created_at DESC,id LIMIT 10`,
          [actor.organizationId, actor.userId],
        )
      ).rows;
    });
  }

  async start(
    actor: CloudActor,
    key: string,
    input: PulseWriteInput,
  ): Promise<PulseJob> {
    const jobId = derivedCommandId(key, "pulse-job");
    const { projects, instructions } = await this.database.transaction(
      async (sql) => {
        await requireMembership(sql, actor, "ai.chat");
        const projects = [];
        for (const id of new Set(input.projectIds))
          projects.push(await readProject(sql, actor, id, true));
        await sql.query(
          `INSERT INTO cloud_pulse_jobs (organization_id,id,actor_id,project_ids,state) VALUES ($1,$2,$3,$4,'waiting')
          ON CONFLICT (organization_id,id) DO NOTHING`,
          [
            actor.organizationId,
            jobId,
            actor.userId,
            projects.map((project) => project.id),
          ],
        );
        return {
          projects,
          instructions: (await readInstructions(sql, actor.organizationId))
            .instructions,
        };
      },
    );
    try {
      const submission = await this.chat.startHiddenChat(actor, key, {
        owner: { pulseJobId: jobId },
        providerId: input.providerId,
        model: input.model,
        prompt: pulsePrompt(projects, instructions),
        context: projects.map((project) => ({
          kind: "project" as const,
          id: project.id,
        })),
      });
      const job = await this.database.transaction(async (sql) => {
        await sql.query(
          "UPDATE cloud_pulse_jobs SET chat_id=$3,turn_id=$4 WHERE organization_id=$1 AND id=$2 AND turn_id IS NULL",
          [actor.organizationId, jobId, submission.chatId, submission.turnId],
        );
        return readJob(sql, actor.organizationId, jobId);
      });
      this.wake();
      return job;
    } catch (error) {
      await this.database.transaction((sql) =>
        sql.query(
          "DELETE FROM cloud_pulse_jobs WHERE organization_id=$1 AND id=$2 AND turn_id IS NULL",
          [actor.organizationId, jobId],
        ),
      );
      throw error;
    }
  }

  async tick(): Promise<number> {
    const jobs = (
      await this.database.transaction(async (sql) => {
        await sql.query(
          `UPDATE cloud_pulse_jobs SET state='failed',error='Agent did not start.',finished_at=clock_timestamp()
          WHERE state='waiting' AND turn_id IS NULL AND created_at<clock_timestamp()-interval '5 minutes'`,
        );
        return sql.query<WaitingJob & Record<string, unknown>>(
          `SELECT organization_id AS "organizationId",id,actor_id AS "actorId",project_ids AS "projectIds",turn_id AS "turnId"
          FROM cloud_pulse_jobs WHERE state='waiting' AND turn_id IS NOT NULL ORDER BY created_at,id LIMIT 5`,
        );
      })
    ).rows;
    let work = 0;
    for (const job of jobs) {
      try {
        if (await this.settle(job)) work++;
      } catch (error) {
        if (!isCloudError(error)) throw error;
        await this.finish(job, "failed", "", error.message);
        work++;
      }
    }
    return work;
  }

  private async finish(
    job: WaitingJob,
    state: "succeeded" | "failed",
    detail: string,
    error: string | null,
  ): Promise<void> {
    await this.database.transaction((sql) =>
      sql.query(
        "UPDATE cloud_pulse_jobs SET state=$3,detail=$4,error=$5,finished_at=clock_timestamp() WHERE organization_id=$1 AND id=$2",
        [
          job.organizationId,
          job.id,
          state,
          detail.slice(0, 500),
          error?.slice(0, 500) ?? null,
        ],
      ),
    );
  }

  private async settle(job: WaitingJob): Promise<boolean> {
    const turn = (
      await this.database.transaction((sql) =>
        sql.query<{
          state: string;
          error_code: string | null;
          actions: AgentAction[];
        }>(
          "SELECT state,error_code,actions FROM cloud_chat_turns WHERE organization_id=$1 AND id=$2",
          [job.organizationId, job.turnId],
        ),
      )
    ).rows[0];
    if (!turn) {
      await this.finish(
        job,
        "failed",
        "",
        "The Agent conversation is unavailable.",
      );
      return true;
    }
    if (["queued", "running", "cancel_requested"].includes(turn.state))
      return false;
    if (turn.state !== "complete") {
      await this.finish(
        job,
        "failed",
        "",
        `Agent did not finish${turn.error_code ? ` (${turn.error_code.replaceAll("_", " ")})` : ""}.`,
      );
      return true;
    }
    const actor = { organizationId: job.organizationId, userId: job.actorId };
    const applied: AgentAction[] = [];
    const failed: AgentAction[] = [];
    for (const action of pulseUpdatesToPost(turn.actions, job.projectIds)) {
      const result = await this.agentActions.apply(
        actor,
        job.turnId,
        action.id,
      );
      (result.state === "applied" ? applied : failed).push(result);
    }
    const errors = failed
      .map((action) => `${action.title}: ${action.error}`)
      .join(" · ");
    await this.finish(
      job,
      applied.length ? "succeeded" : "failed",
      applied.length
        ? `Posted ${applied.length} ${applied.length === 1 ? "update" : "updates"}`
        : "",
      applied.length ? errors || null : errors || "Agent wrote no updates.",
    );
    return true;
  }
}
