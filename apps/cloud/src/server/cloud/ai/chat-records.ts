import type { CloudActor } from "../../../lib/cloud-contract";
import {
  maximumChatContext,
  type ChatContextReference,
  type CloudChat,
  type CloudChatTurn,
} from "../../../lib/cloud-chat-contract";
import { CloudError, requireMembership } from "../access";
import type { CloudSql } from "../database";
import { chatContextColumn, chatContextSource } from "./chat-context-sources";

const timestamp = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

export const chatColumns = `ch.id,ch.title,ch.revision,${timestamp("ch.updated_at")} AS "updatedAt",${chatContextColumn} AS context`;
export const chatDeadlineSeconds = 300;
export const maximumChatInputBytes = 256 * 1024;
export const turnColumns = `id,sequence,provider_id AS "providerId",model,prompt,answer,state,revision,error_code AS "errorCode",request_id AS "requestId",
  ${timestamp("created_at")} AS "createdAt",${timestamp("started_at")} AS "startedAt",${timestamp("finished_at")} AS "finishedAt",steps,actions,question,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('id',a.id,'name',a.name,'mime',a.mime,'kind',a.kind,'byteLength',a.byte_length,'width',a.width,'height',a.height,
  'url','/api/v1/attachments/'||a.id) ORDER BY a.created_at,a.id) FROM cloud_attachments a
  WHERE a.organization_id=cloud_chat_turns.organization_id AND a.turn_id=cloud_chat_turns.id AND a.state='ready'),'[]'::jsonb) AS attachments`;

export async function readChat(
  sql: CloudSql,
  actor: CloudActor,
  id: string,
  write = false,
): Promise<CloudChat> {
  await requireMembership(sql, actor, write ? "ai.chat" : undefined);
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
    const visible = await sql.query(
      chatContextSource(entry.kind, {
        organization: "$1",
        user: "$2",
        id: "$3",
      }),
      [actor.organizationId, actor.userId, entry.id],
    );
    if (!visible.rows.length)
      throw new CloudError(
        404,
        "context_unavailable",
        `This ${entry.kind.replace("_", " ")} is unavailable. Remove it from the context.`,
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
