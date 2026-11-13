import { randomUUID } from "node:crypto";
import type { CloudActor } from "../../../lib/cloud-contract";
import type {
  AgentAction,
  ChatContextReference,
  ChatDetail,
  ChatMessage,
  ChatRetryInput,
  ChatUpdate,
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
  addChatContext,
  chatColumns,
  chatDeadlineSeconds,
  maximumChatInputBytes,
  readChat,
  readTurn,
  turnColumns,
} from "./chat-records";
import { lockInference, reapInference } from "./inference-records";
import { agentContext, agentSystemPrompt } from "./agent-context";
import { agentToolSpecs } from "./agent-tools";
import { actionActivity, recordAiActivity } from "../activity/journal";
import type {
  ChatAttachment,
  CloudAttachments,
} from "../attachments/attachments";
import { maximumModelImages } from "../../../lib/cloud-attachment-contract";

export type ChatSubmission = {
  chatId: string;
  turnId: string;
  requestId: string;
};

const agentToolBytes = Buffer.byteLength(
  JSON.stringify(agentToolSpecs),
  "utf8",
);

const documentCharacters = 48_000;
const imageReservationTokens = 3_000;

function attachmentLabel(attachment: ChatAttachment): string {
  const size =
    attachment.width && attachment.height
      ? ` ${attachment.width}×${attachment.height}`
      : "";
  return `${attachment.name} (${attachment.kind}${size}, attachment ${attachment.id})`;
}

function attachmentNote(attachments: ChatAttachment[]): string {
  return attachments.length
    ? `\n\nAttached files: ${attachments.map(attachmentLabel).join("; ")}`
    : "";
}

async function messageContent(
  sql: CloudSql,
  organizationId: string,
  prompt: string,
  attachments: ChatAttachment[],
  files: CloudAttachments,
): Promise<string> {
  const documents: string[] = [];
  for (const attachment of attachments.filter(
    (entry) => entry.kind === "document",
  )) {
    const { text, truncated } = await files.text(
      sql,
      organizationId,
      attachment.id,
      documentCharacters,
    );
    documents.push(
      `<document name="${attachment.name.replaceAll('"', "")}" attachment="${attachment.id}"${truncated ? ' truncated="true"' : ""}>\n${text}\n</document>`,
    );
  }
  return [prompt + attachmentNote(attachments), ...documents].join("\n\n");
}

const actionOutcomes: Record<AgentAction["state"], string> = {
  pending: "awaiting the user's confirmation",
  applied: "confirmed by the user and applied",
  dismissed: "dismissed by the user",
  failed: "failed",
};

function historyAnswer(turn: {
  answer: string;
  question: CloudChatTurn["question"];
  actions: AgentAction[];
}): string {
  return [
    turn.answer,
    turn.question
      ? `${turn.question.text}\nOptions: ${turn.question.options.join(" | ")}`
      : "",
    turn.actions.length
      ? `Proposal outcomes:\n${turn.actions
          .map(
            (action) =>
              `- ${action.title}: ${actionOutcomes[action.state]}${action.error ? ` (${action.error})` : ""}`,
          )
          .join("\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

async function reserveMessage(
  sql: CloudSql,
  actor: CloudActor,
  chatId: string,
  input: {
    providerId: string;
    model: string;
    prompt: string;
    context: ChatContextReference[];
    attachmentIds: string[];
  },
  files: CloudAttachments,
  retry?: CloudChatTurn,
): Promise<ChatSubmission> {
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
      id: string;
      prompt: string;
      answer: string;
      state: string;
      sequence: number;
      question: CloudChatTurn["question"];
      actions: AgentAction[];
    }>(
      "SELECT id,prompt,answer,state,sequence,question,actions FROM cloud_chat_turns WHERE organization_id=$1 AND chat_id=$2 AND ($3::uuid IS NULL OR id<>$3) ORDER BY sequence LIMIT 201",
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
  const sequence = retry?.sequence ?? (previous.at(-1)?.sequence ?? 0) + 1;
  if (input.context.length)
    await addChatContext(sql, actor, chatId, sequence, input.context);
  const chatFiles = await files.forChat(sql, actor.organizationId, chatId);
  const attachments = retry
    ? chatFiles.filter((attachment) => attachment.turnId === retry.id)
    : await files.pending(sql, actor, input.attachmentIds);
  const history = previous.flatMap((turn) => {
    const answer = historyAnswer(turn);
    return [
      {
        role: "user",
        content:
          turn.prompt +
          attachmentNote(
            chatFiles.filter((attachment) => attachment.turnId === turn.id),
          ),
      },
      ...(turn.state === "complete" && answer
        ? [{ role: "assistant", content: answer }]
        : []),
    ];
  });
  const userPrompt = JSON.stringify([
    ...history,
    {
      role: "user",
      content: await messageContent(
        sql,
        actor.organizationId,
        input.prompt,
        attachments,
        files,
      ),
    },
  ]);
  const chat = await readChat(sql, actor, chatId);
  const systemPrompt = `${agentSystemPrompt}\n\n${await agentContext(sql, actor, chat.context)}`;
  const inputBytes = Buffer.byteLength(userPrompt + systemPrompt, "utf8");
  if (inputBytes > maximumChatInputBytes)
    throw new CloudError(
      422,
      "conversation_limit",
      "This conversation exceeds the input limit. Start a new conversation or shorten your message.",
    );
  const images = [...chatFiles, ...attachments].filter(
    (attachment) => attachment.kind === "image",
  ).length;
  const reservation =
    2 * (inputBytes + agentToolBytes) +
    2 * provider.maxOutputTokens +
    Math.min(images, maximumModelImages) * imageReservationTokens +
    4096;
  const budget = await readProviderBudget(sql, actor.organizationId, provider);
  requireInferenceCapacity(budget, reservation);
  const requestId = randomUUID();
  const turnId = retry?.id ?? randomUUID();
  if (retry)
    await sql.query(
      `UPDATE cloud_chat_turns SET state='queued',answer='',error_code=NULL,request_id=$3,provider_id=$4,model=$5,
      steps='[]'::jsonb,actions='[]'::jsonb,question=NULL,started_at=NULL,finished_at=NULL,revision=revision+1 WHERE organization_id=$1 AND id=$2`,
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
        sequence,
        input.prompt,
        requestId,
      ],
    );
  if (!retry)
    await files.attachToTurn(
      sql,
      actor,
      attachments.map((attachment) => attachment.id),
      chatId,
      turnId,
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
  constructor(
    private readonly database: CloudDatabase,
    private readonly files: CloudAttachments,
  ) {}

  submit(
    actor: CloudActor,
    key: string,
    input: ChatMessage,
  ): Promise<ChatSubmission> {
    return this.database.transaction(async (sql) => {
      await lockInference(sql, actor.organizationId);
      await requireMembership(sql, actor, "ai.chat");
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
            return reserveMessage(sql, actor, chat.id, input, this.files);
          }
          const id = randomUUID();
          await sql.query(
            "INSERT INTO cloud_chats (organization_id,id,user_id,title) VALUES ($1,$2,$3,$4)",
            [
              actor.organizationId,
              id,
              actor.userId,
              input.prompt.split("\n", 1)[0]!.slice(0, 120),
            ],
          );
          return reserveMessage(sql, actor, id, input, this.files);
        },
      );
    });
  }

  startHiddenChat(
    actor: CloudActor,
    key: string,
    input: {
      owner:
        | { automationId: string }
        | { releaseId: string }
        | { pulseJobId: string };
      providerId: string;
      model: string;
      prompt: string;
      context: ChatContextReference[];
    },
  ): Promise<ChatSubmission> {
    return this.database.transaction(async (sql) => {
      await lockInference(sql, actor.organizationId);
      await requireMembership(sql, actor, "ai.chat");
      return command(
        sql,
        actor,
        key,
        { kind: "chat.hidden", input },
        async () => {
          await reapInference(sql, actor.organizationId);
          const id = randomUUID();
          await sql.query(
            "INSERT INTO cloud_chats (organization_id,id,user_id,title,automation_id,release_id,pulse_job_id) VALUES ($1,$2,$3,$4,$5,$6,$7)",
            [
              actor.organizationId,
              id,
              actor.userId,
              input.prompt.split("\n", 1)[0]!.slice(0, 120),
              "automationId" in input.owner ? input.owner.automationId : null,
              "releaseId" in input.owner ? input.owner.releaseId : null,
              "pulseJobId" in input.owner ? input.owner.pulseJobId : null,
            ],
          );
          return reserveMessage(
            sql,
            actor,
            id,
            { ...input, attachmentIds: [] },
            this.files,
          );
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
            turn.chatId,
            {
              providerId: input.providerId,
              model: input.model,
              prompt: turn.prompt,
              context: [],
              attachmentIds: [],
            },
            this.files,
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
            "UPDATE cloud_chat_turns SET state=$3,finished_at=CASE WHEN $3='canceled' THEN clock_timestamp() ELSE finished_at END,revision=revision+1 WHERE organization_id=$1 AND id=$2",
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
          `SELECT ${chatColumns} FROM cloud_chats ch
        WHERE ch.organization_id=$1 AND ch.user_id=$2 AND ch.archived_at IS NULL AND ch.automation_id IS NULL AND ch.release_id IS NULL AND ch.pulse_job_id IS NULL AND ($3::uuid IS NULL OR (ch.updated_at,ch.id)<(SELECT updated_at,id FROM cloud_chats WHERE organization_id=$1 AND user_id=$2 AND id=$3))
        ORDER BY ch.updated_at DESC,ch.id DESC LIMIT 50`,
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

  update(
    actor: CloudActor,
    key: string,
    id: string,
    input: ChatUpdate,
  ): Promise<{ id: string; revision: number }> {
    return this.database.transaction(async (sql) => {
      const chat = await readChat(sql, actor, id, true);
      return command(
        sql,
        actor,
        key,
        { kind: "chat.update", id, input },
        async () => {
          checkRevision(chat.revision, input.revision);
          await sql.query(
            "UPDATE cloud_chats SET title=COALESCE($3,title),archived_at=CASE WHEN $4 THEN clock_timestamp() ELSE archived_at END,revision=revision+1 WHERE organization_id=$1 AND id=$2",
            [
              actor.organizationId,
              id,
              input.title ?? null,
              input.archived ?? false,
            ],
          );
          await recordEvent(sql, actor, "chat.updated", id, chat.revision + 1, {
            archived: input.archived ?? false,
          });
          return { id, revision: chat.revision + 1 };
        },
      );
    });
  }

  readAction(
    actor: CloudActor,
    turnId: string,
    actionId: string,
  ): Promise<AgentAction> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor, "ai.chat");
      const turn = await readTurn(sql, actor, turnId);
      const action = turn.actions.find((entry) => entry.id === actionId);
      if (!action)
        throw new CloudError(404, "not_found", "This proposal is unavailable.");
      return action;
    });
  }

  settleAction(
    actor: CloudActor,
    turnId: string,
    actionId: string,
    change: Pick<AgentAction, "state" | "error" | "result">,
  ): Promise<AgentAction> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor, "ai.chat");
      const turn = await readTurn(sql, actor, turnId, true);
      const action = turn.actions.find((entry) => entry.id === actionId);
      if (!action)
        throw new CloudError(404, "not_found", "This proposal is unavailable.");
      if (action.state === "applied" || action.state === "dismissed")
        return action;
      const settled = { ...action, ...change } as AgentAction;
      await sql.query(
        "UPDATE cloud_chat_turns SET actions=$3,revision=revision+1 WHERE organization_id=$1 AND id=$2",
        [
          actor.organizationId,
          turnId,
          JSON.stringify(
            turn.actions.map((entry) =>
              entry.id === actionId ? settled : entry,
            ),
          ),
        ],
      );
      await recordEvent(
        sql,
        actor,
        `chat.action.${change.state}`,
        turnId,
        turn.revision + 1,
        { actionId },
      );
      if (change.state !== "pending")
        await recordAiActivity(sql, {
          organizationId: actor.organizationId,
          ...actionActivity(settled, change.state),
          actorId: actor.userId,
          chatId: turn.chatId,
        });
      return settled;
    });
  }

  budget(actor: CloudActor, providerId: string): Promise<ProviderBudget> {
    return this.database.transaction(async (sql) => {
      await lockInference(sql, actor.organizationId);
      await requireMembership(sql, actor, "ai.manage");
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
