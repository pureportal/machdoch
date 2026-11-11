import type { CloudActor } from "../../../lib/cloud-contract";
import {
  maximumChatContext,
  type ChatContextReference,
  type CloudChat,
  type CloudChatTurn,
} from "../../../lib/cloud-chat-contract";
import { CloudError, requireMembership, teamVisibility } from "../access";
import type { CloudSql } from "../database";

const timestamp = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

const chatContextColumn = `COALESCE((SELECT jsonb_agg(jsonb_build_object('kind',x.kind,'id',x.entity_id,'label',e.label,'title',e.title,'turnSequence',x.turn_sequence) ORDER BY x.created_at,x.kind,x.entity_id)
  FROM cloud_chat_context x
  JOIN LATERAL (
    SELECT i.identifier AS label,i.title,i.team_id FROM cloud_issues i WHERE x.kind='issue' AND i.organization_id=x.organization_id AND i.id=x.entity_id
    UNION ALL SELECT p.name,NULL,p.team_id FROM cloud_projects p WHERE x.kind='project' AND p.organization_id=x.organization_id AND p.id=x.entity_id
    UNION ALL SELECT c.name,NULL,c.team_id FROM cloud_cycles c WHERE x.kind='cycle' AND c.organization_id=x.organization_id AND c.id=x.entity_id
    UNION ALL SELECT k.name,NULL,k.id FROM cloud_teams k WHERE x.kind='team' AND k.organization_id=x.organization_id AND k.id=x.entity_id
  ) e ON true
  JOIN cloud_teams t ON t.organization_id=x.organization_id AND t.id=e.team_id
  JOIN cloud_memberships m ON m.organization_id=x.organization_id AND m.user_id=$2
  WHERE x.organization_id=ch.organization_id AND x.chat_id=ch.id AND ${teamVisibility}),'[]'::jsonb)`;

export const chatColumns = `ch.id,ch.title,ch.revision,${timestamp("ch.updated_at")} AS "updatedAt",${chatContextColumn} AS context`;
export const chatDeadlineSeconds = 300;
export const maximumChatInputBytes = 96 * 1024;
export const turnColumns = `id,sequence,provider_id AS "providerId",model,prompt,answer,state,revision,error_code AS "errorCode",request_id AS "requestId",
  ${timestamp("created_at")} AS "createdAt",${timestamp("started_at")} AS "startedAt",${timestamp("finished_at")} AS "finishedAt",steps,actions,question`;

export async function readChat(
  sql: CloudSql,
  actor: CloudActor,
  id: string,
  write = false,
): Promise<CloudChat> {
  await requireMembership(sql, actor, write ? "write" : "read");
  const chat = (
    await sql.query<CloudChat & Record<string, unknown>>(
      `SELECT ${chatColumns}
    FROM cloud_chats ch WHERE ch.organization_id=$1 AND ch.user_id=$2 AND ch.id=$3 FOR ${write ? "UPDATE" : "SHARE"} OF ch`,
      [actor.organizationId, actor.userId, id],
    )
  ).rows[0];
  if (!chat)
    throw new CloudError(404, "not_found", "Conversation is unavailable.");
  return chat;
}

export async function addChatContext(
  sql: CloudSql,
  actor: CloudActor,
  chatId: string,
  sequence: number,
  context: ChatContextReference[],
): Promise<void> {
  for (const entry of context) {
    const table = {
      issue: "cloud_issues",
      project: "cloud_projects",
      cycle: "cloud_cycles",
      team: "cloud_teams",
    }[entry.kind];
    const teamColumn = entry.kind === "team" ? "e.id" : "e.team_id";
    const visible = await sql.query(
      `SELECT 1 FROM ${table} e JOIN cloud_teams t ON t.organization_id=e.organization_id AND t.id=${teamColumn}
      JOIN cloud_memberships m ON m.organization_id=e.organization_id AND m.user_id=$2
      WHERE e.organization_id=$1 AND e.id=$3 AND ${teamVisibility}`,
      [actor.organizationId, actor.userId, entry.id],
    );
    if (!visible.rows.length)
      throw new CloudError(
        404,
        "context_unavailable",
        `This ${entry.kind} is unavailable. Remove it from the context.`,
      );
    await sql.query(
      "INSERT INTO cloud_chat_context (organization_id,chat_id,kind,entity_id,turn_sequence) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
      [actor.organizationId, chatId, entry.kind, entry.id, sequence],
    );
  }
  const count = (
    await sql.query<{ count: number }>(
      "SELECT count(*)::integer AS count FROM cloud_chat_context WHERE organization_id=$1 AND chat_id=$2",
      [actor.organizationId, chatId],
    )
  ).rows[0]!.count;
  if (count > maximumChatContext)
    throw new CloudError(
      422,
      "context_limit",
      `A conversation holds up to ${maximumChatContext} context items. Start a new conversation.`,
    );
}

export async function readTurn(
  sql: CloudSql,
  actor: CloudActor,
  id: string,
  write = false,
): Promise<CloudChatTurn & { chatId: string }> {
  const reference = (
    await sql.query<{ chat_id: string }>(
      "SELECT chat_id FROM cloud_chat_turns WHERE organization_id=$1 AND id=$2",
      [actor.organizationId, id],
    )
  ).rows[0];
  if (!reference)
    throw new CloudError(404, "not_found", "Message is unavailable.");
  await readChat(sql, actor, reference.chat_id, write);
  const turn = (
    await sql.query<CloudChatTurn & Record<string, unknown>>(
      `SELECT ${turnColumns} FROM cloud_chat_turns WHERE organization_id=$1 AND id=$2 FOR ${write ? "UPDATE" : "SHARE"}`,
      [actor.organizationId, id],
    )
  ).rows[0]!;
  return { ...turn, chatId: reference.chat_id };
}
