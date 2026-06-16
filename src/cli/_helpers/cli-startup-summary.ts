import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  ModelProvider,
  ProviderAvailability,
  RuntimeConfig,
  RunMode,
  WebSearchProvider,
  WebSearchProviderAvailability,
} from "../../core/runtime-contract.generated.js";

const DESKTOP_APP_IDENTIFIER = "com.machdoch.desktop";
const DESKTOP_STORE_FILE_NAME = "machdoch-shell-state.json";
const SHELL_STATE_STORAGE_KEY = "machdoch.desktop.shell-state";
const MAX_ACTIVE_SESSION_LINES = 8;
const SESSION_TITLE_LIMIT = 48;

type RuntimeProvider = Exclude<ModelProvider, "unconfigured">;

type DesktopSessionStatus =
  | "empty"
  | "running"
  | "done"
  | "failed"
  | "crashed";

interface RawDesktopSessionMessage {
  id?: string;
  taskId?: string;
  role?: string;
  content?: string;
  createdAt?: number;
  source?: Record<string, unknown>;
}

interface RawDesktopSession {
  id?: string;
  createdAt?: number;
  updatedAt?: number;
  archivedAt?: number;
  pinnedAt?: number;
  specialSession?: string;
  workspace?: string | null;
  profile?: string;
  provider?: string;
  model?: string;
  mode?: string;
  manualTitle?: string;
  messages?: RawDesktopSessionMessage[];
}

interface RawDesktopShellState {
  activeSessionId?: string;
  sessions?: RawDesktopSession[];
}

export interface CliDesktopSessionSummary {
  id: string;
  title: string;
  active: boolean;
  archived: boolean;
  status: DesktopSessionStatus;
  workspace: string | null;
  provider: string;
  model: string;
  mode?: RunMode;
  updatedAt: number;
  pinnedAt?: number;
  specialSession?: string;
}

export type CliDesktopShellSummary =
  | {
      status: "loaded";
      activeSessionId?: string;
      activeSessions: CliDesktopSessionSummary[];
      archivedSessionCount: number;
      totalSessionCount: number;
    }
  | {
      status: "missing";
      storePath: string;
    }
  | {
      status: "unreadable";
      storePath: string;
      reason: string;
    };

const PROVIDER_LABELS: Record<RuntimeProvider, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
  "codex-cli": "Codex CLI",
  "claude-cli": "Claude CLI",
  "copilot-cli": "Copilot CLI",
};

const WEB_SEARCH_PROVIDER_LABELS: Record<WebSearchProvider, string> = {
  none: "None",
  perplexity: "Perplexity",
  tavily: "Tavily",
  serper: "Serper",
};

const STATUS_LABELS: Record<DesktopSessionStatus, string> = {
  empty: "empty",
  running: "running",
  done: "done",
  failed: "failed",
  crashed: "crashed",
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

const isRunMode = (value: string | undefined): value is RunMode => {
  return value === "ask" || value === "machdoch";
};

const normalizeString = (value: unknown): string | undefined => {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
};

const normalizeNumber = (value: unknown): number | undefined => {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
};

const toRawDesktopSessionMessage = (
  value: unknown,
): RawDesktopSessionMessage | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  const source = isRecord(value.source) ? value.source : undefined;
  const id = normalizeString(value.id);
  const taskId = normalizeString(value.taskId);
  const role = normalizeString(value.role);
  const createdAt = normalizeNumber(value.createdAt);

  return {
    ...(id ? { id } : {}),
    ...(taskId ? { taskId } : {}),
    ...(role ? { role } : {}),
    ...(typeof value.content === "string" ? { content: value.content } : {}),
    ...(createdAt !== undefined ? { createdAt } : {}),
    ...(source ? { source } : {}),
  };
};

const toRawDesktopSession = (value: unknown): RawDesktopSession | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  const id = normalizeString(value.id);

  if (!id) {
    return undefined;
  }

  const createdAt = normalizeNumber(value.createdAt);
  const updatedAt = normalizeNumber(value.updatedAt);
  const archivedAt = normalizeNumber(value.archivedAt);
  const pinnedAt = normalizeNumber(value.pinnedAt);
  const specialSession = normalizeString(value.specialSession);
  const workspace =
    value.workspace === null ? null : normalizeString(value.workspace);
  const profile = normalizeString(value.profile);
  const provider = normalizeString(value.provider);
  const model = normalizeString(value.model);
  const mode = normalizeString(value.mode);
  const manualTitle = normalizeString(value.manualTitle);
  const messages = Array.isArray(value.messages)
    ? value.messages.flatMap((message) => {
        const normalized = toRawDesktopSessionMessage(message);
        return normalized ? [normalized] : [];
      })
    : [];

  return {
    id,
    ...(createdAt !== undefined ? { createdAt } : {}),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
    ...(archivedAt !== undefined ? { archivedAt } : {}),
    ...(pinnedAt !== undefined ? { pinnedAt } : {}),
    ...(specialSession ? { specialSession } : {}),
    ...(workspace !== undefined ? { workspace } : {}),
    ...(profile ? { profile } : {}),
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(mode ? { mode } : {}),
    ...(manualTitle ? { manualTitle } : {}),
    messages,
  };
};

const normalizeRawShellState = (
  value: unknown,
): RawDesktopShellState | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  const shellStateValue = value[SHELL_STATE_STORAGE_KEY];

  if (!isRecord(shellStateValue)) {
    return undefined;
  }

  const activeSessionId = normalizeString(shellStateValue.activeSessionId);
  const sessions = Array.isArray(shellStateValue.sessions)
    ? shellStateValue.sessions.flatMap((session) => {
        const normalized = toRawDesktopSession(session);
        return normalized ? [normalized] : [];
      })
    : [];

  return {
    ...(activeSessionId ? { activeSessionId } : {}),
    sessions,
  };
};

const getMessageTaskId = (message: RawDesktopSessionMessage): string => {
  return message.taskId ?? message.id ?? "";
};

const getMessageTimestamp = (
  message: RawDesktopSessionMessage,
  fallback: number,
): number => {
  return typeof message.createdAt === "number" ? message.createdAt : fallback;
};

const getLatestUserTaskId = (
  messages: RawDesktopSessionMessage[],
): string | null => {
  let latestTask: { taskId: string; timestamp: number } | null = null;

  for (const [index, message] of messages.entries()) {
    if (message.role !== "user") {
      continue;
    }

    const taskId = getMessageTaskId(message);

    if (!taskId) {
      continue;
    }

    const timestamp = getMessageTimestamp(message, index);

    if (!latestTask || timestamp >= latestTask.timestamp) {
      latestTask = { taskId, timestamp };
    }
  }

  return latestTask?.taskId ?? null;
};

const getLatestTerminalAgentMessageForTask = (
  messages: RawDesktopSessionMessage[],
  taskId: string,
): RawDesktopSessionMessage | null => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];

    if (!message || getMessageTaskId(message) !== taskId) {
      continue;
    }

    if (message.role !== "agent" || message.source?.kind === "preview") {
      continue;
    }

    return message;
  }

  return null;
};

const getNestedStatus = (
  source: Record<string, unknown>,
  key: string,
): string | undefined => {
  const nested = source[key];

  if (!isRecord(nested)) {
    return undefined;
  }

  return normalizeString(nested.status);
};

const getSessionStatus = (
  session: RawDesktopSession,
): DesktopSessionStatus => {
  const messages = session.messages ?? [];

  if (messages.length === 0) {
    return "empty";
  }

  const latestUserTaskId = getLatestUserTaskId(messages);

  if (!latestUserTaskId) {
    return "empty";
  }

  const latestTerminalAgentMessage = getLatestTerminalAgentMessageForTask(
    messages,
    latestUserTaskId,
  );

  if (!latestTerminalAgentMessage) {
    return "running";
  }

  const source = latestTerminalAgentMessage.source;

  if (!source) {
    return "crashed";
  }

  if (source.kind === "thinking") {
    return getNestedStatus(source, "thinking") === "running"
      ? "running"
      : "done";
  }

  if (source.kind === "execution") {
    const executionStatus = getNestedStatus(source, "execution");

    if (executionStatus === "blocked" || executionStatus === "cancelled") {
      return "failed";
    }

    if (executionStatus && executionStatus !== "executed") {
      return "failed";
    }
  }

  return "done";
};

const createSessionTitle = (session: RawDesktopSession): string => {
  if (session.specialSession === "quick-voice") {
    return "Quick Chat";
  }

  const manualTitle = normalizeString(session.manualTitle);

  if (manualTitle) {
    return manualTitle;
  }

  const firstUserMessage = session.messages?.find(
    (message) => message.role === "user" && normalizeString(message.content),
  );
  const content = normalizeString(firstUserMessage?.content);

  if (!content) {
    return "New session";
  }

  return content.length <= SESSION_TITLE_LIMIT
    ? content
    : `${content.slice(0, SESSION_TITLE_LIMIT - 3)}...`;
};

const compareSessions = (
  left: CliDesktopSessionSummary,
  right: CliDesktopSessionSummary,
): number => {
  const leftIsQuickSession = left.specialSession === "quick-voice";
  const rightIsQuickSession = right.specialSession === "quick-voice";

  if (leftIsQuickSession !== rightIsQuickSession) {
    return leftIsQuickSession ? -1 : 1;
  }

  const leftPinnedAt = left.pinnedAt ?? 0;
  const rightPinnedAt = right.pinnedAt ?? 0;

  if (leftPinnedAt !== rightPinnedAt) {
    return rightPinnedAt - leftPinnedAt;
  }

  return right.updatedAt - left.updatedAt;
};

const normalizeSessionSummary = (
  session: RawDesktopSession,
  activeSessionId: string | undefined,
): CliDesktopSessionSummary => {
  const updatedAt = session.updatedAt ?? session.createdAt ?? 0;
  const mode = isRunMode(session.mode) ? session.mode : undefined;

  return {
    id: session.id ?? "unknown",
    title: createSessionTitle(session),
    active: Boolean(activeSessionId && session.id === activeSessionId),
    archived: typeof session.archivedAt === "number",
    status: getSessionStatus(session),
    workspace: session.workspace ?? null,
    provider: session.provider ?? "unknown",
    model: session.model ?? "unknown",
    ...(mode ? { mode } : {}),
    updatedAt,
    ...(session.pinnedAt !== undefined ? { pinnedAt: session.pinnedAt } : {}),
    ...(session.specialSession ? { specialSession: session.specialSession } : {}),
  };
};

const createDesktopShellSummary = (
  rawState: RawDesktopShellState,
): CliDesktopShellSummary => {
  const sessions = (rawState.sessions ?? []).map((session) =>
    normalizeSessionSummary(session, rawState.activeSessionId),
  );
  const activeSessions = sessions
    .filter((session) => !session.archived)
    .sort(compareSessions);

  return {
    status: "loaded",
    ...(rawState.activeSessionId ? { activeSessionId: rawState.activeSessionId } : {}),
    activeSessions,
    archivedSessionCount: sessions.length - activeSessions.length,
    totalSessionCount: sessions.length,
  };
};

export const resolveDesktopShellStatePath = (
  options: {
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    homeDirectory?: string;
  } = {},
): string => {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const homeDirectory = options.homeDirectory ?? homedir();
  let appDataRoot: string;

  if (platform === "win32") {
    appDataRoot = env.APPDATA?.trim() || join(homeDirectory, "AppData", "Roaming");
  } else if (platform === "darwin") {
    appDataRoot = join(homeDirectory, "Library", "Application Support");
  } else {
    appDataRoot = env.XDG_DATA_HOME?.trim() || join(homeDirectory, ".local", "share");
  }

  return join(appDataRoot, DESKTOP_APP_IDENTIFIER, DESKTOP_STORE_FILE_NAME);
};

export const loadDesktopShellSummary = async (
  options: {
    storePath?: string;
  } = {},
): Promise<CliDesktopShellSummary> => {
  const storePath = options.storePath ?? resolveDesktopShellStatePath();

  try {
    const raw = await readFile(storePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    const rawShellState = normalizeRawShellState(parsed);

    if (!rawShellState) {
      return {
        status: "unreadable",
        storePath,
        reason: "desktop shell state was not found in the store",
      };
    }

    return createDesktopShellSummary(rawShellState);
  } catch (error: unknown) {
    if (
      isRecord(error) &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT"
    ) {
      return {
        status: "missing",
        storePath,
      };
    }

    const reason = error instanceof Error ? error.message : String(error);

    return {
      status: "unreadable",
      storePath,
      reason,
    };
  }
};

const getWorkspaceLabel = (workspace: string | null): string => {
  if (!workspace) {
    return "No workspace";
  }

  const parts = workspace.replace(/\\/gu, "/").split("/").filter(Boolean);

  return parts.at(-1) ?? workspace;
};

const getRuntimeProviderLabel = (provider: string): string => {
  return PROVIDER_LABELS[provider as RuntimeProvider] ?? provider;
};

const createActiveSessionCountLine = (
  summary: CliDesktopShellSummary,
): string => {
  if (summary.status === "missing") {
    return "active sessions: no desktop state found";
  }

  if (summary.status === "unreadable") {
    return `active sessions: unavailable (${summary.reason})`;
  }

  const activeCount = summary.activeSessions.length;
  const archivedSuffix =
    summary.archivedSessionCount > 0
      ? `, ${summary.archivedSessionCount} archived`
      : "";

  return `active sessions: ${activeCount} open (${summary.totalSessionCount} total${archivedSuffix})`;
};

const createActiveSessionLine = (
  session: CliDesktopSessionSummary,
  fallbackMode: RunMode,
): string => {
  const markers = [
    session.active ? "current" : null,
    STATUS_LABELS[session.status],
  ].flatMap((marker) => (marker ? [marker] : []));
  const runtimeParts = [
    getRuntimeProviderLabel(session.provider),
    session.model,
    session.mode ?? fallbackMode,
    getWorkspaceLabel(session.workspace),
  ];

  return `  - ${session.title} [${markers.join(", ")}] ${runtimeParts.join(" / ")}`;
};

const createActiveSessionLines = (
  summary: CliDesktopShellSummary,
  fallbackMode: RunMode,
): string[] => {
  const lines = [createActiveSessionCountLine(summary)];

  if (summary.status !== "loaded") {
    return lines;
  }

  if (summary.activeSessions.length === 0) {
    lines.push("  - none");
    return lines;
  }

  for (const session of summary.activeSessions.slice(0, MAX_ACTIVE_SESSION_LINES)) {
    lines.push(createActiveSessionLine(session, fallbackMode));
  }

  const remainingCount = summary.activeSessions.length - MAX_ACTIVE_SESSION_LINES;

  if (remainingCount > 0) {
    lines.push(`  - ... ${remainingCount} more active session${remainingCount === 1 ? "" : "s"}`);
  }

  return lines;
};

const formatModelProviderAvailability = (
  availability: ProviderAvailability[],
  activeProvider: ModelProvider,
): string => {
  const parts = availability.map((entry) => {
    const label = PROVIDER_LABELS[entry.provider];
    const status = entry.configured ? "available" : "not configured";
    const active = entry.provider === activeProvider ? " (active)" : "";

    return `${label} ${status}${active}`;
  });

  if (activeProvider === "unconfigured") {
    parts.push("active provider unconfigured");
  }

  return `model providers: ${parts.join(", ")}`;
};

const formatWebSearchProviderAvailability = (
  availability: WebSearchProviderAvailability[],
  activeProvider: WebSearchProvider,
): string => {
  if (activeProvider === "none") {
    return `web search providers: ${WEB_SEARCH_PROVIDER_LABELS.none} active; ${availability
      .map((entry) => {
        const label = WEB_SEARCH_PROVIDER_LABELS[entry.provider];
        const status = entry.configured ? "available" : "not configured";

        return `${label} ${status}`;
      })
      .join(", ")}`;
  }

  return `web search providers: ${availability
    .map((entry) => {
      const label = WEB_SEARCH_PROVIDER_LABELS[entry.provider];
      const status = entry.configured ? "available" : "not configured";
      const active = entry.provider === activeProvider ? " (active)" : "";

      return `${label} ${status}${active}`;
    })
    .join(", ")}`;
};

export const createCliStartupSummaryLines = (
  config: Pick<
    RuntimeConfig,
    "mode" | "provider" | "providerAvailability" | "webSearch"
  >,
  shellSummary: CliDesktopShellSummary,
): string[] => {
  return [
    ...createActiveSessionLines(shellSummary, config.mode),
    "providers:",
    `  ${formatModelProviderAvailability(
      config.providerAvailability,
      config.provider,
    )}`,
    `  ${formatWebSearchProviderAvailability(
      config.webSearch.providerAvailability,
      config.webSearch.activeProvider,
    )}`,
  ];
};
