import type {
  AiActivityKind,
  AiActivityStatus,
} from "../../../lib/cloud-activity-contract";

export interface ExportedActivity {
  id: string;
  organizationId: string;
  kind: AiActivityKind;
  status: AiActivityStatus;
  title: string;
  detail: string;
  occurredAt: string;
  actorName: string;
  model: string | null;
  provider: string | null;
  tokens: number | null;
  durationMs: number | null;
  runId: string | null;
  runTitle: string | null;
  issueIdentifier: string | null;
  chatId: string | null;
  instanceId: string | null;
  instanceName: string | null;
}

type AttributeValue = string | number;

export interface MimoriiLogBatch {
  labels: Record<string, string>;
  entries: {
    timestamp: string;
    level: "error" | "warn" | "info";
    message: string;
    labels: Record<string, string>;
    attributes: Record<string, AttributeValue>;
  }[];
}

export interface MimoriiDeliveryResult {
  accepted: number;
  duplicates: number;
  rejected: number;
  rejection: string | null;
}

export class MimoriiDeliveryError extends Error {
  constructor(
    message: string,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
  }
}

export const mimoriiBatchSize = 500;
const requestTimeoutMs = 15_000;
const maximumResponseBytes = 64 * 1024;

function activityLevel(status: AiActivityStatus): "error" | "warn" | "info" {
  if (status === "failed") return "error";
  if (status === "canceled" || status === "warning") return "warn";
  return "info";
}

export function activityMessage(activity: ExportedActivity): string {
  const subject = activity.runTitle
    ? [activity.issueIdentifier, activity.runTitle].filter(Boolean).join(" ")
    : activity.instanceName;
  return [activity.title, subject, activity.detail].filter(Boolean).join(" · ");
}

function attributes(
  activity: ExportedActivity,
): Record<string, AttributeValue> {
  const values: Record<string, AttributeValue | null> = {
    activity_id: activity.id,
    organization_id: activity.organizationId,
    status: activity.status,
    actor: activity.actorName,
    model: activity.model,
    provider: activity.provider,
    tokens: activity.tokens,
    duration_ms: activity.durationMs,
    run_id: activity.runId,
    task: activity.runTitle,
    issue: activity.issueIdentifier,
    chat_id: activity.chatId,
    instance_id: activity.instanceId,
  };
  return Object.fromEntries(
    Object.entries(values).flatMap(([name, value]) =>
      value === null
        ? []
        : [[name, typeof value === "string" ? value.slice(0, 4096) : value]],
    ),
  );
}

function entryLabels(activity: ExportedActivity): Record<string, string> {
  const labels: Record<string, string> = { activity: activity.kind };
  if (activity.instanceName) labels.device = activity.instanceName;
  return labels;
}

export function mimoriiLogBatch(
  activities: ExportedActivity[],
): MimoriiLogBatch {
  return {
    labels: { service: "machdoch-cloud" },
    entries: activities.map((activity) => ({
      timestamp: activity.occurredAt,
      level: activityLevel(activity.status),
      message: activityMessage(activity),
      labels: entryLabels(activity),
      attributes: attributes(activity),
    })),
  };
}

export function mimoriiTestBatch(
  actorName: string,
  timestamp: string,
): MimoriiLogBatch {
  return {
    labels: { service: "machdoch-cloud" },
    entries: [
      {
        timestamp,
        level: "info",
        message: "Machdoch cloud connection test",
        labels: { activity: "test" },
        attributes: { actor: actorName.slice(0, 4096) },
      },
    ],
  };
}

function retryAfter(value: string | null): number | null {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : null;
}

function failureMessage(status: number, body: unknown): string {
  if (status === 401 || status === 403)
    return "Mimorii rejected the log source token. Create a new token in Mimorii and update it here.";
  if (status === 404)
    return "Mimorii log ingestion was not found at this address. Check the Mimorii URL.";
  if (status === 429)
    return "Mimorii is limiting log delivery. Delivery resumes automatically.";
  const detail =
    body && typeof body === "object" && "message" in body
      ? String((body as { message: unknown }).message)
      : "";
  return `Mimorii returned HTTP ${status}${detail ? `: ${detail}` : "."}`.slice(
    0,
    500,
  );
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (Buffer.byteLength(text) > maximumResponseBytes) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : 0;
}

export async function sendMimoriiBatch(
  url: string,
  token: string,
  batch: MimoriiLogBatch,
  transport: typeof fetch = fetch,
): Promise<MimoriiDeliveryResult> {
  let response: Response;
  try {
    response = await transport(`${url}/api/logs/push`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(batch),
      redirect: "error",
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
  } catch (error) {
    throw new MimoriiDeliveryError(
      error instanceof Error && error.name === "TimeoutError"
        ? "Mimorii did not respond in time."
        : "Mimorii is unreachable. Check the address and network access.",
    );
  }
  const body = await readJson(response);
  const entryRejection =
    response.status === 400 &&
    body !== null &&
    typeof body === "object" &&
    "rejected" in body;
  if (!response.ok && !entryRejection)
    throw new MimoriiDeliveryError(
      failureMessage(response.status, body),
      response.status === 429
        ? retryAfter(response.headers.get("retry-after"))
        : null,
    );
  const result = (body ?? {}) as Record<string, unknown>;
  const errors = Array.isArray(result.errors) ? result.errors : [];
  const first = errors[0] as { reason?: unknown } | undefined;
  const rejected = count(result.rejected);
  return {
    accepted: count(result.accepted),
    duplicates: count(result.duplicates),
    rejected,
    rejection:
      rejected && typeof first?.reason === "string"
        ? `Mimorii rejected ${rejected} entries: ${first.reason}`.slice(0, 500)
        : null,
  };
}
