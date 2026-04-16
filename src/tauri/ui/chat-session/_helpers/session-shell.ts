import {
  Archive,
  Check,
  CircleDashed,
  ListFilter,
  LoaderCircle,
  MessageSquare,
  ShieldAlert,
  WandSparkles,
} from "lucide-react";
import type {
  ConversationHistoryEntry,
  RunMode,
  TaskConversationContext,
} from "../../../../core/types.js";
import {
  createVisibleConversationMessages,
  type ChatSessionRecord,
  type SessionOverviewStatus,
} from "../../chat-session.model";
import {
  getProviderLabel,
  type CatalogModelStage,
} from "../../model-catalog";
import {
  USER_WEB_SEARCH_PROVIDER_ORDER,
  type RuntimeSnapshot,
  type UserMemorySettings,
  type UserWebSearchSettings,
  type WebSearchProvider,
} from "../../runtime";
import { getRenderedMessageContent } from "./execution-message.tsx";

export type SettingsSection = "providers" | "web-search" | "memory";
export type SessionScopeFilter = "all" | "open" | "archived";
export type SessionStatusFilter = "any" | SessionOverviewStatus;

export const SETTINGS_SECTIONS: ReadonlyArray<{
  id: SettingsSection;
  label: string;
}> = [
  { id: "providers", label: "Providers" },
  { id: "web-search", label: "Web search" },
  { id: "memory", label: "Memory" },
];

export const MODEL_STAGE_LABELS: Record<CatalogModelStage, string> = {
  stable: "Stable",
  preview: "Preview",
  specialized: "Specialized",
  open: "Open",
};

export const MODEL_STAGE_CLASSES: Record<CatalogModelStage, string> = {
  stable: "border-emerald-500/20 bg-emerald-500/10 text-emerald-200",
  preview: "border-amber-500/20 bg-amber-500/10 text-amber-200",
  specialized: "border-sky-500/20 bg-sky-500/10 text-sky-200",
  open: "border-violet-500/20 bg-violet-500/10 text-violet-200",
};

export const RUN_MODE_ORDER = ["safe", "ask", "auto"] as const satisfies ReadonlyArray<RunMode>;

export const RUN_MODE_META = {
  safe: {
    label: "Safe mode",
    description: "Keep each run read-only or otherwise low-risk.",
    icon: ShieldAlert,
    triggerClassName:
      "border-emerald-500/20 bg-emerald-500/10 text-emerald-100 hover:bg-emerald-500/15 hover:text-white",
    selectedClassName:
      "border-emerald-500/30 bg-emerald-500/10 text-emerald-100",
    iconClassName: "text-emerald-300",
    badgeClassName:
      "border-emerald-500/20 bg-emerald-500/10 text-emerald-200",
  },
  ask: {
    label: "Ask mode",
    description: "Pause for approval before riskier file or shell actions.",
    icon: MessageSquare,
    triggerClassName:
      "border-amber-500/20 bg-amber-500/10 text-amber-100 hover:bg-amber-500/15 hover:text-white",
    selectedClassName:
      "border-amber-500/30 bg-amber-500/10 text-amber-100",
    iconClassName: "text-amber-300",
    badgeClassName:
      "border-amber-500/20 bg-amber-500/10 text-amber-200",
  },
  auto: {
    label: "Autopilot",
    description:
      "Let machdoch continue automatically when it can verify the next step.",
    icon: WandSparkles,
    triggerClassName:
      "border-violet-500/20 bg-violet-500/10 text-violet-100 hover:bg-violet-500/15 hover:text-white",
    selectedClassName:
      "border-violet-500/30 bg-violet-500/10 text-violet-100",
    iconClassName: "text-violet-300",
    badgeClassName:
      "border-violet-500/20 bg-violet-500/10 text-violet-200",
  },
} satisfies Record<
  RunMode,
  {
    label: string;
    description: string;
    icon: typeof ShieldAlert;
    triggerClassName: string;
    selectedClassName: string;
    iconClassName: string;
    badgeClassName: string;
  }
>;

export const SESSION_SCOPE_FILTERS = [
  { id: "all", label: "All", icon: ListFilter },
  { id: "open", label: "Open", icon: MessageSquare },
  { id: "archived", label: "Archived", icon: Archive },
] as const satisfies ReadonlyArray<{
  id: SessionScopeFilter;
  label: string;
  icon: typeof ListFilter;
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
  const providerLabel = getProviderLabel(session.provider);
  const workspaceLabel = getWorkspaceLabel(session.workspace);

  return `${providerLabel} · ${workspaceLabel}`;
};

export const removeSessionArchiveFlag = (
  session: ChatSessionRecord,
): ChatSessionRecord => {
  const sessionWithoutArchive = { ...session };

  delete sessionWithoutArchive.archivedAt;

  return sessionWithoutArchive;
};

export const removeSessionModeOverride = (
  session: ChatSessionRecord,
): ChatSessionRecord => {
  const sessionWithoutMode = { ...session };

  delete sessionWithoutMode.mode;

  return sessionWithoutMode;
};

export const getEffectiveSessionMode = (
  sessionMode: RunMode | undefined,
  runtimeSnapshot: RuntimeSnapshot | null,
): RunMode => {
  return sessionMode ?? runtimeSnapshot?.mode ?? "ask";
};

export const WEB_SEARCH_PROVIDER_LABELS: Record<WebSearchProvider, string> = {
  none: "None",
  perplexity: "Perplexity",
  tavily: "Tavily",
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
): TaskConversationContext => {
  const history: ConversationHistoryEntry[] = createVisibleConversationMessages(
    session.messages,
  )
    .map((message) => {
      const role: ConversationHistoryEntry["role"] =
        message.role === "agent" ? "assistant" : "user";

      return {
        role,
        content: getRenderedMessageContent(message).trim(),
        ...(typeof message.createdAt === "number"
          ? { createdAt: message.createdAt }
          : {}),
      };
    })
    .filter((entry) => entry.content.length > 0)
    .slice(-60);

  return {
    history,
    sessionMemoryEnabled: session.sessionMemoryEnabled,
    sessionMemory: session.sessionMemory,
    globalMemoryEnabled: globalMemoryEnabled ? session.useGlobalMemory : false,
  };
};

export const formatSavedFactCount = (count: number): string => {
  return `${count} saved fact${count === 1 ? "" : "s"}`;
};
