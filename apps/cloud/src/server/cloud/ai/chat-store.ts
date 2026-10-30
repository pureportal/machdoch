import { randomUUID } from "node:crypto";
import type { CloudActor } from "../../../lib/cloud-contract";
import type {
  ChatDetail,
  ChatMessageInput,
  ChatRetryInput,
  CloudChat,
  CloudChatTurn,
  ProviderBudget,
} from "../../../lib/cloud-chat-contract";
import {
  checkRevision,
  CloudError,
  command,
  recordEvent,
  requireMembership,
} from "../access";
import type { CloudDatabase, CloudSql } from "../database";
import {
  readInferenceProvider,
  readProviderBudget,
  requireInferenceCapacity,
} from "./budgets";
import {
  chatColumns,
  chatDeadlineSeconds,
  chatSystemPrompt,
  maximumChatInputBytes,
  readChat,
  readTurn,
  turnColumns,
} from "./chat-records";
import { lockInference, reapInference } from "./inference-records";
import { workspaceContext } from "./workspace-context";
import { readIssue } from "../planning";

export type ChatSubmission = {
  chatId: string;
  turnId: string;
  requestId: string;
};

async function reserveMessage(
  sql: CloudSql,
  actor: CloudActor,
  chat: { id: string; issueId: string | null },
  input: { providerId: string; model: string; prompt: string },
  retry?: CloudChatTurn,
): Promise<ChatSubmission> {
  const chatId = chat.id;
  const provider = await readInferenceProvider(
    sql,
    actor.organizationId,
    input.providerId,
  );
  if (!provider.models.includes(input.model))
    throw new CloudError(
      422,
      "model_unavailable",
      "Choose a configured model for this provider.",
    );
  const previous = (
    await sql.query<{
      prompt: string;
      answer: string;
      state: string;
      sequence: number;
    }>(
      "SELECT prompt,answer,state,sequence FROM cloud_chat_turns WHERE organization_id=$1 AND chat_id=$2 AND ($3::uuid IS NULL OR id<>$3) ORDER BY sequence LIMIT 201",
      [actor.organizationId, chatId, retry?.id ?? null],
    )
  ).rows;
  if (
    previous.some((turn) =>
      ["queued", "running", "cancel_requested"].includes(turn.state),
    )
  )
    throw new CloudError(
      409,
      "response_active",
      "Wait for the current response or stop it before sending another message.",
    );
  if (previous.length >= 200)
    throw new CloudError(
      422,
      "conversation_limit",
      "Start a new conversation to continue.",
    );
  const history = previous.flatMap((turn) => [
    { role: "user", content: turn.prompt },
    ...(turn.state === "complete"
      ? [{ role: "assistant", content: turn.answer }]
      : []),
  ]);
  const userPrompt = JSON.stringify([
    ...history,
    { role: "user", content: input.prompt },
  ]);
  const systemPrompt = `${chatSystemPrompt}\n\n${await workspaceContext(sql, actor, input.prompt, chat.issueId)}`;
  const inputBytes = Buffer.byteLength(userPrompt + systemPrompt, "utf8");
  if (inputBytes > maximumChatInputBytes)
    throw new CloudError(
      422,
      "conversation_limit",
      "This conversation exceeds the input limit. Start a new conversation or shorten your message.",
    );
  const reservation = inputBytes + provider.maxOutputTokens + 1024;
  const budget = await readProviderBudget(sql, actor.organizationId, provider);
  requireInferenceCapacity(budget, reservation);
  const requestId = randomUUID();
  const turnId = retry?.id ?? randomUUID();
  if (retry)
    await sql.query(
      "UPDATE cloud_chat_turns SET state='queued',answer='',error_code=NULL,request_id=$3,provider_id=$4,model=$5,revision=revision+1 WHERE organization_id=$1 AND id=$2",
      [actor.organizationId, turnId, requestId, input.providerId, input.model],
    );
  else
    await sql.query(
      "INSERT INTO cloud_chat_turns (organization_id,id,chat_id,provider_id,model,sequence,prompt,state,request_id) VALUES ($1,$2,$3,$4,$5,$6,$7,'queued',$8)",
      [
        actor.organizationId,
        turnId,
        chatId,
        input.providerId,
        input.model,
        (previous.at(-1)?.sequence ?? 0) + 1,
        input.prompt,
        requestId,
      ],
    );
  await sql.query(
    `INSERT INTO cloud_inference_calls (organization_id,id,turn_id,actor_id,provider_id,provider_revision,model,user_prompt,reserved_tokens,max_output_tokens,budget_day,state,deadline_at,system_prompt)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::date,'queued',clock_timestamp()+$12*interval '1 second',$13)`,
    [
      actor.organizationId,
      requestId,
      turnId,
      actor.userId,
      input.providerId,
      provider.inferenceRevision,
      input.model,
      userPrompt,
      reservation,
      provider.maxOutputTokens,
      budget.budgetDay,
      chatDeadlineSeconds,
      systemPrompt,
    ],
  );
  await sql.query(
    "UPDATE cloud_chats SET revision=revision+1,updated_at=clock_timestamp() WHERE organization_id=$1 AND id=$2",
    [actor.organizationId, chatId],
  );
  await recordEvent(
    sql,
    actor,
    "chat.requested",
    turnId,
    retry ? retry.revision + 1 : 1,
    { requestId },
  );
  return { chatId, turnId, requestId };
}

export class CloudChatStore {
  constructor(private readonly database: CloudDatabase) {}

  submit(
    actor: CloudActor,
    key: string,
    input: ChatMessageInput,
  ): Promise<ChatSubmission> {
    return this.database.transaction(async (sql) => {
      await lockInference(sql, actor.organizationId);
      await requireMembership(sql, actor, "write");
      const chat = input.chatId
        ? await readChat(sql, actor, input.chatId, true)
        : null;
      return command(
        sql,
        actor,
        key,
        { kind: "chat.submit", input },
        async () => {
          await reapInference(sql, actor.organizationId);
          if (chat) {
            checkRevision(chat.revision, input.revision!);
            return reserveMessage(sql, actor, chat, input);
          }
          if (input.issueId) await readIssue(sql, actor, input.issueId);
          const created = { id: randomUUID(), issueId: input.issueId ?? null };
          await sql.query(
            "INSERT INTO cloud_chats (organization_id,id,user_id,title,issue_id) VALUES ($1,$2,$3,$4,$5)",
            [
              actor.organizationId,
              created.id,
              actor.userId,
              input.prompt.split("\n", 1)[0]!.slice(0, 120),
              created.issueId,
            ],
          );
          return reserveMessage(sql, actor, created, input);
        },
      );
    });
  }

  retry(
    actor: CloudActor,
    key: string,
    turnId: string,
    input: ChatRetryInput,
  ): Promise<ChatSubmission> {
    return this.database.transaction(async (sql) => {
      await lockInference(sql, actor.organizationId);
      const turn = await readTurn(sql, actor, turnId, true);
      return command(
        sql,
        actor,
        key,
        { kind: "chat.retry", turnId, input },
        async () => {
          await reapInference(sql, actor.organizationId);
          checkRevision(turn.revision, input.revision);
          if (!["failed", "canceled", "unknown"].includes(turn.state))
            throw new CloudError(
              409,
              "retry_unavailable",
              "Only a stopped or unsuccessful response can be retried.",
            );
          if (
            (
              await sql.query(
                "SELECT id FROM cloud_chat_turns WHERE organization_id=$1 AND chat_id=$2 AND sequence>$3",
                [actor.organizationId, turn.chatId, turn.sequence],
              )
            ).rows.length
          )
            throw new CloudError(
              409,
              "retry_unavailable",
              "Only the latest response can be retried. Send a new message instead.",
            );
          return reserveMessage(
            sql,
            actor,
            await readChat(sql, actor, turn.chatId),
            {
              providerId: input.providerId,
              model: input.model,
              prompt: turn.prompt,
            },
            turn,
          );
        },
      );
    });
  }

  cancel(
    actor: CloudActor,
    key: string,
    turnId: string,
    requestId: string,
  ): Promise<{ id: string }> {
    return this.database.transaction(async (sql) => {
      await lockInference(sql, actor.organizationId);
      const turn = await readTurn(sql, actor, turnId, true);
      return command(
        sql,
        actor,
        key,
        { kind: "chat.cancel", turnId, requestId },
        async () => {
          if (turn.requestId !== requestId)
            throw new CloudError(
              409,
              "response_changed",
              "This response changed. Reload the conversation.",
            );
          if (!["queued", "running"].includes(turn.state))
            return { id: turnId };
          const state =
            turn.state === "queued" ? "canceled" : "cancel_requested";
          await sql.query(
            "UPDATE cloud_inference_calls SET state=$3,actual_tokens=CASE WHEN request_started_at IS NULL AND $3='canceled' THEN 0 ELSE actual_tokens END WHERE organization_id=$1 AND id=$2",
            [actor.organizationId, requestId, state],
          );
          await sql.query(
            "UPDATE cloud_chat_turns SET state=$3,revision=revision+1 WHERE organization_id=$1 AND id=$2",
            [actor.organizationId, turnId, state],
          );
          await recordEvent(
            sql,
            actor,
            "chat.canceled",
            turnId,
            turn.revision + 1,
            { requestId },
          );
          return { id: turnId };
        },
      );
    });
  }

  list(actor: CloudActor, beforeId?: string): Promise<CloudChat[]> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor);
      return (
        await sql.query<CloudChat & Record<string, unknown>>(
          `SELECT ${chatColumns} FROM cloud_chats
        WHERE organization_id=$1 AND user_id=$2 AND ($3::uuid IS NULL OR (created_at,id)<(SELECT created_at,id FROM cloud_chats WHERE organization_id=$1 AND user_id=$2 AND id=$3)) ORDER BY created_at DESC,id DESC LIMIT 50`,
          [actor.organizationId, actor.userId, beforeId ?? null],
        )
      ).rows;
    });
  }

  get(
    actor: CloudActor,
    id: string,
    beforeSequence?: number,
  ): Promise<ChatDetail> {
    return this.database.transaction(async (sql) => {
      await lockInference(sql, actor.organizationId);
      const chat = await readChat(sql, actor, id);
      await reapInference(sql, actor.organizationId);
      const turns = (
        await sql.query<CloudChatTurn & Record<string, unknown>>(
          `SELECT ${turnColumns} FROM cloud_chat_turns WHERE organization_id=$1 AND chat_id=$2 AND ($3::integer IS NULL OR sequence<$3) ORDER BY sequence DESC LIMIT 20`,
          [actor.organizationId, id, beforeSequence ?? null],
        )
      ).rows.reverse();
      return { chat, turns };
    });
  }

  budget(actor: CloudActor, providerId: string): Promise<ProviderBudget> {
    return this.database.transaction(async (sql) => {
      await lockInference(sql, actor.organizationId);
      await requireMembership(sql, actor, "admin");
      await reapInference(sql, actor.organizationId);
      return readProviderBudget(
        sql,
        actor.organizationId,
        await readInferenceProvider(
          sql,
          actor.organizationId,
          providerId,
          true,
        ),
      );
    });
  }
}
