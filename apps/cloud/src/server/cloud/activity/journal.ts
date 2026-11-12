import { randomUUID } from "node:crypto";
import type {
  AiActivityKind,
  AiActivityStatus,
} from "../../../lib/cloud-activity-contract";
import {
  chatErrorMessages,
  type AgentAction,
  type AgentActionState,
  type ChatState,
} from "../../../lib/cloud-chat-contract";
import type { RunState } from "@machdoch/fleet-protocol/cloud-execution";
import type { CloudSql } from "../database";
import type { AgentProgress } from "../ai/agent-loop";

interface AiActivityFields {
  organizationId: string;
  kind: AiActivityKind;
  status: AiActivityStatus;
  title: string;
  detail?: string;
  runId?: string | null;
  chatId?: string | null;
  model?: string | null;
  provider?: string | null;
  tokens?: number | null;
  durationMs?: number | null;
}

export type AiActivityRecord = AiActivityFields &
  (
    | { actorId: string; client?: undefined }
    | { actorId?: undefined; client: { id: string; name: string } }
  );

export interface ActivityText {
  kind: AiActivityKind;
  status: AiActivityStatus;
  title: string;
  detail: string;
}

export async function recordAiActivity(
  sql: CloudSql,
  record: AiActivityRecord,
): Promise<void> {
  await sql.query(
    "INSERT INTO cloud_ai_activity (organization_id,id,kind,status,title,detail,actor_id,run_id,chat_id,model,provider,tokens,duration_ms,instance_id,instance_name) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)",
    [
      record.organizationId,
      randomUUID(),
      record.kind,
      record.status,
      record.title.slice(0, 300),
      (record.detail ?? "").slice(0, 2000),
      record.actorId ?? null,
      record.runId ?? null,
      record.chatId ?? null,
      record.model ?? null,
      record.provider ?? null,
      record.tokens ?? null,
      record.durationMs ?? null,
      record.client?.id ?? null,
      record.client?.name.slice(0, 120) ?? null,
    ],
  );
}

const runStateText: Record<
  RunState,
  { title: string; status: AiActivityStatus }
> = {
  queued: { title: "Task queued", status: "started" },
  preparing: { title: "Preparing the environment", status: "info" },
  running: { title: "Task started", status: "started" },
  waiting: { title: "Waiting for input", status: "info" },
  validating: { title: "Validating changes", status: "info" },
  publishing: { title: "Publishing changes", status: "info" },
  cancel_requested: { title: "Cancellation requested", status: "info" },
  reconciling: { title: "Reconciling external actions", status: "info" },
  succeeded: { title: "Task succeeded", status: "succeeded" },
  failed: { title: "Task failed", status: "failed" },
  canceled: { title: "Task canceled", status: "canceled" },
  timed_out: { title: "Task timed out", status: "failed" },
};

export function runActivity(
  state: RunState,
  previous: RunState | null,
  reason: string,
): ActivityText {
  const text = runStateText[state];
  if (previous === state)
    return { kind: "task", status: "info", title: reason, detail: "" };
  return {
    kind: "task",
    status: text.status,
    title: text.title,
    detail:
      reason.trim().toLowerCase() === text.title.toLowerCase() ? "" : reason,
  };
}

export async function recordRunActivity(
  sql: CloudSql,
  organizationId: string,
  run: { id: string; state: RunState; revision: number; actorId: string },
  reason: string,
): Promise<void> {
  const previous = (
    await sql.query<{ state: RunState }>(
      "SELECT state FROM cloud_run_events WHERE organization_id=$1 AND run_id=$2 AND revision<$3 ORDER BY revision DESC LIMIT 1",
      [organizationId, run.id, run.revision],
    )
  ).rows[0];
  await recordAiActivity(sql, {
    organizationId,
    ...runActivity(run.state, previous?.state ?? null, reason),
    actorId: run.actorId,
    runId: run.id,
  });
}

const stepStatus = {
  info: "info",
  started: "started",
  passed: "succeeded",
  failed: "failed",
} as const satisfies Record<string, AiActivityStatus>;

export function stepActivity(
  status: keyof typeof stepStatus,
  title: string,
  detail: string,
): ActivityText {
  return { kind: "step", status: stepStatus[status], title, detail };
}

function inferenceStatus(state: ChatState): AiActivityStatus {
  if (state === "complete") return "succeeded";
  if (state === "canceled") return "canceled";
  return "failed";
}

function failureText(state: ChatState, errorCode: string | null): string {
  if (state === "canceled") return "";
  return errorCode ? (chatErrorMessages[errorCode] ?? errorCode) : "";
}

function agentSummary(progress: AgentProgress | undefined): string {
  if (!progress) return "";
  const tools = [...new Set(progress.steps.map((step) => step.tool))];
  return [
    progress.actions.map((action) => action.title).join("; "),
    tools.length ? `Used ${tools.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

export function inferenceActivity(
  purpose: "agent" | "task",
  state: ChatState,
  errorCode: string | null,
  progress?: AgentProgress,
): ActivityText {
  const status = inferenceStatus(state);
  if (purpose === "task")
    return {
      kind: "model",
      status,
      title:
        state === "complete"
          ? "Model call completed"
          : state === "canceled"
            ? "Model call canceled"
            : state === "unknown"
              ? "Model call interrupted"
              : "Model call failed",
      detail: failureText(state, errorCode),
    };
  if (state !== "complete")
    return {
      kind: "agent",
      status,
      title:
        state === "canceled"
          ? "Agent request canceled"
          : state === "unknown"
            ? "Agent request interrupted"
            : "Agent request failed",
      detail: failureText(state, errorCode),
    };
  const proposals = progress?.actions.length ?? 0;
  return {
    kind: "agent",
    status,
    title: progress?.question
      ? "Agent asked a question"
      : proposals === 1
        ? "Agent proposed a change"
        : proposals > 1
          ? `Agent proposed ${proposals} changes`
          : "Agent answered",
    detail: agentSummary(progress),
  };
}

export async function recordInferenceActivity(
  sql: CloudSql,
  call: {
    organizationId: string;
    id: string;
    turnId: string | null;
    runId: string | null;
    actorId: string;
    model: string;
  },
  state: ChatState,
  errorCode: string | null,
  progress?: AgentProgress,
): Promise<void> {
  const details = (
    await sql.query<{
      provider: string;
      tokens: number | null;
      durationMs: number | null;
      chatId: string | null;
    }>(
      `SELECT p.provider,c.actual_tokens AS tokens,
      CASE WHEN c.request_started_at IS NULL THEN NULL ELSE floor(extract(epoch FROM clock_timestamp()-c.request_started_at)*1000)::integer END AS "durationMs",
      t.chat_id AS "chatId"
      FROM cloud_inference_calls c JOIN cloud_ai_providers p ON p.organization_id=c.organization_id AND p.id=c.provider_id
      LEFT JOIN cloud_chat_turns t ON t.organization_id=c.organization_id AND t.id=c.turn_id
      WHERE c.organization_id=$1 AND c.id=$2`,
      [call.organizationId, call.id],
    )
  ).rows[0]!;
  await recordAiActivity(sql, {
    organizationId: call.organizationId,
    ...inferenceActivity(
      call.runId ? "task" : "agent",
      state,
      errorCode,
      progress,
    ),
    actorId: call.actorId,
    runId: call.runId,
    chatId: call.runId ? null : details.chatId,
    model: call.model,
    provider: details.provider,
    tokens: details.tokens,
    durationMs: details.durationMs,
  });
}

const actionText: Record<
  Exclude<AgentActionState, "pending">,
  { title: string; status: AiActivityStatus }
> = {
  applied: { title: "Agent proposal applied", status: "succeeded" },
  dismissed: { title: "Agent proposal dismissed", status: "canceled" },
  failed: { title: "Agent proposal failed", status: "failed" },
};

export function actionActivity(
  action: AgentAction,
  state: Exclude<AgentActionState, "pending">,
): ActivityText {
  const text = actionText[state];
  return {
    kind: "agent",
    status: text.status,
    title: text.title,
    detail: [action.title, action.result?.label, action.error]
      .filter(Boolean)
      .join(" · "),
  };
}
