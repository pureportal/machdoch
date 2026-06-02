import {
  Archive,
  Check,
  CircleDashed,
  Inbox,
  ListFilter,
  LoaderCircle,
  MessageSquare,
  ShieldAlert,
  ServerCrash,
  XCircle,
  WandSparkles,
} from "lucide-react";
import type {
  RunMode,
  TaskConversationContext,
  UiControlAvailability,
} from "../../../../core/types.js";
import {
  isQuickVoiceSession,
  type ChatSessionRecord,
  type SessionOverviewStatus,
} from "../../chat-session.model";
import { getProviderLabel, type CatalogModelStage } from "../../model-catalog";
import {
  USER_WEB_SEARCH_PROVIDER_ORDER,
  type RuntimeSnapshot,
  type UserMemorySettings,
  type UserWebSearchSettings,
  type WebSearchProvider,
} from "../../runtime";
import {
  createAiContextHistory,
  DEFAULT_AI_CONTEXT_MESSAGE_LIMIT,
} from "./ai-context-window";

export type SettingsSection =
  | "providers"
  | "web-search"
  | "agent"
  | "appearance"
  | "voice"
  | "memory"
  | "desktop";
export type SessionScopeFilter = "all" | "open" | "archived";
export type SessionStatusFilter = "any" | SessionOverviewStatus;

export const SETTINGS_SECTIONS: ReadonlyArray<{
  id: SettingsSection;
  label: string;
}> = [
  { id: "providers", label: "Providers" },
  { id: "web-search", label: "Web search" },
  { id: "agent", label: "Agent" },
  { id: "appearance", label: "Appearance" },
  { id: "voice", label: "Voice" },
  { id: "memory", label: "Memory" },
  { id: "desktop", label: "Desktop" },
];

export const MODEL_STAGE_LABELS: Record<CatalogModelStage, string> = {
  deprecated: "Deprecated",
  stable: "Stable",
  preview: "Preview",
  open: "Open",
};

export const MODEL_STAGE_CLASSES: Record<CatalogModelStage, string> = {
  deprecated: "border-rose-500/20 bg-rose-500/10 text-rose-200",
  stable: "border-emerald-500/20 bg-emerald-500/10 text-emerald-200",
  preview: "border-amber-500/20 bg-amber-500/10 text-amber-200",
  open: "border-violet-500/20 bg-violet-500/10 text-violet-200",
};

export const RUN_MODE_ORDER = [
  "ask",
  "machdoch",
] as const satisfies ReadonlyArray<RunMode>;

export const RUN_MODE_META = {
  ask: {
    label: "Ask mode",
    description: "Use only read-only function calls.",
    icon: MessageSquare,
    triggerClassName:
      "border-amber-500/20 bg-amber-500/10 text-amber-100 hover:bg-amber-500/15 hover:text-white",
    selectedClassName: "border-amber-500/30 bg-amber-500/10 text-amber-100",
    iconClassName: "text-amber-300",
    badgeClassName: "border-amber-500/20 bg-amber-500/10 text-amber-200",
  },
  machdoch: {
    label: "Machdoch",
    description:
      "Let machdoch use all function calls and verify its work.",
    icon: WandSparkles,
    triggerClassName:
      "border-violet-500/20 bg-violet-500/10 text-violet-100 hover:bg-violet-500/15 hover:text-white",
    selectedClassName: "border-violet-500/30 bg-violet-500/10 text-violet-100",
    iconClassName: "text-violet-300",
    badgeClassName: "border-violet-500/20 bg-violet-500/10 text-violet-200",
  },
} satisfies Record<
  RunMode,
  {
    label: string;
    description: string;
    icon: typeof MessageSquare;
    triggerClassName: string;
    selectedClassName: string;
    iconClassName: string;
    badgeClassName: string;
  }
>;

export const SESSION_SCOPE_FILTERS = [
  { id: "all", label: "All", icon: Inbox },
  { id: "open", label: "Open", icon: MessageSquare },
  { id: "archived", label: "Archived", icon: Archive },
] as const satisfies ReadonlyArray<{
  id: SessionScopeFilter;
  label: string;
  icon: typeof Inbox;
}>;

export const SESSION_STATUS_META = {
  empty: {
    label: "Empty",
    filterLabel: "Empty",
    icon: CircleDashed,
    containerClassName: "border-slate-800 bg-slate-950/80",
    iconClassName: "text-slate-500",
  },
  running: {
    label: "Running",
    filterLabel: "Running",
    icon: LoaderCircle,
    containerClassName:
      "border-sky-500/20 bg-sky-500/10 shadow-[0_0_18px_rgba(14,165,233,0.16)]",
    iconClassName: "animate-spin text-sky-300",
  },
  waiting: {
    label: "Waiting for approval",
    filterLabel: "Waiting",
    icon: ShieldAlert,
    containerClassName:
      "border-amber-500/20 bg-amber-500/10 shadow-[0_0_18px_rgba(245,158,11,0.18)]",
    iconClassName: "animate-pulse text-amber-300",
  },
  done: {
    label: "Done",
    filterLabel: "Done",
    icon: Check,
    containerClassName:
      "border-emerald-500/20 bg-emerald-500/10 shadow-[0_0_18px_rgba(16,185,129,0.18)]",
    iconClassName: "animate-pulse text-emerald-300",
  },
  failed: {
    label: "Failed",
    filterLabel: "Failed",
    icon: XCircle,
    containerClassName:
      "border-rose-500/20 bg-rose-500/10 shadow-[0_0_18px_rgba(244,63,94,0.18)]",
    iconClassName: "text-rose-400",
  },
  crashed: {
    label: "Crashed",
    filterLabel: "Crashed",
    icon: ServerCrash,
    containerClassName:
      "border-rose-700/30 bg-rose-900/40 shadow-[0_0_18px_rgba(225,29,72,0.18)]",
    iconClassName: "text-rose-300",
  },
} satisfies Record<
  SessionOverviewStatus,
  {
    label: string;
    filterLabel: string;
    icon: typeof CircleDashed;
    containerClassName: string;
    iconClassName: string;
  }
>;

export const SESSION_STATUS_FILTERS = [
  { id: "any", label: "Any status", icon: ListFilter },
  {
    id: "empty",
    label: SESSION_STATUS_META.empty.filterLabel,
    icon: SESSION_STATUS_META.empty.icon,
  },
  {
    id: "running",
    label: SESSION_STATUS_META.running.filterLabel,
    icon: SESSION_STATUS_META.running.icon,
  },
  {
    id: "waiting",
    label: SESSION_STATUS_META.waiting.filterLabel,
    icon: SESSION_STATUS_META.waiting.icon,
  },
  {
    id: "done",
    label: SESSION_STATUS_META.done.filterLabel,
    icon: SESSION_STATUS_META.done.icon,
  },
  {
    id: "failed",
    label: SESSION_STATUS_META.failed.filterLabel,
    icon: SESSION_STATUS_META.failed.icon,
  },
  {
    id: "crashed",
    label: SESSION_STATUS_META.crashed.filterLabel,
    icon: SESSION_STATUS_META.crashed.icon,
  },
] as const satisfies ReadonlyArray<{
  id: SessionStatusFilter;
  label: string;
  icon: typeof ListFilter;
}>;

export const formatSessionTimestamp = (timestamp: number): string => {
  return new Intl.DateTimeFormat("en", {
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
    day: "numeric",
  }).format(timestamp);
};

export const getWorkspaceLabel = (workspace: string | null): string => {
  if (!workspace) {
    return "No workspace";
  }

  const parts = workspace.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.at(-1) ?? workspace;
};

export const createSessionSubtitle = (session: ChatSessionRecord): string => {
  if (isQuickVoiceSession(session)) {
    return "Protected utility session";
  }

  const providerLabel = getProviderLabel(session.provider);
  const workspaceLabel = getWorkspaceLabel(session.workspace);

  return `${providerLabel} · ${workspaceLabel}`;
};

type RemovableSessionProperty = "archivedAt" | "mode" | "profile";

const removeSessionProperty = (
  session: ChatSessionRecord,
  property: RemovableSessionProperty,
): ChatSessionRecord => {
  const sessionWithoutProperty = { ...session };

  delete sessionWithoutProperty[property];

  return sessionWithoutProperty;
};

export const removeSessionArchiveFlag = (
  session: ChatSessionRecord,
): ChatSessionRecord => {
  return removeSessionProperty(session, "archivedAt");
};

export const removeSessionModeOverride = (
  session: ChatSessionRecord,
): ChatSessionRecord => {
  return removeSessionProperty(session, "mode");
};

export const removeSessionProfileOverride = (
  session: ChatSessionRecord,
): ChatSessionRecord => {
  return removeSessionProperty(session, "profile");
};

export const getEffectiveSessionMode = (
  sessionMode: RunMode | undefined,
  runtimeSnapshot: RuntimeSnapshot | null,
): RunMode => {
  return sessionMode ?? runtimeSnapshot?.mode ?? "machdoch";
};

export const WEB_SEARCH_PROVIDER_LABELS: Record<WebSearchProvider, string> = {
  none: "None",
  perplexity: "Perplexity",
  tavily: "Tavily",
  serper: "Serper",
};

export const getWebSearchProviderLabel = (
  provider: WebSearchProvider,
): string => {
  return WEB_SEARCH_PROVIDER_LABELS[provider];
};

export const createEmptyWebSearchSettings = (): UserWebSearchSettings => {
  return {
    activeProvider: "none",
    apiKeys: {},
    providerAvailability: USER_WEB_SEARCH_PROVIDER_ORDER.map((provider) => ({
      provider,
      configured: false,
    })),
  };
};

export const createEmptyUserMemorySettings = (): UserMemorySettings => {
  return {
    globalEnabled: false,
    entries: [],
  };
};

export const createConversationContextFromSession = (
  session: ChatSessionRecord,
  globalMemoryEnabled: boolean,
  uiControl?: UiControlAvailability,
  maxHistoryMessages: unknown = DEFAULT_AI_CONTEXT_MESSAGE_LIMIT,
): TaskConversationContext => {
  const history = createAiContextHistory(session.messages, maxHistoryMessages);

  return {
    history,
    sessionMemoryEnabled: session.sessionMemoryEnabled,
    sessionMemory: session.sessionMemory,
    globalMemoryEnabled: globalMemoryEnabled ? session.useGlobalMemory : false,
    uiControlEnabled: session.uiControlEnabled,
    ...(uiControl ? { uiControl } : {}),
  };
};

export const formatSavedFactCount = (count: number): string => {
  return `${count} saved fact${count === 1 ? "" : "s"}`;
};
