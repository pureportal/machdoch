import { randomUUID } from "node:crypto";
import type { CloudActor } from "../../../lib/cloud-contract";
import {
  resolveHandoff,
  type AgentHandoffInput,
  type HandoffOptions,
} from "../../../lib/agent-handoff";
import { CloudError } from "../access";
import type { CloudDatabase, CloudSql } from "../database";
import { readIssue } from "../planning";
import type { CloudAiProviders } from "./providers";
import type { CloudExecutionProfiles } from "../execution/profiles";
import type { CloudWorkers } from "../execution/workers";
import { admitRun } from "../execution/admission";
import { readTurn } from "./chat-records";

async function handoffSubject(
  sql: CloudSql,
  actor: CloudActor,
  turnId: string,
): Promise<HandoffOptions["subject"]> {
  const { chatId } = await readTurn(sql, actor, turnId);
  const context = (
    await sql.query<{ kind: "issue" | "project"; id: string }>(
      `SELECT kind,entity_id AS id FROM cloud_chat_context WHERE organization_id=$1 AND chat_id=$2 AND kind IN ('issue','project')
      ORDER BY kind='issue' DESC,turn_sequence DESC`,
      [actor.organizationId, chatId],
    )
  ).rows;
  for (const entry of context) {
    if (entry.kind === "issue") {
      const issue = await readIssue(sql, actor, entry.id);
      if (issue.projectId)
        return { kind: "issue", id: issue.id, label: issue.identifier };
      continue;
    }
    const project = (
      await sql.query<{ name: string }>(
        "SELECT name FROM cloud_projects WHERE organization_id=$1 AND id=$2",
        [actor.organizationId, entry.id],
      )
    ).rows[0];
    if (project) return { kind: "project", id: entry.id, label: project.name };
  }
  return null;
}

async function subjectProject(
  sql: CloudSql,
  actor: CloudActor,
  subject: NonNullable<HandoffOptions["subject"]>,
): Promise<{ projectId: string; revision: number }> {
  if (subject.kind === "issue") {
    const issue = await readIssue(sql, actor, subject.id);
    return { projectId: issue.projectId!, revision: issue.revision };
  }
  const project = (
    await sql.query<{ revision: number }>(
      "SELECT revision FROM cloud_projects WHERE organization_id=$1 AND id=$2",
      [actor.organizationId, subject.id],
    )
  ).rows[0];
  if (!project)
    throw new CloudError(404, "not_found", "Project is unavailable.");
  return { projectId: subject.id, revision: project.revision };
}

export class CloudAgentHandoffs {
  constructor(
    private readonly database: CloudDatabase,
    private readonly services: {
      profiles: CloudExecutionProfiles;
      workers: CloudWorkers;
      providers: CloudAiProviders;
    },
  ) {}

  async options(actor: CloudActor, turnId: string): Promise<HandoffOptions> {
    const { subject, projectId } = await this.database.transaction(
      async (sql) => {
        const subject = await handoffSubject(sql, actor, turnId);
        return {
          subject,
          projectId: subject
            ? (await subjectProject(sql, actor, subject)).projectId
            : null,
        };
      },
    );
    if (!subject || !projectId)
      return { subject: null, profiles: [], devices: [], providers: [] };
    const [profiles, clients, providers] = await Promise.all([
      this.services.profiles.list(actor, projectId),
      this.services.workers.listForProject(actor, projectId),
      this.services.providers.list(actor),
    ]);
    return {
      subject,
      profiles: profiles
        .filter((profile) => profile.enabled)
        .map((profile) => ({
          id: profile.id,
          name: profile.name,
          target: profile.target,
        })),
      devices: clients
        .filter(
          (client) =>
            client.online &&
            client.workspaceName !== null &&
            client.profile.target === "client",
        )
        .map((client) => ({
          id: client.id,
          name: client.name,
          profileId: client.profile.id,
        })),
      providers: providers.providers.map((provider) => ({
        id: provider.id,
        name: provider.name,
        kind: provider.provider,
        models: provider.models,
      })),
    };
  }

  async start(
    actor: CloudActor,
    key: string,
    input: AgentHandoffInput,
  ): Promise<{ runId: string }> {
    const options = await this.options(actor, input.turnId);
    const subject = options.subject;
    if (!subject)
      throw new CloudError(
        409,
        "handoff_subject",
        "Add an issue or project to this conversation.",
      );
    const resolution = resolveHandoff(input, options);
    if (!resolution.available)
      throw new CloudError(409, "handoff_unavailable", resolution.reason);
    return this.database.transaction(async (sql) => {
      const turn = await readTurn(sql, actor, input.turnId, true);
      const { revision } = await subjectProject(sql, actor, subject);
      const run = await admitRun(
        sql,
        actor,
        key,
        {
          profileId: resolution.profileId,
          subject:
            subject.kind === "issue"
              ? { kind: "issue", id: subject.id, revision }
              : {
                  kind: "project",
                  id: subject.id,
                  revision,
                  purpose: "maintenance",
                  objective: input.instructions,
                  acceptanceCriteria: input.instructions,
                },
        },
        undefined,
        {
          workerId: resolution.workerId,
          providerId: resolution.providerId,
          agent: resolution.agent,
          model: resolution.model,
          instructions: subject.kind === "issue" ? input.instructions : null,
        },
      );
      await sql.query(
        `INSERT INTO cloud_agent_handoffs (organization_id,id,turn_id,run_id,placement,harness,model)
        VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (organization_id,run_id) DO NOTHING`,
        [
          actor.organizationId,
          randomUUID(),
          turn.id,
          run.id,
          resolution.placement,
          input.harness,
          resolution.model,
        ],
      );
      return { runId: run.id };
    });
  }
}
