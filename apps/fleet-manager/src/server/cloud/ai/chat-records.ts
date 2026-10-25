import type { CloudActor } from "../../../lib/cloud-contract";
import type {
  CloudChat,
  CloudChatTurn,
} from "../../../lib/cloud-chat-contract";
import { CloudError, requireMembership } from "../access";
import type { CloudSql } from "../database";

export const chatSystemPrompt =
  "You are the conversational assistant in machdoch.cloud. Answer the latest user message using the supplied JSON conversation. You have no tools or access to repositories, devices, or external applications in this conversation.";
export const chatDeadlineSeconds = 120;
export const maximumChatInputBytes = 64 * 1024;
export const turnColumns = `id,sequence,provider_id AS "providerId",model,prompt,answer,state,revision,error_code AS "errorCode",request_id AS "requestId",
  to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt"`;

export async function readChat(
  sql: CloudSql,
  actor: CloudActor,
  id: string,
  write = false,
): Promise<CloudChat> {
  await requireMembership(sql, actor, write ? "write" : "read");
  const chat = (
    await sql.query<CloudChat & Record<string, unknown>>(
      `SELECT id,title,revision,to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "updatedAt"
    FROM cloud_chats WHERE organization_id=$1 AND user_id=$2 AND id=$3 FOR ${write ? "UPDATE" : "SHARE"}`,
      [actor.organizationId, actor.userId, id],
    )
  ).rows[0];
  if (!chat)
    throw new CloudError(404, "not_found", "Conversation is unavailable.");
  return chat;
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
