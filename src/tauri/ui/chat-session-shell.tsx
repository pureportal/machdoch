import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import {
    AlertCircle,
    Archive,
    Bot,
    Brain,
    BrainCircuit,
    Check,
    CircleDashed,
    Cog,
    FolderOpen,
    ListFilter,
    LoaderCircle,
    MessageSquare,
    PencilLine,
    Plus,
    SendHorizonal,
    ShieldAlert,
    TerminalSquare,
    Trash2,
    User,
    WandSparkles,
} from "lucide-react";
import {
    useEffect,
    useMemo,
    useRef,
    useState,
    type JSX,
    type KeyboardEvent,
    type SetStateAction,
} from "react";
import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Avatar } from "./components/ui/avatar";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from "./components/ui/dialog";
import { Textarea } from "./components/ui/textarea";

import {
    MAX_SESSION_MEMORY_ENTRIES,
    mergeConversationMemoryEntries,
} from "../../core/memory.js";
import type {
    ConversationHistoryEntry,
    TaskConversationContext,
    TaskExecutionResult,
} from "../../core/types.js";
import {
    canArchiveSession,
    type ChatSessionMessage,
    createInitialShellState,
    createSession,
    createVisibleConversationMessages,
    getSessionOverviewStatus,
    getSessionTitle,
    isSessionArchived,
    normalizeShellState,
    sortSessionsByUpdatedAt,
    type ChatSessionRecord,
    type SessionOverviewStatus,
    type ShellPersistedState,
} from "./chat-session.model";
import { Input } from "./components/ui/input";
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from "./components/ui/popover";
import { ScrollArea } from "./components/ui/scroll-area";
import { Separator } from "./components/ui/separator";
import {
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
} from "./components/ui/tooltip";
import { loadShellState, saveShellState } from "./lib/shell-store";
import { cn } from "./lib/utils";
import {
    getCatalogModelsForProvider,
    getDefaultModelForProvider,
    getProviderLabel,
    SUPPORTED_PROVIDER_ORDER,
    type CatalogModelStage,
    type RuntimeProvider,
} from "./model-catalog";
import {
    loadGlobalProviderAvailability,
    loadUserMemorySettings,
    loadUserWebSearchSettings,
    loadWorkspaceRuntimeSnapshot,
    openWorkspacePath,
    runDesktopTask,
    saveUserGlobalMemoryEnabled,
    saveUserProviderApiKey,
    saveUserWebSearchActiveProvider,
    saveUserWebSearchApiKey,
    USER_API_KEY_PROVIDER_ORDER,
    USER_WEB_SEARCH_PROVIDER_ORDER,
    type RuntimeProviderAvailability,
    type RuntimeSnapshot,
    type UserApiKeyProvider,
    type UserMemorySettings,
    type UserProviderApiKeys,
    type UserWebSearchApiKeyProvider,
    type UserWebSearchApiKeys,
    type UserWebSearchSettings,
    type WebSearchProvider,
} from "./runtime";
import { TaskPanel } from "./task-panel";
import { TaskThinkingPanel } from "./task-thinking-panel";
import type { TaskThinkingTrace } from "./task-thinking.model";

type SettingsSection = "providers" | "web-search" | "memory";
type SessionScopeFilter = "all" | "open" | "archived";
type SessionStatusFilter = "any" | SessionOverviewStatus;

const SETTINGS_SECTIONS: ReadonlyArray<{
  id: SettingsSection;
  label: string;
}> = [
  { id: "providers", label: "Providers" },
  { id: "web-search", label: "Web search" },
  { id: "memory", label: "Memory" },
];

const MODEL_STAGE_LABELS: Record<CatalogModelStage, string> = {
  stable: "Stable",
  preview: "Preview",
  specialized: "Specialized",
  open: "Open",
};

const MODEL_STAGE_CLASSES: Record<CatalogModelStage, string> = {
  stable: "border-emerald-500/20 bg-emerald-500/10 text-emerald-200",
  preview: "border-amber-500/20 bg-amber-500/10 text-amber-200",
  specialized: "border-sky-500/20 bg-sky-500/10 text-sky-200",
  open: "border-violet-500/20 bg-violet-500/10 text-violet-200",
};

const SESSION_SCOPE_FILTERS = [
  { id: "all", label: "All", icon: ListFilter },
  { id: "open", label: "Open", icon: MessageSquare },
  { id: "archived", label: "Archived", icon: Archive },
] as const satisfies ReadonlyArray<{
  id: SessionScopeFilter;
  label: string;
  icon: typeof ListFilter;
}>;

const SESSION_STATUS_META = {
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

const SESSION_STATUS_FILTERS = [
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

const formatSessionTimestamp = (timestamp: number): string => {
  return new Intl.DateTimeFormat("en", {
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
    day: "numeric",
  }).format(timestamp);
};

const getWorkspaceLabel = (workspace: string | null): string => {
  if (!workspace) {
    return "No workspace";
  }

  const parts = workspace.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.at(-1) ?? workspace;
};

const createSessionSubtitle = (session: ChatSessionRecord): string => {
  const providerLabel = getProviderLabel(session.provider);
  const workspaceLabel = getWorkspaceLabel(session.workspace);

  return `${providerLabel} · ${workspaceLabel}`;
};

const removeSessionArchiveFlag = (
  session: ChatSessionRecord,
): ChatSessionRecord => {
  const sessionWithoutArchive = { ...session };

  delete sessionWithoutArchive.archivedAt;

  return sessionWithoutArchive;
};

const markdownComponents: Components = {
  p: ({ children }) => <p className="m-0 whitespace-pre-wrap">{children}</p>,
  ul: ({ children }) => (
    <ul className="m-0 list-disc space-y-1 pl-5">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="m-0 list-decimal space-y-1 pl-5">{children}</ol>
  ),
  li: ({ children }) => <li className="leading-6">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="m-0 border-l-2 border-slate-700 pl-4 text-slate-400 italic">
      {children}
    </blockquote>
  ),
  pre: ({ children }) => (
    <pre className="m-0 overflow-x-auto rounded-2xl border border-slate-800 bg-slate-950 px-4 py-3 text-xs leading-6 text-slate-200">
      {children}
    </pre>
  ),
  code: ({ children, className, ...props }) => (
    <code
      {...props}
      className={cn(
        "rounded-md bg-slate-950/90 px-1.5 py-0.5 font-mono text-[0.92em] text-sky-200",
        className,
      )}
    >
      {children}
    </code>
  ),
  a: ({ children, href, ...props }) => (
    <a
      {...props}
      href={href}
      target="_blank"
      rel="noreferrer"
      className="font-medium text-sky-300 underline decoration-sky-500/40 underline-offset-4 transition-colors hover:text-sky-100"
    >
      {children}
    </a>
  ),
};

interface MessageMarkdownProps {
  content: string;
}

const MessageMarkdown = ({ content }: MessageMarkdownProps): JSX.Element => {
  return (
    <div className="grid gap-3">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={markdownComponents}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
};

const createFallbackExecutionMarkdown = (
  execution: TaskExecutionResult,
): string => {
  const summary =
    execution.summary.trim() ||
    "The task completed without a detailed summary.";

  switch (execution.status) {
    case "executed":
      return `**Done.** ${summary}`;
    case "approval-required":
      return `**Approval required.** ${summary}`;
    case "blocked":
      return `**Blocked.** ${summary}`;
    case "cancelled":
      return `**Cancelled.** ${summary}`;
    case "unsupported":
    default:
      return `**Preview only.** ${summary}`;
  }
};

const getExecutionMessageContent = (execution: TaskExecutionResult): string => {
  const structuredMarkdown = execution.response?.markdown?.trim();

  return structuredMarkdown || createFallbackExecutionMarkdown(execution);
};

const getRelatedFileButtonLabel = (path: string): string => {
  return path.length <= 42 ? path : `…${path.slice(path.length - 39)}`;
};

const getRenderedMessageContent = (message: ChatSessionMessage): string => {
  if (message.role === "agent" && message.source?.kind === "execution") {
    return getExecutionMessageContent(message.source.execution);
  }

  return message.content;
};

const createExecutionThinkingTone = (
  status: TaskExecutionResult["status"],
): TaskThinkingTrace["entries"][number]["tone"] => {
  switch (status) {
    case "executed":
      return "success";
    case "approval-required":
      return "warning";
    case "blocked":
      return "danger";
    case "cancelled":
    case "unsupported":
    default:
      return "neutral";
  }
};

const createExecutionThinkingLabel = (
  status: TaskExecutionResult["status"],
): string => {
  switch (status) {
    case "executed":
      return "Completed";
    case "approval-required":
      return "Approval required";
    case "blocked":
      return "Blocked";
    case "cancelled":
      return "Cancelled";
    case "unsupported":
    default:
      return "Preview only";
  }
};

const createExecutionThinkingTrace = (
  execution: TaskExecutionResult,
): TaskThinkingTrace => {
  const summaryTone = createExecutionThinkingTone(execution.status);
  const entries: TaskThinkingTrace["entries"] = [];
  const normalizedSummary = execution.summary.trim();

  if (normalizedSummary.length > 0) {
    entries.push({
      id: `${execution.task}-summary`,
      label: createExecutionThinkingLabel(execution.status),
      detail: normalizedSummary,
      tone: summaryTone,
      timestamp: 0,
    });
  }

  execution.outputSections.forEach((section, sectionIndex) => {
    section.lines.forEach((line, lineIndex) => {
      const normalizedLine = line.trim();

      if (!normalizedLine) {
        return;
      }

      entries.push({
        id: `${execution.task}-${sectionIndex}-${lineIndex}`,
        label: section.title,
        detail: normalizedLine,
        tone: sectionIndex === 0 ? summaryTone : "neutral",
        timestamp: entries.length,
      });
    });
  });

  if (entries.length === 0) {
    entries.push({
      id: `${execution.task}-empty`,
      label: createExecutionThinkingLabel(execution.status),
      detail: "Task finished without additional execution trace details.",
      tone: summaryTone,
      timestamp: 0,
    });
  }

  return {
    status: "complete",
    mode: execution.mode,
    entries,
  };
};

interface ExecutionInsightRowProps {
  execution: TaskExecutionResult;
  onOpenWorkspaceFile: (relativePath: string) => void;
}

const ExecutionInsightRow = ({
  execution,
  onOpenWorkspaceFile,
}: ExecutionInsightRowProps): JSX.Element | null => {
  const relatedFiles = execution.response?.relatedFiles ?? [];
  const verification = execution.response?.verification ?? [];
  const continuationCount = execution.autopilot?.continuationCount ?? 0;

  if (
    relatedFiles.length === 0 &&
    verification.length === 0 &&
    continuationCount === 0
  ) {
    return null;
  }

  return (
    <div className="flex max-w-[90%] flex-wrap items-center gap-2">
      {continuationCount > 0 ? (
        <Badge className="border-violet-500/20 bg-violet-500/10 text-violet-200">
          {`Auto review ×${continuationCount}`}
        </Badge>
      ) : null}

      {verification.length > 0 ? (
        <Badge
          className="border-emerald-500/20 bg-emerald-500/10 text-emerald-200"
          title={verification.join(" • ")}
        >
          {`${verification.length} check${verification.length === 1 ? "" : "s"}`}
        </Badge>
      ) : null}

      {relatedFiles.map((fileReference) => (
        <Button
          key={`${execution.task}-${fileReference.path}`}
          type="button"
          variant="outline"
          size="sm"
          title={`${fileReference.path} — ${fileReference.description}`}
          onClick={() => onOpenWorkspaceFile(fileReference.path)}
          className="h-8 max-w-full rounded-full border-slate-700 bg-slate-950/70 px-3 text-xs text-slate-300 hover:bg-slate-900 hover:text-slate-100 disabled:opacity-60"
        >
          <span className="truncate">
            {getRelatedFileButtonLabel(fileReference.path)}
          </span>
        </Button>
      ))}
    </div>
  );
};

const WEB_SEARCH_PROVIDER_LABELS: Record<WebSearchProvider, string> = {
  none: "None",
  perplexity: "Perplexity",
  tavily: "Tavily",
};

const getWebSearchProviderLabel = (provider: WebSearchProvider): string => {
  return WEB_SEARCH_PROVIDER_LABELS[provider];
};

const createEmptyWebSearchSettings = (): UserWebSearchSettings => {
  return {
    activeProvider: "none",
    apiKeys: {},
    providerAvailability: USER_WEB_SEARCH_PROVIDER_ORDER.map((provider) => ({
      provider,
      configured: false,
    })),
  };
};

const createEmptyUserMemorySettings = (): UserMemorySettings => {
  return {
    globalEnabled: false,
    entries: [],
  };
};

const createConversationContextFromSession = (
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

const formatSavedFactCount = (count: number): string => {
  return `${count} saved fact${count === 1 ? "" : "s"}`;
};

interface MemoryShortcutButtonProps {
  label: string;
  description: string;
  pressed: boolean;
  disabled?: boolean;
  icon: JSX.Element;
  onClick: () => void;
  className?: string;
}

const MemoryShortcutButton = ({
  label,
  description,
  pressed,
  disabled = false,
  icon,
  onClick,
  className,
}: MemoryShortcutButtonProps): JSX.Element => {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label={label}
          aria-pressed={pressed}
          aria-disabled={disabled || undefined}
          onClick={() => {
            if (!disabled) {
              onClick();
            }
          }}
          className={cn(
            "h-8 w-8 rounded-full border-slate-800 bg-slate-950/70 text-slate-400 shadow-none hover:bg-slate-900 hover:text-slate-100",
            disabled &&
              "cursor-not-allowed border-dashed bg-slate-950/40 text-slate-600 hover:bg-slate-950/40 hover:text-slate-600",
            className,
          )}
        >
          {icon}
        </Button>
      </TooltipTrigger>
      <TooltipContent
        side="top"
        className="max-w-64 rounded-2xl border-slate-800 bg-slate-950 text-slate-100"
      >
        <div className="grid gap-1">
          <p className="text-xs font-semibold text-slate-100">{label}</p>
          <p className="text-xs leading-5 text-slate-400">{description}</p>
        </div>
      </TooltipContent>
    </Tooltip>
  );
};

export const ChatSession = (): JSX.Element => {
  const initialShellStateRef = useRef<ShellPersistedState>(
    createInitialShellState(),
  );
  const [shellState, setShellState] = useState<ShellPersistedState>(
    initialShellStateRef.current,
  );
  const [hasHydrated, setHasHydrated] = useState(false);
  const [sessionScopeFilter, setSessionScopeFilter] =
    useState<SessionScopeFilter>("open");
  const [sessionStatusFilter, setSessionStatusFilter] =
    useState<SessionStatusFilter>("any");
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [settingsSection, setSettingsSection] =
    useState<SettingsSection>("providers");
  const [isRenamingSession, setIsRenamingSession] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [runtimeSnapshot, setRuntimeSnapshot] =
    useState<RuntimeSnapshot | null>(null);
  const [runtimeLoading, setRuntimeLoading] = useState(false);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [providerSetupProvider, setProviderSetupProvider] =
    useState<UserApiKeyProvider>("openai");
  const [providerSetupKeys, setProviderSetupKeys] =
    useState<UserProviderApiKeys>({});
  const [providerSetupKey, setProviderSetupKey] = useState("");
  const [providerSetupSaving, setProviderSetupSaving] = useState(false);
  const [providerSetupMessage, setProviderSetupMessage] = useState<{
    tone: "success" | "error";
    text: string;
  } | null>(null);
  const [webSearchActiveProvider, setWebSearchActiveProvider] =
    useState<WebSearchProvider>("none");
  const [webSearchSetupProvider, setWebSearchSetupProvider] =
    useState<UserWebSearchApiKeyProvider>("perplexity");
  const [webSearchSetupKeys, setWebSearchSetupKeys] =
    useState<UserWebSearchApiKeys>({});
  const [webSearchSetupKey, setWebSearchSetupKey] = useState("");
  const [webSearchSetupSaving, setWebSearchSetupSaving] = useState(false);
  const [webSearchSetupMessage, setWebSearchSetupMessage] = useState<{
    tone: "success" | "error";
    text: string;
  } | null>(null);
  const [userMemorySettings, setUserMemorySettings] =
    useState<UserMemorySettings>(createEmptyUserMemorySettings());
  const [memorySetupSaving, setMemorySetupSaving] = useState(false);
  const [memorySetupMessage, setMemorySetupMessage] = useState<{
    tone: "success" | "error";
    text: string;
  } | null>(null);
  const [promptHistoryIndex, setPromptHistoryIndex] = useState<number | null>(
    null,
  );
  const [draftBeforeHistory, setDraftBeforeHistory] = useState("");
  const didMutateBeforeHydrationRef = useRef(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const scheduledTimeoutsRef = useRef<number[]>([]);

  const [globalProviders, setGlobalProviders] = useState<
    RuntimeProviderAvailability[] | null
  >(null);

  const activeSession =
    shellState.sessions.find(
      (session) => session.id === shellState.activeSessionId,
    ) ?? shellState.sessions[0];

  const visibleMessages = useMemo(() => {
    return createVisibleConversationMessages(activeSession.messages);
  }, [activeSession.messages]);

  const sortedSessions = useMemo(() => {
    return sortSessionsByUpdatedAt(shellState.sessions);
  }, [shellState.sessions]);

  const filteredSessions = useMemo(() => {
    return sortedSessions.filter((session) => {
      const archived = isSessionArchived(session);
      const sessionStatus = getSessionOverviewStatus(session);
      const matchesScope =
        sessionScopeFilter === "all"
          ? true
          : sessionScopeFilter === "archived"
            ? archived
            : !archived;
      const matchesStatus =
        sessionStatusFilter === "any"
          ? true
          : sessionStatus === sessionStatusFilter;

      return matchesScope && matchesStatus;
    });
  }, [sessionScopeFilter, sessionStatusFilter, sortedSessions]);

  const activeProviderStats = runtimeSnapshot
    ? runtimeSnapshot.providerAvailability
    : (globalProviders ?? []);

  const runtimeProviderLookup = new Map(
    activeProviderStats.map((entry) => [entry.provider, entry.configured]),
  );

  const configuredProviders = isTauri()
    ? SUPPORTED_PROVIDER_ORDER.filter(
        (provider) => runtimeProviderLookup.get(provider) ?? false,
      )
    : [...SUPPORTED_PROVIDER_ORDER];

  const chooserProviders =
    configuredProviders.length > 0
      ? configuredProviders
      : [...SUPPORTED_PROVIDER_ORDER];

  const applyLoadedWebSearchSettings = (
    settings: UserWebSearchSettings,
  ): void => {
    const nextKeyProvider =
      settings.activeProvider === "none"
        ? USER_WEB_SEARCH_PROVIDER_ORDER[0]
        : settings.activeProvider;

    setWebSearchActiveProvider(settings.activeProvider);
    setWebSearchSetupProvider(nextKeyProvider);
  };

  const applyLoadedUserMemorySettings = (
    settings: UserMemorySettings,
  ): void => {
    setUserMemorySettings(settings);
  };

  const refreshWorkspaceRuntimeSnapshot = async (
    workspaceRoot: string | null,
  ): Promise<void> => {
    setRuntimeLoading(true);
    setRuntimeError(null);

    try {
      const snapshot = await loadWorkspaceRuntimeSnapshot(workspaceRoot);

      setRuntimeSnapshot(snapshot);

      if (!snapshot && isTauri()) {
        setRuntimeError(
          "Runtime metadata is unavailable for this workspace right now.",
        );
      }
    } catch (error) {
      console.error("Failed to resolve runtime snapshot", error);
      setRuntimeSnapshot(null);
      setRuntimeError(
        "Runtime metadata could not be loaded for this workspace.",
      );
    } finally {
      setRuntimeLoading(false);
    }
  };

  const applyShellState = (
    updater: SetStateAction<ShellPersistedState>,
  ): void => {
    if (!hasHydrated) {
      didMutateBeforeHydrationRef.current = true;
    }

    setShellState(updater);
  };

  useEffect(() => {
    let cancelled = false;
    void loadGlobalProviderAvailability().then((data) => {
      if (!cancelled) setGlobalProviders(data);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    void loadUserMemorySettings()
      .then((settings) => {
        if (!cancelled) {
          applyLoadedUserMemorySettings(settings);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          console.error("Failed to load user memory settings", error);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!catalogOpen) {
      return;
    }

    setProviderSetupProvider(activeSession.provider);
    setProviderSetupKeys({});
    setProviderSetupKey("");
    setProviderSetupMessage(null);
  }, [catalogOpen, activeSession.provider]);

  useEffect(() => {
    if (!catalogOpen) {
      return;
    }

    setProviderSetupKey(providerSetupKeys[providerSetupProvider] ?? "");
  }, [catalogOpen, providerSetupKeys, providerSetupProvider]);

  useEffect(() => {
    if (!catalogOpen) {
      return;
    }

    let cancelled = false;

    setWebSearchSetupKeys({});
    setWebSearchSetupKey("");
    setWebSearchSetupMessage(null);

    void loadUserWebSearchSettings()
      .then((settings) => {
        if (cancelled) {
          return;
        }

        applyLoadedWebSearchSettings(settings);
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }

        console.error("Failed to load web-search settings", error);
        applyLoadedWebSearchSettings(createEmptyWebSearchSettings());
      });

    return () => {
      cancelled = true;
    };
  }, [catalogOpen]);

  useEffect(() => {
    if (!catalogOpen) {
      return;
    }

    let cancelled = false;

    setMemorySetupMessage(null);

    void loadUserMemorySettings()
      .then((settings) => {
        if (!cancelled) {
          applyLoadedUserMemorySettings(settings);
        }
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }

        console.error("Failed to load user memory settings", error);
        applyLoadedUserMemorySettings(createEmptyUserMemorySettings());
      });

    return () => {
      cancelled = true;
    };
  }, [catalogOpen]);

  useEffect(() => {
    if (!catalogOpen) {
      return;
    }

    setWebSearchSetupKey(webSearchSetupKeys[webSearchSetupProvider] ?? "");
  }, [catalogOpen, webSearchSetupKeys, webSearchSetupProvider]);

  useEffect(() => {
    document.documentElement.classList.add("dark");

    return () => {
      document.documentElement.classList.remove("dark");
    };
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [visibleMessages]);

  useEffect(() => {
    let cancelled = false;

    void loadShellState(initialShellStateRef.current)
      .then((value) => {
        if (cancelled) {
          return;
        }

        if (
          didMutateBeforeHydrationRef.current ||
          value === initialShellStateRef.current
        ) {
          return;
        }

        setShellState(normalizeShellState(value));
      })
      .finally(() => {
        if (!cancelled) {
          setHasHydrated(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!hasHydrated) {
      return;
    }

    void saveShellState(shellState);
  }, [hasHydrated, shellState]);

  useEffect(() => {
    setPromptHistoryIndex(null);
    setDraftBeforeHistory("");
    setIsRenamingSession(false);
    setRenameValue(getSessionTitle(activeSession));
  }, [activeSession.id, activeSession.manualTitle, activeSession.messages]);

  useEffect(() => {
    let cancelled = false;

    void refreshWorkspaceRuntimeSnapshot(activeSession.workspace).catch(
      (error) => {
        if (!cancelled) {
          console.error("Failed to refresh runtime snapshot", error);
        }
      },
    );

    return () => {
      cancelled = true;
    };
  }, [activeSession.workspace]);

  useEffect(() => {
    return () => {
      scheduledTimeoutsRef.current.forEach((timeoutId) => {
        window.clearTimeout(timeoutId);
      });
      scheduledTimeoutsRef.current = [];
    };
  }, []);

  const updateActiveSession = (
    updater: (session: ChatSessionRecord) => ChatSessionRecord,
  ): void => {
    applyShellState((prev) => ({
      ...prev,
      sessions: prev.sessions.map((session) =>
        session.id === prev.activeSessionId ? updater(session) : session,
      ),
    }));
  };

  const updateSessionById = (
    sessionId: string,
    updater: (session: ChatSessionRecord) => ChatSessionRecord,
  ): void => {
    applyShellState((prev) => ({
      ...prev,
      sessions: prev.sessions.map((session) =>
        session.id === sessionId ? updater(session) : session,
      ),
    }));
  };

  const setDraftValue = (value: string): void => {
    updateActiveSession((session) => ({
      ...session,
      draft: value,
    }));
  };

  const scheduleMessage = (callback: () => void, delay: number): void => {
    const timeoutId = window.setTimeout(() => {
      scheduledTimeoutsRef.current = scheduledTimeoutsRef.current.filter(
        (entry) => entry !== timeoutId,
      );
      callback();
    }, delay);

    scheduledTimeoutsRef.current.push(timeoutId);
  };

  const appendAgentMessage = (
    sessionId: string,
    taskId: string,
    content: string,
    source?: ChatSessionMessage["source"],
  ): void => {
    updateSessionById(sessionId, (session) => ({
      ...session,
      updatedAt: Date.now(),
      messages: [
        ...session.messages,
        {
          id: crypto.randomUUID(),
          taskId,
          role: "agent",
          content,
          createdAt: Date.now(),
          ...(source ? { source } : {}),
        },
      ],
    }));
  };

  const createExecutionMessageContent = (
    execution: TaskExecutionResult,
  ): string => {
    return getExecutionMessageContent(execution);
  };

  const formatTaskExecutionError = (error: unknown): string => {
    const detail = error instanceof Error ? error.message : String(error);

    return `**Desktop handoff failed.** ${detail}`;
  };

  const createNewSession = (): void => {
    applyShellState((prev) => {
      const provider =
        chooserProviders.find((entry) => entry === prev.lastSelectedProvider) ??
        chooserProviders[0] ??
        prev.lastSelectedProvider;
      const session = createSession({
        workspace: activeSession.workspace,
        provider,
        model:
          prev.lastSelectedModelByProvider[provider] ??
          getDefaultModelForProvider(provider),
      });

      return {
        ...prev,
        activeSessionId: session.id,
        sessions: [session, ...prev.sessions],
      };
    });
  };

  const deleteSession = (sessionId: string): void => {
    applyShellState((prev) => {
      const remainingSessions = prev.sessions.filter(
        (session) => session.id !== sessionId,
      );

      if (remainingSessions.length === 0) {
        const replacement = createSession({
          workspace: activeSession.workspace,
          provider: prev.lastSelectedProvider,
          model:
            prev.lastSelectedModelByProvider[prev.lastSelectedProvider] ??
            getDefaultModelForProvider(prev.lastSelectedProvider),
        });

        return {
          ...prev,
          activeSessionId: replacement.id,
          sessions: [replacement],
        };
      }

      return {
        ...prev,
        activeSessionId:
          prev.activeSessionId === sessionId
            ? sortSessionsByUpdatedAt(remainingSessions)[0].id
            : prev.activeSessionId,
        sessions: remainingSessions,
      };
    });
  };

  const handleActivateSession = (sessionId: string): void => {
    applyShellState((prev) => ({
      ...prev,
      activeSessionId: sessionId,
    }));
  };

  const handleArchiveSession = (sessionId: string): void => {
    updateSessionById(sessionId, (session) => {
      if (!canArchiveSession(session)) {
        return session;
      }

      return {
        ...session,
        archivedAt: Date.now(),
      };
    });
  };

  const handleRenameCommit = (): void => {
    const trimmed = renameValue.trim();

    updateActiveSession((session) => {
      const sessionWithoutManualTitle = { ...session };

      delete sessionWithoutManualTitle.manualTitle;

      return trimmed.length > 0
        ? {
            ...sessionWithoutManualTitle,
            manualTitle: trimmed,
            updatedAt: Date.now(),
          }
        : {
            ...sessionWithoutManualTitle,
            updatedAt: Date.now(),
          };
    });

    setIsRenamingSession(false);
  };

  const handleSelectFolder = async (): Promise<void> => {
    if (!isTauri()) {
      updateActiveSession((session) => ({
        ...session,
        workspace: "/mock/workspace/path",
        updatedAt: Date.now(),
      }));
      return;
    }

    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: "Select Workspace Folder",
      });

      if (selected && typeof selected === "string") {
        updateActiveSession((session) => ({
          ...session,
          workspace: selected,
          updatedAt: Date.now(),
        }));
      }
    } catch (error) {
      console.error("Failed to select folder", error);
    }
  };

  const handleSessionModelSelection = (
    provider: RuntimeProvider,
    model: string,
  ): void => {
    applyShellState((prev) => ({
      ...prev,
      lastSelectedProvider: provider,
      lastSelectedModelByProvider: {
        ...prev.lastSelectedModelByProvider,
        [provider]: model,
      },
      sessions: prev.sessions.map((session) =>
        session.id === prev.activeSessionId
          ? {
              ...session,
              provider,
              model,
              updatedAt: Date.now(),
            }
          : session,
      ),
    }));
  };

  const handleProviderSetupSave = async (): Promise<void> => {
    const normalizedKey = providerSetupKey.trim();

    if (!normalizedKey || !isTauri()) {
      return;
    }

    setProviderSetupSaving(true);
    setProviderSetupMessage(null);

    try {
      const nextProviders = await saveUserProviderApiKey(
        providerSetupProvider,
        normalizedKey,
      );

      setGlobalProviders(nextProviders);
      setProviderSetupKeys((prev) => ({
        ...prev,
        [providerSetupProvider]: "",
      }));
      setProviderSetupKey("");
      setProviderSetupMessage({
        tone: "success",
        text: `${getProviderLabel(providerSetupProvider)} is ready to use.`,
      });

      await refreshWorkspaceRuntimeSnapshot(activeSession.workspace);
    } catch (error) {
      setProviderSetupMessage({
        tone: "error",
        text:
          error instanceof Error
            ? error.message
            : "The API key could not be saved.",
      });
    } finally {
      setProviderSetupSaving(false);
    }
  };

  const handleWebSearchActiveProviderSave = async (
    provider: WebSearchProvider,
  ): Promise<void> => {
    setWebSearchSetupSaving(true);
    setWebSearchSetupMessage(null);

    try {
      const settings = await saveUserWebSearchActiveProvider(provider);

      applyLoadedWebSearchSettings(settings);
      setWebSearchSetupMessage({
        tone: "success",
        text:
          provider === "none"
            ? "Web search is hidden for new tasks."
            : `${getWebSearchProviderLabel(provider)} is now the active web-search provider.`,
      });

      await refreshWorkspaceRuntimeSnapshot(activeSession.workspace);
    } catch (error) {
      setWebSearchSetupMessage({
        tone: "error",
        text:
          error instanceof Error
            ? error.message
            : "The web-search provider could not be saved.",
      });
    } finally {
      setWebSearchSetupSaving(false);
    }
  };

  const handleWebSearchSetupSave = async (): Promise<void> => {
    const normalizedKey = webSearchSetupKey.trim();

    if (!normalizedKey || !isTauri()) {
      return;
    }

    setWebSearchSetupSaving(true);
    setWebSearchSetupMessage(null);

    try {
      const settings = await saveUserWebSearchApiKey(
        webSearchSetupProvider,
        normalizedKey,
      );

      applyLoadedWebSearchSettings(settings);
      setWebSearchSetupKeys((prev) => ({
        ...prev,
        [webSearchSetupProvider]: "",
      }));
      setWebSearchSetupKey("");
      setWebSearchSetupMessage({
        tone: "success",
        text: `${getWebSearchProviderLabel(webSearchSetupProvider)} is ready for web search.`,
      });

      await refreshWorkspaceRuntimeSnapshot(activeSession.workspace);
    } catch (error) {
      setWebSearchSetupMessage({
        tone: "error",
        text:
          error instanceof Error
            ? error.message
            : "The web-search API key could not be saved.",
      });
    } finally {
      setWebSearchSetupSaving(false);
    }
  };

  const handleGlobalMemoryEnabledSave = async (
    enabled: boolean,
  ): Promise<void> => {
    if (!isTauri()) {
      applyLoadedUserMemorySettings({
        ...userMemorySettings,
        globalEnabled: enabled,
      });
      return;
    }

    setMemorySetupSaving(true);
    setMemorySetupMessage(null);

    try {
      const settings = await saveUserGlobalMemoryEnabled(enabled);

      applyLoadedUserMemorySettings(settings);
      setMemorySetupMessage({
        tone: "success",
        text: enabled
          ? "Global memory is now enabled for future sessions."
          : "Global memory is now disabled by default.",
      });
    } catch (error) {
      setMemorySetupMessage({
        tone: "error",
        text:
          error instanceof Error
            ? error.message
            : "Global memory could not be updated.",
      });
    } finally {
      setMemorySetupSaving(false);
    }
  };

  const handleSessionMemoryEnabledChange = (enabled: boolean): void => {
    updateActiveSession((session) => ({
      ...session,
      sessionMemoryEnabled: enabled,
      updatedAt: Date.now(),
    }));
  };

  const handleUseGlobalMemoryChange = (enabled: boolean): void => {
    updateActiveSession((session) => ({
      ...session,
      useGlobalMemory: enabled,
      updatedAt: Date.now(),
    }));
  };

  const handleDraftChange = (value: string): void => {
    setPromptHistoryIndex(null);
    setDraftBeforeHistory("");
    setDraftValue(value);
  };

  const handleComposerHistoryNavigation = (
    event: KeyboardEvent<HTMLTextAreaElement>,
  ): void => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") {
      return;
    }

    if (activeSession.promptHistory.length === 0) {
      return;
    }

    event.preventDefault();

    if (event.key === "ArrowUp") {
      if (promptHistoryIndex === null) {
        setDraftBeforeHistory(activeSession.draft);

        const nextIndex = activeSession.promptHistory.length - 1;
        setPromptHistoryIndex(nextIndex);
        setDraftValue(activeSession.promptHistory[nextIndex]);
        return;
      }

      const nextIndex = Math.max(promptHistoryIndex - 1, 0);
      setPromptHistoryIndex(nextIndex);
      setDraftValue(activeSession.promptHistory[nextIndex]);
      return;
    }

    if (promptHistoryIndex === null) {
      return;
    }

    const nextIndex = promptHistoryIndex + 1;

    if (nextIndex >= activeSession.promptHistory.length) {
      setPromptHistoryIndex(null);
      setDraftValue(draftBeforeHistory);
      setDraftBeforeHistory("");
      return;
    }

    setPromptHistoryIndex(nextIndex);
    setDraftValue(activeSession.promptHistory[nextIndex]);
  };

  const handleOpenWorkspaceFile = (relativePath: string): void => {
    void openWorkspacePath(activeSession.workspace, relativePath).catch(
      (error) => {
        console.error("Failed to open workspace path", error);
      },
    );
  };

  const handleSend = (): void => {
    const task = activeSession.draft.trim();

    if (!task) {
      return;
    }

    const taskId = crypto.randomUUID();
    const sessionId = activeSession.id;
    const selectedProvider = activeSession.provider;
    const selectedModel = activeSession.model;
    const conversationContext = createConversationContextFromSession(
      activeSession,
      userMemorySettings.globalEnabled,
    );
    const taskRunPromise = runDesktopTask(activeSession.workspace, task, {
      conversationContext,
      provider: selectedProvider,
      model: selectedModel,
      taskId,
    });
    let taskFailureReported = false;

    const reportTaskFailure = (error: unknown): void => {
      if (taskFailureReported) {
        return;
      }

      taskFailureReported = true;
      appendAgentMessage(sessionId, taskId, formatTaskExecutionError(error));
    };

    const updatedPromptHistory =
      activeSession.promptHistory.at(-1) === task
        ? activeSession.promptHistory
        : [...activeSession.promptHistory, task].slice(-40);

    if (isSessionArchived(activeSession) && sessionScopeFilter === "archived") {
      setSessionScopeFilter("open");
    }

    updateActiveSession((session) => {
      const sessionWithoutArchive = removeSessionArchiveFlag(session);

      return {
        ...sessionWithoutArchive,
        draft: "",
        updatedAt: Date.now(),
        messages: [
          ...sessionWithoutArchive.messages,
          {
            id: crypto.randomUUID(),
            taskId,
            role: "user",
            content: task,
            createdAt: Date.now(),
          },
        ],
        promptHistory: updatedPromptHistory,
      };
    });

    setPromptHistoryIndex(null);
    setDraftBeforeHistory("");

    void taskRunPromise
      .then((taskRun) => {
        const sessionMemoryUpdates =
          taskRun.execution.memoryUpdates
            ?.filter((update) => update.scope === "session")
            .map((update) => update.entry) ?? [];
        const wroteGlobalMemory =
          taskRun.execution.memoryUpdates?.some(
            (update) => update.scope === "global",
          ) ?? false;

        if (sessionMemoryUpdates.length > 0) {
          updateSessionById(sessionId, (session) => ({
            ...session,
            sessionMemory: mergeConversationMemoryEntries(
              session.sessionMemory,
              sessionMemoryUpdates,
              MAX_SESSION_MEMORY_ENTRIES,
            ),
            updatedAt: Date.now(),
          }));
        }

        if (wroteGlobalMemory) {
          void loadUserMemorySettings()
            .then(applyLoadedUserMemorySettings)
            .catch((error) => {
              console.error("Failed to refresh user memory settings", error);
            });
        }

        if (taskRun.preview) {
          const preview = taskRun.preview;

          scheduleMessage(() => {
            appendAgentMessage(
              sessionId,
              taskId,
              "I staged a compact task preview for this request, including likely tools, approvals, and the safest first move.",
              {
                kind: "preview",
                preview,
              },
            );
          }, 220);
        }

        scheduleMessage(
          () => {
            appendAgentMessage(
              sessionId,
              taskId,
              createExecutionMessageContent(taskRun.execution),
              {
                kind: "execution",
                execution: taskRun.execution,
              },
            );
          },
          taskRun.preview ? 700 : 220,
        );
      })
      .catch(reportTaskFailure);
  };

  const stopTitlebarEvent = (
    event: React.MouseEvent<HTMLButtonElement>,
  ): void => {
    event.preventDefault();
    event.stopPropagation();
  };

  const handleMinimizeWindow = (
    event: React.MouseEvent<HTMLButtonElement>,
  ): void => {
    stopTitlebarEvent(event);

    if (!isTauri()) {
      return;
    }

    void getCurrentWindow()
      .minimize()
      .catch((error) => {
        console.error("Failed to minimize window", error);
      });
  };

  const handleToggleMaximizeWindow = (
    event: React.MouseEvent<HTMLButtonElement>,
  ): void => {
    stopTitlebarEvent(event);

    if (!isTauri()) {
      return;
    }

    void (async () => {
      const currentWindow = getCurrentWindow();
      const shouldMaximize = !(await currentWindow.isMaximized());

      if (shouldMaximize) {
        await currentWindow.maximize();
        return;
      }

      await currentWindow.unmaximize();
    })().catch((error) => {
      console.error("Failed to toggle window maximize state", error);
    });
  };

  const handleCloseWindow = (
    event: React.MouseEvent<HTMLButtonElement>,
  ): void => {
    stopTitlebarEvent(event);

    if (!isTauri()) {
      return;
    }

    void getCurrentWindow()
      .close()
      .catch((error) => {
        console.error("Failed to close window", error);
      });
  };

  const hasAnyProvider =
    isTauri() && globalProviders !== null
      ? activeProviderStats.some((p) => p.configured)
      : true;

  const currentSessionTitle = getSessionTitle(activeSession);
  const hasActiveWorkspace = activeSession.workspace !== null;
  const composerWorkspaceLabel = hasActiveWorkspace
    ? getWorkspaceLabel(activeSession.workspace)
    : "Choose workspace";
  const canSendMessage = Boolean(activeSession.draft.trim());
  const sessionMemoryFactCount = activeSession.sessionMemory.length;
  const globalMemoryFactCount = userMemorySettings.entries.length;
  const sessionListCountLabel =
    filteredSessions.length === shellState.sessions.length
      ? `${shellState.sessions.length} saved session${shellState.sessions.length === 1 ? "" : "s"}`
      : `${filteredSessions.length} of ${shellState.sessions.length} saved sessions`;
  const isGlobalMemoryAvailable = userMemorySettings.globalEnabled;
  const isGlobalMemoryActive =
    isGlobalMemoryAvailable && activeSession.useGlobalMemory;
  const sessionMemoryDescription = activeSession.sessionMemoryEnabled
    ? `${formatSavedFactCount(sessionMemoryFactCount)} available in this session.`
    : "Session-only facts are paused for this conversation.";
  const globalMemoryDescription = !isGlobalMemoryAvailable
    ? "Unavailable right now. Enable global memory in Settings to bridge this session."
    : isGlobalMemoryActive
      ? `${formatSavedFactCount(globalMemoryFactCount)} available across sessions.`
      : `${formatSavedFactCount(globalMemoryFactCount)} available across sessions, but this session is not using them.`;

  return (
    <TooltipProvider delayDuration={250}>
      <Dialog open={catalogOpen} onOpenChange={setCatalogOpen}>
        <div className="dark flex h-screen w-full flex-col overflow-hidden rounded-xl border border-slate-800 bg-slate-950 font-sans text-slate-100 antialiased">
          <div className="relative z-50 flex h-10 w-full shrink-0 select-none items-center border-b border-slate-900 bg-slate-950/90 px-3">
            <div aria-hidden="true" className="absolute inset-0" data-tauri-drag-region />
            <div className="relative z-10 flex items-center gap-2" data-tauri-drag-region>
              <TerminalSquare
                className="h-4 w-4 text-sky-500"
                data-tauri-drag-region
              />
              <span
                className="text-[11px] font-bold tracking-[0.2em] text-slate-400 uppercase"
                data-tauri-drag-region
              >
                Machdoch
              </span>
            </div>
            <div className="min-w-0 flex-1" data-tauri-drag-region />
            {isTauri() && (
              <div
                className="relative z-10 flex items-center gap-1"
                data-tauri-no-drag
              >
                {SUPPORTED_PROVIDER_ORDER.map((provider) => {
                  const configured =
                    runtimeProviderLookup.get(provider) ?? false;
                  return (
                    <Tooltip key={provider}>
                      <TooltipTrigger asChild>
                        <div
                          className={cn(
                            "w-2 h-2 rounded-full mx-1",
                            configured
                              ? "bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.4)]"
                              : "bg-slate-700",
                          )}
                          data-tauri-no-drag
                        />
                      </TooltipTrigger>
                      <TooltipContent side="bottom" className="text-xs">
                        <span className="font-semibold text-slate-200">
                          {getProviderLabel(provider)}
                        </span>
                        : {configured ? "Connected" : "Unconfigured"}
                      </TooltipContent>
                    </Tooltip>
                  );
                })}
                <div className="w-px h-4 bg-slate-800 mx-2" />
                <button
                  type="button"
                  className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-800 hover:text-slate-100 transition-colors pointer-events-auto"
                  data-tauri-no-drag
                  onMouseDown={(event) => {
                    event.stopPropagation();
                  }}
                  onClick={handleMinimizeWindow}
                  tabIndex={-1}
                >
                  <svg width="10" height="1" viewBox="0 0 10 1">
                    <path fill="currentColor" d="M0 0h10v1H0z" />
                  </svg>
                </button>
                <button
                  type="button"
                  className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-800 hover:text-slate-100 transition-colors pointer-events-auto"
                  data-tauri-no-drag
                  onMouseDown={(event) => {
                    event.stopPropagation();
                  }}
                  onClick={handleToggleMaximizeWindow}
                  tabIndex={-1}
                >
                  <svg width="10" height="10" viewBox="0 0 10 10">
                    <path
                      fill="currentColor"
                      fillRule="evenodd"
                      d="M1 1h8v8H1V1zm1 1v6h6V2H2z"
                    />
                  </svg>
                </button>
                <button
                  type="button"
                  className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-slate-400 hover:bg-red-500 hover:text-white transition-colors pointer-events-auto"
                  data-tauri-no-drag
                  onMouseDown={(event) => {
                    event.stopPropagation();
                  }}
                  onClick={handleCloseWindow}
                  tabIndex={-1}
                >
                  <svg width="10" height="10" viewBox="0 0 10 10">
                    <path
                      fill="currentColor"
                      fillRule="evenodd"
                      d="M1.354 2.061l7.07 7.071-.707.707-7.071-7.071.708-.707z"
                    />
                    <path
                      fill="currentColor"
                      fillRule="evenodd"
                      d="M8.425 1.354l.707.707-7.071 7.071-.707-.707 7.071-7.071z"
                    />
                  </svg>
                </button>
              </div>
            )}
          </div>

          <div className="flex h-full w-full overflow-hidden bg-[#050816]">
            <aside className="flex w-19 flex-col items-center justify-between border-r border-slate-900 bg-slate-950 py-6 shrink-0 z-10">
              <div className="flex flex-col items-center gap-6">
                <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-sky-500/90 shadow-lg shadow-sky-950/40">
                  <TerminalSquare className="h-6 w-6 text-white" />
                </div>

                <Separator className="w-10 bg-slate-800" />
              </div>

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label="Settings"
                    onClick={() => {
                      setSettingsSection("providers");
                      setCatalogOpen(true);
                    }}
                    className="h-12 w-12 rounded-2xl text-slate-400 hover:bg-slate-900 hover:text-slate-100"
                  >
                    <Cog className="h-5 w-5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="right">Settings</TooltipContent>
              </Tooltip>
            </aside>

            <aside className="flex min-h-0 w-84 flex-col border-r border-slate-900 bg-slate-950/50 backdrop-blur-xl">
              <div className="flex h-16 items-center justify-between border-b border-slate-900 px-5">
                <div>
                  <p className="text-xs font-semibold tracking-[0.24em] text-slate-500 uppercase">
                    Sessions
                  </p>
                  <p className="mt-1 text-sm text-slate-400">
                    {sessionListCountLabel}
                  </p>
                </div>

                <Button
                  type="button"
                  size="sm"
                  onClick={createNewSession}
                  className="rounded-xl bg-sky-600 text-white hover:bg-sky-500"
                >
                  <Plus className="h-4 w-4" />
                  New
                </Button>
              </div>

              <ScrollArea className="min-h-0 flex-1" type="always">
                <div className="space-y-4 px-5 py-5 pr-7">
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="flex items-center gap-1.5 rounded-full border border-slate-800/80 bg-slate-950/70 p-1">
                      {SESSION_SCOPE_FILTERS.map((filter) => {
                        const FilterIcon = filter.icon;
                        const isSelected = sessionScopeFilter === filter.id;

                        return (
                          <Tooltip key={filter.id}>
                            <TooltipTrigger asChild>
                              <Button
                                type="button"
                                size="icon"
                                variant="ghost"
                                aria-label={`Scope: ${filter.label}`}
                                aria-pressed={isSelected}
                                onClick={() => setSessionScopeFilter(filter.id)}
                                className={cn(
                                  "h-8 w-8 rounded-full border border-transparent text-slate-400 shadow-none hover:bg-slate-900 hover:text-slate-100",
                                  isSelected &&
                                    "border-sky-500/30 bg-sky-500/10 text-sky-100 hover:bg-sky-500/15 hover:text-white",
                                )}
                              >
                                <FilterIcon className="h-3.5 w-3.5" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent side="top">
                              {`Scope: ${filter.label}`}
                            </TooltipContent>
                          </Tooltip>
                        );
                      })}
                    </div>

                    <div className="flex items-center gap-1.5 rounded-full border border-slate-800/80 bg-slate-950/70 p-1">
                      {SESSION_STATUS_FILTERS.map((filter) => {
                        const FilterIcon = filter.icon;
                        const isSelected = sessionStatusFilter === filter.id;

                        return (
                          <Tooltip key={filter.id}>
                            <TooltipTrigger asChild>
                              <Button
                                type="button"
                                size="icon"
                                variant="ghost"
                                aria-label={`Status: ${filter.label}`}
                                aria-pressed={isSelected}
                                onClick={() => setSessionStatusFilter(filter.id)}
                                className={cn(
                                  "h-8 w-8 rounded-full border border-transparent text-slate-400 shadow-none hover:bg-slate-900 hover:text-slate-100",
                                  isSelected &&
                                    "border-sky-500/30 bg-sky-500/10 text-sky-100 hover:bg-sky-500/15 hover:text-white",
                                )}
                              >
                                <FilterIcon className="h-3.5 w-3.5" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent side="top">
                              {`Status: ${filter.label}`}
                            </TooltipContent>
                          </Tooltip>
                        );
                      })}
                    </div>
                  </div>

                  {filteredSessions.length === 0 ? (
                    <div className="rounded-2xl border border-dashed border-slate-800 bg-slate-950/60 px-4 py-6 text-center text-sm leading-6 text-slate-500">
                      No sessions match the current filters.
                    </div>
                  ) : (
                    filteredSessions.map((session) => {
                      const isActive = session.id === activeSession.id;
                      const archived = isSessionArchived(session);
                      const sessionStatus = getSessionOverviewStatus(session);
                      const statusMeta = SESSION_STATUS_META[sessionStatus];
                      const SessionStatusIcon = statusMeta.icon;
                      const showArchiveAction = canArchiveSession(session);

                      return (
                        <div
                          key={session.id}
                          className={cn(
                            "group flex items-start gap-2 rounded-xl border px-3 py-2.5 transition-all",
                            isActive
                              ? "border-sky-500/30 bg-sky-500/10 shadow-lg shadow-sky-950/20"
                              : "border-slate-800 bg-slate-950/70 hover:border-slate-700 hover:bg-slate-950",
                            archived &&
                              (isActive
                                ? "border-dashed"
                                : "border-dashed opacity-80"),
                          )}
                        >
                          <button
                            type="button"
                            aria-label={`Open session ${getSessionTitle(session)}`}
                            onClick={() => handleActivateSession(session.id)}
                            className="min-w-0 flex-1 text-left"
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <p
                                  className={cn(
                                    "truncate text-sm font-semibold placeholder:text-slate-500",
                                    archived
                                      ? "text-slate-300"
                                      : "text-slate-100",
                                  )}
                                >
                                  {getSessionTitle(session)}
                                </p>
                              </div>
                            </div>

                            <div className="mt-1 flex items-center justify-between text-[10px] font-medium tracking-wide text-slate-500 uppercase">
                              <span className="mr-2 truncate">
                                {createSessionSubtitle(session)}
                              </span>
                              <span className="shrink-0">
                                {formatSessionTimestamp(session.updatedAt)}
                              </span>
                            </div>
                          </button>

                          <div className="flex shrink-0 items-center gap-1 self-start pt-0.5">
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <div
                                  aria-label={`Session status: ${statusMeta.label}`}
                                  className={cn(
                                    "flex h-8 w-8 items-center justify-center rounded-full border",
                                    statusMeta.containerClassName,
                                  )}
                                >
                                  <SessionStatusIcon
                                    className={cn(
                                      "h-4 w-4",
                                      statusMeta.iconClassName,
                                    )}
                                  />
                                </div>
                              </TooltipTrigger>
                              <TooltipContent side="top">
                                {statusMeta.label}
                              </TooltipContent>
                            </Tooltip>

                            {archived ? (
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <div
                                    aria-label="Archived session"
                                    className="flex h-8 w-8 items-center justify-center rounded-full border border-slate-800 bg-slate-950/80 text-slate-500"
                                  >
                                    <Archive className="h-3.5 w-3.5" />
                                  </div>
                                </TooltipTrigger>
                                <TooltipContent side="top">
                                  Archived
                                </TooltipContent>
                              </Tooltip>
                            ) : null}

                            {showArchiveAction ? (
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Button
                                    type="button"
                                    size="icon"
                                    variant="ghost"
                                    aria-label={`Archive ${getSessionTitle(session)}`}
                                    onClick={() =>
                                      handleArchiveSession(session.id)
                                    }
                                    className={cn(
                                      "h-8 w-8 rounded-full border border-slate-800 bg-slate-950/80 text-slate-500 transition-all hover:border-slate-700 hover:bg-slate-900 hover:text-slate-100",
                                      isActive
                                        ? "opacity-100"
                                        : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100",
                                    )}
                                  >
                                    <Archive className="h-3.5 w-3.5" />
                                  </Button>
                                </TooltipTrigger>
                                <TooltipContent side="top">
                                  Archive
                                </TooltipContent>
                              </Tooltip>
                            ) : null}
                          </div>
                        </div>
                      );
                    })
                  )}

                </div>
              </ScrollArea>
            </aside>

            {isTauri() && !hasAnyProvider ? (
              <main className="flex min-min-h-0 flex-1 flex-col items-center justify-center bg-[#050816] px-6 py-12 text-center shadow-inner shadow-black/80 z-20">
                <div className="flex h-20 w-20 items-center justify-center rounded-full bg-red-500/10 mb-6 border border-red-500/20">
                  <AlertCircle className="h-10 w-10 text-red-500" />
                </div>
                <h2 className="text-2xl font-bold text-slate-100 mb-3">
                  No API Providers Configured
                </h2>
                <p className="text-slate-400 max-w-md text-sm leading-6 mb-8">
                  Save at least one provider API key in Settings to unlock the
                  desktop shell.
                </p>
                <Button
                  type="button"
                  onClick={() => {
                    setSettingsSection("providers");
                    setCatalogOpen(true);
                  }}
                  className="rounded-xl h-11 px-6 border border-slate-800 bg-slate-950 text-white hover:bg-slate-900"
                >
                  <Cog className="h-4 w-4 mr-2" />
                  Open settings
                </Button>
              </main>
            ) : (
              <main className="flex min-h-0 flex-1 flex-col bg-[#050816]">
                <header className="flex h-20 items-center justify-between border-b border-slate-900 bg-slate-950/60 px-8 backdrop-blur-md">
                  <div className="min-w-0">
                    <p className="text-xs font-semibold tracking-[0.24em] text-slate-500 uppercase">
                      machdoch desktop shell
                    </p>

                    {isRenamingSession ? (
                      <Input
                        autoFocus
                        value={renameValue}
                        onChange={(event) => setRenameValue(event.target.value)}
                        onBlur={handleRenameCommit}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            handleRenameCommit();
                          }

                          if (event.key === "Escape") {
                            event.preventDefault();
                            setRenameValue(currentSessionTitle);
                            setIsRenamingSession(false);
                          }
                        }}
                        className="mt-2 h-11 w-md max-w-full rounded-2xl border-slate-800 bg-slate-950 text-slate-100"
                      />
                    ) : (
                      <div className="mt-2 flex flex-wrap items-center gap-3">
                        <h1 className="truncate text-2xl font-semibold tracking-tight text-white">
                          {currentSessionTitle}
                        </h1>
                        <Badge className="border-sky-500/20 bg-sky-500/10 text-sky-200">
                          {getProviderLabel(activeSession.provider)}
                        </Badge>
                        <Badge className="border-slate-700 bg-slate-900 text-slate-300">
                          {activeSession.model}
                        </Badge>
                        {activeSession.workspace ? (
                          <Badge className="border-slate-700 bg-slate-900 text-slate-300">
                            {getWorkspaceLabel(activeSession.workspace)}
                          </Badge>
                        ) : null}
                      </div>
                    )}
                  </div>

                  <div className="flex shrink-0 items-center gap-2">
                    <Popover>
                      <PopoverTrigger asChild>
                        <Button
                          type="button"
                          variant="outline"
                          className="h-10 rounded-2xl border-slate-800 bg-slate-950 hover:bg-slate-900 hover:text-slate-100"
                        >
                          <Cog className="h-4 w-4 mr-2" />
                          Routing & Workspace
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent
                        align="end"
                        className="w-96 rounded-3xl border-slate-800 bg-slate-950/95 p-5 backdrop-blur-xl shadow-2xl"
                      >
                        <div className="grid gap-5">
                          <div className="grid gap-3">
                            <div className="flex items-center justify-between">
                              <p className="text-xs font-semibold tracking-[0.18em] text-slate-500 uppercase">
                                Workspace
                              </p>
                              {activeSession.workspace ? (
                                <Badge className="border-emerald-500/20 bg-emerald-500/10 text-emerald-200">
                                  Ready
                                </Badge>
                              ) : null}
                            </div>

                            <div
                              className={cn(
                                "rounded-2xl border border-dashed p-3 transition-all",
                                activeSession.workspace
                                  ? "border-sky-500/25 bg-sky-500/10"
                                  : "border-slate-800 bg-slate-950/60",
                              )}
                            >
                              <div className="flex flex-col items-center text-center gap-2">
                                <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-slate-900 text-slate-300">
                                  <FolderOpen className="h-4 w-4" />
                                </div>
                                <div className="min-w-0">
                                  <p className="truncate text-sm font-semibold text-slate-100">
                                    {getWorkspaceLabel(activeSession.workspace)}
                                  </p>
                                </div>
                              </div>
                            </div>

                            <Button
                              type="button"
                              variant="outline"
                              onClick={handleSelectFolder}
                              className="h-9 rounded-xl border-slate-800 bg-slate-900 hover:bg-slate-800 hover:text-slate-100"
                            >
                              {activeSession.workspace
                                ? "Change folder"
                                : "Select directory"}
                            </Button>
                          </div>

                          <div className="grid gap-3">
                            <div className="flex items-center justify-between gap-3">
                              <p className="text-xs font-semibold tracking-[0.18em] text-slate-500 uppercase">
                                Session runtime
                              </p>
                            </div>
                            <div className="flex flex-wrap gap-2">
                              <Badge className="border-slate-700 bg-slate-900 text-slate-300">
                                Provider:{" "}
                                {getProviderLabel(activeSession.provider)}
                              </Badge>
                              <Badge className="border-slate-700 bg-slate-900 text-slate-300">
                                Model: {activeSession.model}
                              </Badge>
                            </div>
                          </div>

                          <div className="grid gap-3">
                            <div className="flex items-center justify-between gap-3">
                              <p className="text-xs font-semibold tracking-[0.18em] text-slate-500 uppercase">
                                Runtime Snapshot
                              </p>
                              {runtimeLoading ? (
                                <span className="text-[11px] font-medium tracking-wide text-slate-500 uppercase">
                                  Refreshing…
                                </span>
                              ) : null}
                            </div>

                            {runtimeSnapshot ? (
                              <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-3">
                                <div className="flex flex-wrap gap-2">
                                  <Badge className="border-slate-700 bg-slate-950 text-slate-300">
                                    Mode: {runtimeSnapshot.mode}
                                  </Badge>
                                  <Badge className="border-slate-700 bg-slate-950 text-slate-300">
                                    Tools:{" "}
                                    {runtimeSnapshot.enabledTools.join(", ")}
                                  </Badge>
                                  <Badge className="border-slate-700 bg-slate-950 text-slate-300">
                                    {runtimeSnapshot.provider}
                                  </Badge>
                                  <Badge className="border-slate-700 bg-slate-950 text-slate-300">
                                    {runtimeSnapshot.model}
                                  </Badge>
                                  <Badge
                                    className={cn(
                                      "border text-slate-100",
                                      runtimeSnapshot.webSearch
                                        .activeProvider !== "none" &&
                                        runtimeSnapshot.webSearch.providerAvailability.some(
                                          (entry) =>
                                            entry.provider ===
                                              runtimeSnapshot.webSearch
                                                .activeProvider &&
                                            entry.configured,
                                        )
                                        ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-200"
                                        : "border-slate-700 bg-slate-950 text-slate-300",
                                    )}
                                  >
                                    Web search:{" "}
                                    {runtimeSnapshot.webSearch
                                      .activeProvider !== "none" &&
                                    runtimeSnapshot.webSearch.providerAvailability.some(
                                      (entry) =>
                                        entry.provider ===
                                          runtimeSnapshot.webSearch
                                            .activeProvider && entry.configured,
                                    )
                                      ? getWebSearchProviderLabel(
                                          runtimeSnapshot.webSearch
                                            .activeProvider,
                                        )
                                      : "Hidden"}
                                  </Badge>
                                  {runtimeSnapshot.activeProfile ? (
                                    <Badge className="border-slate-700 bg-slate-950 text-slate-300">
                                      Profile: {runtimeSnapshot.activeProfile}
                                    </Badge>
                                  ) : null}
                                  {runtimeSnapshot.offline ? (
                                    <Badge className="border-amber-500/20 bg-amber-500/10 text-amber-200">
                                      Offline
                                    </Badge>
                                  ) : null}
                                  {runtimeSnapshot.compatibility
                                    .discoverGithubCustomizations ? (
                                    <Badge className="border-violet-500/20 bg-violet-500/10 text-violet-200">
                                      GitHub compatibility
                                    </Badge>
                                  ) : null}
                                </div>
                              </div>
                            ) : runtimeError ? (
                              <p className="text-sm leading-6 text-amber-200">
                                {runtimeError}
                              </p>
                            ) : (
                              <p className="text-sm leading-6 text-slate-500">
                                Runtime metadata falls back to your home folder
                                until you choose a workspace.
                              </p>
                            )}
                          </div>
                        </div>
                      </PopoverContent>
                    </Popover>

                    <Button
                      type="button"
                      variant="outline"
                      onClick={createNewSession}
                      className="h-10 rounded-2xl border-slate-800 bg-slate-950 hover:bg-slate-900 hover:text-slate-100"
                    >
                      <Plus className="h-4 w-4" />
                      New session
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label="Rename session"
                      onClick={() => {
                        setRenameValue(currentSessionTitle);
                        setIsRenamingSession(true);
                      }}
                      className="h-10 w-10 rounded-2xl text-slate-400 hover:bg-slate-900 hover:text-slate-100"
                    >
                      <PencilLine className="h-4 w-4" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label="Delete session"
                      onClick={() => deleteSession(activeSession.id)}
                      className="h-10 w-10 rounded-2xl text-slate-400 hover:bg-rose-500/10 hover:text-rose-200"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </header>

                <ScrollArea
                  className="min-h-0 flex-1 px-5 lg:px-8"
                  type="always"
                >
                  {visibleMessages.length === 0 ? (
                    <div className="mx-auto flex min-h-full max-w-2xl flex-col items-center justify-center py-16">
                      <div className="flex flex-col items-center gap-6 text-center">
                        <div className="flex h-16 w-16 items-center justify-center rounded-3xl bg-sky-500/10 text-sky-300">
                          <WandSparkles className="h-8 w-8" />
                        </div>
                        <div className="grid gap-2">
                          <h2 className="text-xl font-medium text-white">
                            Ready to automate
                          </h2>
                          <p className="mx-auto max-w-sm text-sm leading-6 text-slate-400">
                            Pick a workspace anytime, or start from your home
                            folder.
                          </p>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="mx-auto flex max-w-5xl flex-col gap-6 py-8 pr-4 lg:pr-6">
                      {visibleMessages.map((message) => {
                        const renderedContent =
                          getRenderedMessageContent(message);

                        return (
                          <div
                            key={message.id}
                            className={cn(
                              "flex gap-4",
                              message.role === "user"
                                ? "flex-row-reverse"
                                : "flex-row",
                            )}
                          >
                            <Avatar
                              className={cn(
                                "mt-1 h-10 w-10 shrink-0 border",
                                message.role === "agent"
                                  ? "border-sky-500/20 bg-sky-500/10"
                                  : "border-emerald-500/20 bg-emerald-500/20",
                              )}
                            >
                              <div className="flex h-full w-full items-center justify-center">
                                {message.role === "agent" ? (
                                  <Bot className="h-5 w-5 text-sky-300" />
                                ) : (
                                  <User className="h-5 w-5 text-emerald-100" />
                                )}
                              </div>
                            </Avatar>

                            <div
                              className={cn(
                                "flex min-w-0 flex-1 flex-col gap-3",
                                message.role === "user"
                                  ? "items-end"
                                  : "items-start",
                              )}
                            >
                              {message.source?.kind === "execution" ? (
                                <div className="w-full pt-1 lg:max-w-4xl">
                                  <TaskThinkingPanel
                                    thinking={createExecutionThinkingTrace(
                                      message.source.execution,
                                    )}
                                  />
                                </div>
                              ) : null}

                              <div
                                className={cn(
                                  "max-w-[90%] rounded-[1.75rem] px-5 py-4 text-sm leading-7 shadow-lg",
                                  message.role === "user"
                                    ? "rounded-tr-md bg-slate-800 text-slate-100 shadow-slate-950/20"
                                    : "rounded-tl-sm border border-slate-800 bg-slate-900/80 text-slate-300 shadow-slate-950/30",
                                )}
                              >
                                {message.role === "agent" ? (
                                  <MessageMarkdown content={renderedContent} />
                                ) : (
                                  <div className="whitespace-pre-wrap">
                                    {renderedContent}
                                  </div>
                                )}
                              </div>

                              {message.source?.kind === "execution" ? (
                                <ExecutionInsightRow
                                  execution={message.source.execution}
                                  onOpenWorkspaceFile={handleOpenWorkspaceFile}
                                />
                              ) : null}

                              {message.source?.kind === "preview" ? (
                                <div className="w-full pt-1 lg:max-w-4xl">
                                  <TaskPanel source={message.source} />
                                </div>
                              ) : null}
                            </div>
                          </div>
                        );
                      })}
                      <div ref={bottomRef} className="h-6 shrink-0" />
                    </div>
                  )}
                </ScrollArea>

                <footer className="border-t border-slate-900 bg-slate-950/80 px-5 py-5 backdrop-blur-xl lg:px-8">
                  <div className="mx-auto max-w-5xl">
                    <div className="rounded-[1.75rem] border border-slate-800/80 bg-slate-950/75 p-3 shadow-[0_18px_48px_rgba(2,6,23,0.42)]">
                      <div className="flex flex-wrap items-center gap-2 border-b border-slate-900/80 pb-3">
                        <Popover>
                          <PopoverTrigger asChild>
                            <Button
                              type="button"
                              variant="outline"
                              disabled={chooserProviders.length === 0}
                              className="h-8 rounded-full border-slate-800 bg-slate-950/70 px-3 text-xs font-medium text-slate-300 shadow-none hover:bg-slate-900 hover:text-slate-100 disabled:opacity-50"
                            >
                              <Bot className="mr-2 h-3.5 w-3.5 text-slate-500" />
                              {getProviderLabel(activeSession.provider)} ·{" "}
                              {activeSession.model}
                            </Button>
                          </PopoverTrigger>
                          <PopoverContent
                            align="start"
                            className="w-120 rounded-3xl border-slate-800 bg-slate-950/95 p-5 backdrop-blur-xl shadow-2xl"
                          >
                            <div className="grid gap-4">
                              <div className="grid gap-1">
                                <p className="text-xs font-semibold tracking-[0.18em] text-slate-500 uppercase">
                                  Session model
                                </p>
                                <p className="text-sm leading-6 text-slate-400">
                                  Each session keeps its own model, and new
                                  sessions reuse the last model you selected.
                                </p>
                              </div>

                              {chooserProviders.map((provider) => (
                                <div key={provider} className="grid gap-2">
                                  <div className="flex items-center justify-between gap-3">
                                    <p className="text-sm font-semibold text-slate-100">
                                      {getProviderLabel(provider)}
                                    </p>
                                    {activeSession.provider === provider ? (
                                      <Badge className="border-sky-500/20 bg-sky-500/10 text-sky-200">
                                        Current provider
                                      </Badge>
                                    ) : null}
                                  </div>

                                  <div className="flex flex-wrap gap-2">
                                    {getCatalogModelsForProvider(provider).map(
                                      (model) => (
                                        <button
                                          key={`${provider}-${model.id}`}
                                          type="button"
                                          onClick={() =>
                                            handleSessionModelSelection(
                                              provider,
                                              model.id,
                                            )
                                          }
                                          className={cn(
                                            "rounded-full border px-3 py-1.5 text-left text-xs transition-all",
                                            activeSession.provider ===
                                              provider &&
                                              activeSession.model === model.id
                                              ? "border-sky-500/30 bg-sky-500/12 text-sky-100"
                                              : "border-slate-800 bg-slate-900 text-slate-400 hover:border-slate-700 hover:text-slate-200",
                                          )}
                                        >
                                          <span className="font-semibold">
                                            {model.label}
                                          </span>
                                          <span
                                            className={cn(
                                              "ml-2 rounded-full border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                                              MODEL_STAGE_CLASSES[model.stage],
                                            )}
                                          >
                                            {MODEL_STAGE_LABELS[model.stage]}
                                          </span>
                                        </button>
                                      ),
                                    )}
                                  </div>
                                </div>
                              ))}
                            </div>
                          </PopoverContent>
                        </Popover>

                        <Button
                          type="button"
                          variant="outline"
                          onClick={handleSelectFolder}
                          className={cn(
                            "h-8 rounded-full border-slate-800 bg-slate-950/70 px-3 text-xs font-medium text-slate-300 shadow-none hover:bg-slate-900 hover:text-slate-100",
                            hasActiveWorkspace &&
                              "border-sky-500/20 bg-sky-500/10 text-sky-100 hover:bg-sky-500/15",
                          )}
                        >
                          <FolderOpen
                            className={cn(
                              "mr-2 h-3.5 w-3.5",
                              hasActiveWorkspace
                                ? "text-sky-300"
                                : "text-slate-500",
                            )}
                          />
                          {composerWorkspaceLabel}
                        </Button>

                        <MemoryShortcutButton
                          label="Session memory"
                          description={sessionMemoryDescription}
                          pressed={activeSession.sessionMemoryEnabled}
                          onClick={() =>
                            handleSessionMemoryEnabledChange(
                              !activeSession.sessionMemoryEnabled,
                            )
                          }
                          icon={<Brain className="h-4 w-4" />}
                          className={cn(
                            activeSession.sessionMemoryEnabled
                              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-100 hover:bg-emerald-500/15 hover:text-white"
                              : undefined,
                          )}
                        />

                        <MemoryShortcutButton
                          label="Global memory"
                          description={globalMemoryDescription}
                          pressed={isGlobalMemoryActive}
                          disabled={!isGlobalMemoryAvailable}
                          onClick={() =>
                            handleUseGlobalMemoryChange(
                              !activeSession.useGlobalMemory,
                            )
                          }
                          icon={<BrainCircuit className="h-4 w-4" />}
                          className={cn(
                            isGlobalMemoryAvailable && isGlobalMemoryActive
                              ? "border-sky-500/30 bg-sky-500/10 text-sky-100 hover:bg-sky-500/15 hover:text-white"
                              : isGlobalMemoryAvailable
                                ? undefined
                                : "border-dashed border-slate-800 bg-slate-950/40 text-slate-600 hover:bg-slate-950/40 hover:text-slate-600",
                          )}
                        />
                      </div>

                      <form
                        className="mt-3 flex items-end gap-3"
                        onSubmit={(event) => {
                          event.preventDefault();
                          handleSend();
                        }}
                      >
                        <Textarea
                          aria-label="Task composer"
                          value={activeSession.draft}
                          onChange={(event) =>
                            handleDraftChange(event.target.value)
                          }
                          onKeyDown={(event) => {
                            if (event.key === "Enter" && !event.shiftKey) {
                              event.preventDefault();
                              if (canSendMessage) {
                                handleSend();
                              }
                            } else {
                              handleComposerHistoryNavigation(event);
                            }
                          }}
                          placeholder={"What should machdoch do next?"}
                          className="min-h-14 max-h-[30vh] resize-none overflow-y-auto rounded-[1.4rem] border-slate-800 bg-slate-900/70 px-5 py-4 text-base text-slate-100 shadow-inner shadow-black/20 placeholder:text-slate-500 focus-visible:ring-1 focus-visible:ring-sky-500 disabled:cursor-not-allowed disabled:bg-slate-900/50 disabled:text-slate-500 disabled:opacity-100"
                        />

                        <Button
                          type="submit"
                          variant="outline"
                          size="icon"
                          aria-label="Send message"
                          disabled={!canSendMessage}
                          className={cn(
                            "h-11 w-11 rounded-[1.15rem] border-slate-800 bg-slate-900 text-slate-400 shadow-none hover:bg-slate-800 hover:text-slate-100 disabled:border-slate-800 disabled:bg-slate-900 disabled:text-slate-600 disabled:opacity-100",
                            canSendMessage &&
                              "border-sky-500/20 bg-sky-500/10 text-sky-100 hover:bg-sky-500/15 hover:text-white",
                          )}
                        >
                          <SendHorizonal className="h-4 w-4" />
                        </Button>
                      </form>
                    </div>
                  </div>
                </footer>
              </main>
            )}
          </div>
        </div>

        <DialogContent className="max-h-[85vh] max-w-2xl overflow-hidden rounded-3xl border-slate-800 bg-slate-950/96 p-0 text-slate-100 shadow-2xl">
          <div className="flex max-h-[85vh] flex-col overflow-hidden">
            <DialogHeader className="border-b border-slate-800 px-6 py-5 text-left">
              <DialogTitle className="text-xl font-semibold text-white">
                Settings
              </DialogTitle>
              <DialogDescription className="text-sm leading-6 text-slate-400">
                Provider API keys, web search connectors, and memory controls.
              </DialogDescription>
            </DialogHeader>

            <div className="border-b border-slate-800 px-6 py-4">
              <div className="flex flex-wrap gap-2">
                {SETTINGS_SECTIONS.map((section) => (
                  <Button
                    key={section.id}
                    type="button"
                    variant="outline"
                    onClick={() => setSettingsSection(section.id)}
                    className={cn(
                      "h-9 rounded-full border-slate-800 bg-slate-950 px-3 text-xs text-slate-300 hover:bg-slate-900 hover:text-slate-100",
                      settingsSection === section.id &&
                        "border-sky-500/30 bg-sky-500/10 text-sky-100",
                    )}
                  >
                    {section.label}
                  </Button>
                ))}
              </div>
            </div>

            <ScrollArea className="min-h-0 flex-1" type="always">
              <div className="grid gap-6 px-6 py-6 pr-8">
                {settingsSection === "providers" ? (
                  <div className="grid gap-4 rounded-2xl border border-slate-800 bg-slate-900/70 p-4">
                    <div className="grid gap-1">
                      <p className="text-sm font-semibold text-slate-100">
                        Model providers
                      </p>
                      <p className="text-sm leading-6 text-slate-400">
                        Save the API keys the desktop shell can reuse for model
                        access.
                      </p>
                    </div>

                    <div className="flex flex-wrap gap-2">
                      {USER_API_KEY_PROVIDER_ORDER.map((provider) => (
                        <Button
                          key={provider}
                          type="button"
                          variant="outline"
                          onClick={() => {
                            setProviderSetupProvider(provider);
                            setProviderSetupMessage(null);
                          }}
                          className={cn(
                            "h-9 rounded-full border-slate-800 bg-slate-950 px-3 text-xs text-slate-300 hover:bg-slate-900 hover:text-slate-100",
                            providerSetupProvider === provider &&
                              "border-sky-500/30 bg-sky-500/10 text-sky-100",
                          )}
                        >
                          {getProviderLabel(provider)}
                        </Button>
                      ))}
                    </div>

                    <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
                      <Input
                        type="text"
                        value={providerSetupKey}
                        onChange={(event) => {
                          const nextKey = event.target.value;

                          setProviderSetupKey(nextKey);
                          setProviderSetupKeys((prev) => ({
                            ...prev,
                            [providerSetupProvider]: nextKey,
                          }));

                          if (providerSetupMessage) {
                            setProviderSetupMessage(null);
                          }
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            void handleProviderSetupSave();
                          }
                        }}
                        placeholder={`Paste your ${getProviderLabel(providerSetupProvider)} API key`}
                        autoComplete="off"
                        spellCheck={false}
                        className="h-11 rounded-2xl border-slate-800 bg-slate-950 text-slate-100 placeholder:text-slate-500"
                      />
                      <Button
                        type="button"
                        onClick={() => {
                          void handleProviderSetupSave();
                        }}
                        disabled={
                          !providerSetupKey.trim() || providerSetupSaving
                        }
                        className="h-11 rounded-2xl bg-sky-600 px-5 text-white hover:bg-sky-500 disabled:opacity-50"
                      >
                        {providerSetupSaving ? "Saving…" : "Save key"}
                      </Button>
                    </div>

                    {providerSetupMessage ? (
                      <p
                        className={cn(
                          "text-xs leading-6",
                          providerSetupMessage.tone === "error"
                            ? "text-rose-300"
                            : "text-emerald-300",
                        )}
                      >
                        {providerSetupMessage.text}
                      </p>
                    ) : null}
                  </div>
                ) : null}

                {settingsSection === "web-search" ? (
                  <div className="grid gap-4 rounded-2xl border border-slate-800 bg-slate-900/70 p-4">
                    <div className="grid gap-1">
                      <p className="text-sm font-semibold text-slate-100">
                        Web search
                      </p>
                      <p className="text-sm leading-6 text-slate-400">
                        Choose one active provider at a time. The executor hides
                        web search until the active provider has a configured
                        key.
                      </p>
                    </div>

                    <div className="grid gap-2">
                      <p className="text-xs font-semibold tracking-[0.18em] text-slate-500 uppercase">
                        Active web search provider
                      </p>
                      <div className="flex flex-wrap gap-2">
                        {(
                          ["none", ...USER_WEB_SEARCH_PROVIDER_ORDER] as const
                        ).map((provider) => (
                          <Button
                            key={provider}
                            type="button"
                            variant="outline"
                            onClick={() => {
                              void handleWebSearchActiveProviderSave(provider);
                            }}
                            disabled={webSearchSetupSaving}
                            className={cn(
                              "h-9 rounded-full border-slate-800 bg-slate-950 px-3 text-xs text-slate-300 hover:bg-slate-900 hover:text-slate-100",
                              webSearchActiveProvider === provider &&
                                "border-sky-500/30 bg-sky-500/10 text-sky-100",
                            )}
                          >
                            {getWebSearchProviderLabel(provider)}
                          </Button>
                        ))}
                      </div>
                    </div>

                    <Separator className="bg-slate-800" />

                    <div className="grid gap-2">
                      <p className="text-xs font-semibold tracking-[0.18em] text-slate-500 uppercase">
                        API keys
                      </p>
                      <div className="flex flex-wrap gap-2">
                        {USER_WEB_SEARCH_PROVIDER_ORDER.map((provider) => (
                          <Button
                            key={provider}
                            type="button"
                            variant="outline"
                            onClick={() => {
                              setWebSearchSetupProvider(provider);
                              setWebSearchSetupMessage(null);
                            }}
                            className={cn(
                              "h-9 rounded-full border-slate-800 bg-slate-950 px-3 text-xs text-slate-300 hover:bg-slate-900 hover:text-slate-100",
                              webSearchSetupProvider === provider &&
                                "border-sky-500/30 bg-sky-500/10 text-sky-100",
                            )}
                          >
                            {getWebSearchProviderLabel(provider)}
                          </Button>
                        ))}
                      </div>
                    </div>

                    <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
                      <Input
                        type="text"
                        value={webSearchSetupKey}
                        onChange={(event) => {
                          const nextKey = event.target.value;

                          setWebSearchSetupKey(nextKey);
                          setWebSearchSetupKeys((prev) => ({
                            ...prev,
                            [webSearchSetupProvider]: nextKey,
                          }));

                          if (webSearchSetupMessage) {
                            setWebSearchSetupMessage(null);
                          }
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            void handleWebSearchSetupSave();
                          }
                        }}
                        placeholder={`Paste your ${getWebSearchProviderLabel(webSearchSetupProvider)} API key`}
                        autoComplete="off"
                        spellCheck={false}
                        className="h-11 rounded-2xl border-slate-800 bg-slate-950 text-slate-100 placeholder:text-slate-500"
                      />
                      <Button
                        type="button"
                        onClick={() => {
                          void handleWebSearchSetupSave();
                        }}
                        disabled={
                          !webSearchSetupKey.trim() || webSearchSetupSaving
                        }
                        className="h-11 rounded-2xl bg-sky-600 px-5 text-white hover:bg-sky-500 disabled:opacity-50"
                      >
                        {webSearchSetupSaving ? "Saving…" : "Save key"}
                      </Button>
                    </div>

                    {webSearchSetupMessage ? (
                      <p
                        className={cn(
                          "text-xs leading-6",
                          webSearchSetupMessage.tone === "error"
                            ? "text-rose-300"
                            : "text-emerald-300",
                        )}
                      >
                        {webSearchSetupMessage.text}
                      </p>
                    ) : null}
                  </div>
                ) : null}

                {settingsSection === "memory" ? (
                  <div className="grid gap-4 rounded-2xl border border-slate-800 bg-slate-900/70 p-4">
                    <div className="grid gap-1">
                      <p className="text-sm font-semibold text-slate-100">
                        Global memory
                      </p>
                      <p className="text-sm leading-6 text-slate-400">
                        Cross-session facts the assistant can reuse later. Keep
                        this off if you want every session to start fresh.
                      </p>
                    </div>

                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        disabled={memorySetupSaving}
                        onClick={() => {
                          void handleGlobalMemoryEnabledSave(true);
                        }}
                        className={cn(
                          "h-9 rounded-full border-slate-800 bg-slate-950 px-3 text-xs text-slate-300 hover:bg-slate-900 hover:text-slate-100",
                          userMemorySettings.globalEnabled &&
                            "border-sky-500/30 bg-sky-500/10 text-sky-100",
                        )}
                      >
                        Enabled
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        disabled={memorySetupSaving}
                        onClick={() => {
                          void handleGlobalMemoryEnabledSave(false);
                        }}
                        className={cn(
                          "h-9 rounded-full border-slate-800 bg-slate-950 px-3 text-xs text-slate-300 hover:bg-slate-900 hover:text-slate-100",
                          !userMemorySettings.globalEnabled &&
                            "border-slate-600 bg-slate-900 text-slate-100",
                        )}
                      >
                        Disabled
                      </Button>
                      <Badge className="border-slate-700 bg-slate-950 text-slate-300">
                        {userMemorySettings.entries.length} saved fact
                        {userMemorySettings.entries.length === 1 ? "" : "s"}
                      </Badge>
                    </div>

                    {userMemorySettings.entries.length === 0 ? (
                      <p className="text-sm leading-6 text-slate-500">
                        No global memories have been saved yet.
                      </p>
                    ) : (
                      <div className="grid gap-2">
                        {userMemorySettings.entries.map((entry) => (
                          <div
                            key={entry.id}
                            className="rounded-2xl border border-slate-800 bg-slate-950 px-4 py-3 text-sm leading-6 text-slate-300"
                          >
                            {entry.content}
                          </div>
                        ))}
                      </div>
                    )}

                    {memorySetupMessage ? (
                      <p
                        className={cn(
                          "text-xs leading-6",
                          memorySetupMessage.tone === "error"
                            ? "text-rose-300"
                            : "text-emerald-300",
                        )}
                      >
                        {memorySetupMessage.text}
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </ScrollArea>
          </div>
        </DialogContent>
      </Dialog>
    </TooltipProvider>
  );
};
