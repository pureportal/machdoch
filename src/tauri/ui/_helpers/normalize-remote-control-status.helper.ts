const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null;
};

export interface NormalizedRemoteControlLogEntry {
  createdAt: number;
  stream: string;
  toolName?: string;
  chunk: string;
}

export interface NormalizedRemoteControlTimelineEntry {
  createdAt: number;
  kind: string;
  phase: string;
  label: string;
  detail?: string;
  tone?: string;
  toolName?: string;
}

export interface NormalizedRemoteControlTaskSession {
  taskId: string;
  task: string;
  mode: string;
  state: string;
  message: string;
  cancellable: boolean;
  startedAt: number;
  updatedAt: number;
  progressCount: number;
  logs: NormalizedRemoteControlLogEntry[];
  timeline: NormalizedRemoteControlTimelineEntry[];
}

export interface NormalizedRemoteControlStatus {
  enabled: boolean;
  localUrl?: string;
  lanUrl?: string;
  displayUrl?: string;
  qrSvg?: string;
  tokenHint?: string;
  startedAt?: number;
  bindAddress?: string;
  port?: number;
  pairedDeviceCount?: number;
  eventId: number;
  sessions: NormalizedRemoteControlTaskSession[];
}

const isRemoteControlLogEntry = (
  value: unknown,
): value is NormalizedRemoteControlLogEntry => {
  return (
    isRecord(value) &&
    typeof value.createdAt === "number" &&
    Number.isFinite(value.createdAt) &&
    typeof value.stream === "string" &&
    (value.toolName === undefined || typeof value.toolName === "string") &&
    typeof value.chunk === "string"
  );
};

const isRemoteControlTimelineEntry = (
  value: unknown,
): value is NormalizedRemoteControlTimelineEntry => {
  return (
    isRecord(value) &&
    typeof value.createdAt === "number" &&
    Number.isFinite(value.createdAt) &&
    typeof value.kind === "string" &&
    typeof value.phase === "string" &&
    typeof value.label === "string" &&
    (value.detail === undefined || typeof value.detail === "string") &&
    (value.tone === undefined || typeof value.tone === "string") &&
    (value.toolName === undefined || typeof value.toolName === "string")
  );
};

const isRemoteControlTaskSession = (
  value: unknown,
): value is NormalizedRemoteControlTaskSession => {
  return (
    isRecord(value) &&
    typeof value.taskId === "string" &&
    typeof value.task === "string" &&
    typeof value.mode === "string" &&
    typeof value.state === "string" &&
    typeof value.message === "string" &&
    typeof value.cancellable === "boolean" &&
    typeof value.startedAt === "number" &&
    Number.isFinite(value.startedAt) &&
    typeof value.updatedAt === "number" &&
    Number.isFinite(value.updatedAt) &&
    typeof value.progressCount === "number" &&
    Number.isFinite(value.progressCount) &&
    Array.isArray(value.logs) &&
    value.logs.every(isRemoteControlLogEntry) &&
    Array.isArray(value.timeline) &&
    value.timeline.every(isRemoteControlTimelineEntry)
  );
};

const normalizeOptionalStringField = (
  value: unknown,
): string | undefined | null => {
  if (value === undefined || value === null) {
    return undefined;
  }

  return typeof value === "string" ? value : null;
};

const normalizeOptionalNumberField = (
  value: unknown,
): number | undefined | null => {
  if (value === undefined || value === null) {
    return undefined;
  }

  return typeof value === "number" && Number.isFinite(value) ? value : null;
};

const assignOptionalStringField = <Key extends keyof NormalizedRemoteControlStatus>(
  status: NormalizedRemoteControlStatus,
  key: Key,
  value: string | undefined,
): void => {
  if (value !== undefined) {
    Object.assign(status, { [key]: value });
  }
};

const assignOptionalNumberField = <Key extends keyof NormalizedRemoteControlStatus>(
  status: NormalizedRemoteControlStatus,
  key: Key,
  value: number | undefined,
): void => {
  if (value !== undefined) {
    Object.assign(status, { [key]: value });
  }
};

export const normalizeRemoteControlStatus = (
  value: unknown,
): NormalizedRemoteControlStatus | null => {
  if (
    !isRecord(value) ||
    typeof value.enabled !== "boolean" ||
    typeof value.eventId !== "number" ||
    !Number.isFinite(value.eventId) ||
    !Array.isArray(value.sessions) ||
    !value.sessions.every(isRemoteControlTaskSession)
  ) {
    return null;
  }

  const localUrl = normalizeOptionalStringField(value.localUrl);
  const lanUrl = normalizeOptionalStringField(value.lanUrl);
  const displayUrl = normalizeOptionalStringField(value.displayUrl);
  const qrSvg = normalizeOptionalStringField(value.qrSvg);
  const tokenHint = normalizeOptionalStringField(value.tokenHint);
  const startedAt = normalizeOptionalNumberField(value.startedAt);
  const bindAddress = normalizeOptionalStringField(value.bindAddress);
  const port = normalizeOptionalNumberField(value.port);
  const pairedDeviceCount = normalizeOptionalNumberField(value.pairedDeviceCount);

  if (
    localUrl === null ||
    lanUrl === null ||
    displayUrl === null ||
    qrSvg === null ||
    tokenHint === null ||
    startedAt === null ||
    bindAddress === null ||
    port === null ||
    pairedDeviceCount === null
  ) {
    return null;
  }

  const status: NormalizedRemoteControlStatus = {
    enabled: value.enabled,
    eventId: value.eventId,
    sessions: value.sessions,
  };

  assignOptionalStringField(status, "localUrl", localUrl);
  assignOptionalStringField(status, "lanUrl", lanUrl);
  assignOptionalStringField(status, "displayUrl", displayUrl);
  assignOptionalStringField(status, "qrSvg", qrSvg);
  assignOptionalStringField(status, "tokenHint", tokenHint);
  assignOptionalNumberField(status, "startedAt", startedAt);
  assignOptionalStringField(status, "bindAddress", bindAddress);
  assignOptionalNumberField(status, "port", port);
  assignOptionalNumberField(status, "pairedDeviceCount", pairedDeviceCount);

  return status;
};
