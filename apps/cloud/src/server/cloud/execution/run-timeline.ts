import type {
  RunActivityStatus,
  RunTimelineEntry,
} from "@machdoch/fleet-protocol/cloud-execution";
import type { CloudSql } from "../database";

const timestamp = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;
const entriesPerSource = 200;
const argumentPreviewLength = 160;

const stateTitles: Record<string, string> = {
  queued: "Queued",
  preparing: "Preparing environment",
  running: "Agent running",
  waiting: "Waiting",
  validating: "Validating",
  publishing: "Publishing",
  cancel_requested: "Cancellation requested",
  reconciling: "Reconciling",
  succeeded: "Succeeded",
  failed: "Failed",
  canceled: "Canceled",
  timed_out: "Timed out",
};

interface ModelCall extends Record<string, unknown> {
  id: string;
  at: string;
  state: string;
  tokens: number | null;
  errorCode: string | null;
  response: {
    text?: string;
    toolCalls?: { name: string; arguments?: unknown }[];
  } | null;
}

function argumentPreview(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? {});
  return text.length > argumentPreviewLength
    ? `${text.slice(0, argumentPreviewLength - 1)}…`
    : text;
}

function modelEntry(call: ModelCall): RunTimelineEntry {
  const tools = call.response?.toolCalls ?? [];
  const failed = call.state === "failed" || call.state === "unknown";
  return {
    id: `model-${call.id}`,
    at: call.at,
    kind: "model",
    status: failed ? "failed" : call.state === "complete" ? "passed" : "started",
    title: failed
      ? `Model request failed${call.errorCode ? ` (${call.errorCode})` : ""}`
      : tools.length
        ? tools.map((tool) => tool.name).join(", ")
        : call.state === "complete"
          ? "Model response"
          : "Thinking",
    detail: tools.length
      ? tools
          .map((tool) => `${tool.name} ${argumentPreview(tool.arguments)}`)
          .join("\n")
      : (call.response?.text ?? "").slice(0, 600),
  };
}

export async function readRunTimeline(
  sql: CloudSql,
  organizationId: string,
  runId: string,
): Promise<RunTimelineEntry[]> {
  const parameters = [organizationId, runId, entriesPerSource];
  const [states, activity, calls] = [
    await sql.query<{
      revision: number;
      state: string;
      reason: string | null;
      at: string;
    }>(
      `SELECT revision,state,reason,to_char(occurred_at AT TIME ZONE 'UTC',${timestamp}) AS at FROM cloud_run_events
       WHERE organization_id=$1 AND run_id=$2 ORDER BY occurred_at DESC,revision DESC LIMIT $3`,
      parameters,
    ),
    await sql.query<{
      id: string;
      title: string;
      detail: string;
      status: RunActivityStatus;
      at: string;
    }>(
      `SELECT id,title,detail,status,to_char(created_at AT TIME ZONE 'UTC',${timestamp}) AS at FROM cloud_run_activity
       WHERE organization_id=$1 AND run_id=$2 ORDER BY created_at DESC,id LIMIT $3`,
      parameters,
    ),
    await sql.query<ModelCall>(
      `SELECT id,state,actual_tokens AS tokens,error_code AS "errorCode",response,to_char(created_at AT TIME ZONE 'UTC',${timestamp}) AS at FROM cloud_inference_calls
       WHERE organization_id=$1 AND run_id=$2 ORDER BY created_at DESC,id LIMIT $3`,
      parameters,
    ),
  ];
  return [
    ...states.rows.map(
      (row): RunTimelineEntry => ({
        id: `state-${row.revision}`,
        at: row.at,
        kind: "state",
        status: ["failed", "timed_out"].includes(row.state)
          ? "failed"
          : row.state === "succeeded"
            ? "passed"
            : "info",
        title: stateTitles[row.state] ?? row.state,
        detail: "",
      }),
    ),
    ...activity.rows.map(
      (row): RunTimelineEntry => ({
        id: `activity-${row.id}`,
        at: row.at,
        kind: "activity",
        status: row.status,
        title: row.title,
        detail: row.detail,
      }),
    ),
    ...calls.rows.map(modelEntry),
  ].sort((left, right) => left.at.localeCompare(right.at));
}
