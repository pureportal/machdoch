import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import {
    AlertCircle,
    Bot,
    Cog,
    FolderOpen,
    History,
    MessageSquare,
    PencilLine,
    Plus,
    SendHorizonal,
    Sparkles,
    TerminalSquare,
    Trash2,
    User,
    WandSparkles
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
import { Avatar } from "./components/ui/avatar";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "./components/ui/card";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from "./components/ui/dialog";
import { Textarea } from "./components/ui/textarea";

import {
    createInitialShellState,
    createSession,
    createVisibleConversationMessages,
    getSessionTitle,
    normalizeShellState,
    sortSessionsByUpdatedAt,
    type ChatSessionRecord,
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
    createMockExecutionFixture,
    createPreviewFixture,
} from "./preview/fixtures";
import {
    loadGlobalProviderAvailability,
    loadWorkspaceRuntimeSnapshot,
    saveUserProviderApiKey,
    type RuntimeProviderAvailability,
    type RuntimeSnapshot,
} from "./runtime";
import { TaskPanel } from "./task-panel";
import { TaskTimeline } from "./task-timeline";
import {
    createTaskTimelineModel,
    type TaskTimelineMessage,
} from "./task-timeline.model";

type SidebarView = "chat" | "history";

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

export const ChatSession = (): JSX.Element => {
  const initialShellStateRef = useRef<ShellPersistedState>(
    createInitialShellState(),
  );
  const [shellState, setShellState] = useState<ShellPersistedState>(
    initialShellStateRef.current,
  );
  const [hasHydrated, setHasHydrated] = useState(false);
  const [sidebarView, setSidebarView] = useState<SidebarView>("chat");
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [isRenamingSession, setIsRenamingSession] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [runtimeSnapshot, setRuntimeSnapshot] =
    useState<RuntimeSnapshot | null>(null);
  const [runtimeLoading, setRuntimeLoading] = useState(false);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [providerSetupProvider, setProviderSetupProvider] =
    useState<RuntimeProvider>("openai");
  const [providerSetupKey, setProviderSetupKey] = useState("");
  const [providerSetupSaving, setProviderSetupSaving] = useState(false);
  const [providerSetupMessage, setProviderSetupMessage] = useState<{
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

  const timelineItems = useMemo(() => {
    return createTaskTimelineModel(activeSession.messages);
  }, [activeSession.messages]);

  const visibleMessages = useMemo(() => {
    return createVisibleConversationMessages(activeSession.messages);
  }, [activeSession.messages]);

  const sortedSessions = useMemo(() => {
    return sortSessionsByUpdatedAt(shellState.sessions);
  }, [shellState.sessions]);

  const activePromptHistory = useMemo(() => {
    return [...activeSession.promptHistory].reverse();
  }, [activeSession.promptHistory]);

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

  const refreshWorkspaceRuntimeSnapshot = async (
    workspaceRoot: string | null,
  ): Promise<void> => {
    if (!workspaceRoot) {
      setRuntimeSnapshot(null);
      setRuntimeError(null);
      return;
    }

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
    if (!catalogOpen) {
      return;
    }

    setProviderSetupProvider(activeSession.provider);
    setProviderSetupKey("");
    setProviderSetupMessage(null);
  }, [catalogOpen, activeSession.provider]);

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

    if (!activeSession.workspace) {
      setRuntimeSnapshot(null);
      setRuntimeError(null);
      return () => {
        cancelled = true;
      };
    }

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
    source?: TaskTimelineMessage["source"],
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

  const handleSend = (): void => {
    const task = activeSession.draft.trim();

    if (!task) {
      return;
    }

    const taskId = crypto.randomUUID();
    const sessionId = activeSession.id;
    const workspacePath = activeSession.workspace ?? "/mock/workspace/path";
    const selectedProvider = activeSession.provider;
    const selectedModel = activeSession.model;
    const preview = createPreviewFixture(task, {
      provider: selectedProvider,
      model: selectedModel,
    });
    const execution = createMockExecutionFixture(task, workspacePath, {
      provider: selectedProvider,
      model: selectedModel,
    });

    const updatedPromptHistory =
      activeSession.promptHistory.at(-1) === task
        ? activeSession.promptHistory
        : [...activeSession.promptHistory, task].slice(-40);

    updateActiveSession((session) => ({
      ...session,
      draft: "",
      updatedAt: Date.now(),
      messages: [
        ...session.messages,
        {
          id: crypto.randomUUID(),
          taskId,
          role: "user",
          content: task,
          createdAt: Date.now(),
        },
      ],
      promptHistory: updatedPromptHistory,
    }));

    setPromptHistoryIndex(null);
    setDraftBeforeHistory("");

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

    scheduleMessage(() => {
      appendAgentMessage(
        sessionId,
        taskId,
        execution.status === "executed"
          ? "This request maps to the current read-only execution scaffold, so the shell can summarize the resulting state cleanly below."
          : "This request still stays in preview mode, so the shell keeps the outcome explicit instead of pretending the task ran live.",
        {
          kind: "execution",
          execution,
        },
      );
    }, 700);
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

    void getCurrentWindow()
      .toggleMaximize()
      .catch((error) => {
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

  return (
    <TooltipProvider delayDuration={250}>
      <Dialog open={catalogOpen} onOpenChange={setCatalogOpen}>
        <div className="dark flex h-screen w-full flex-col overflow-hidden rounded-xl border border-slate-800 bg-slate-950 font-sans text-slate-100 antialiased">
          <div className="relative z-50 flex h-10 w-full shrink-0 select-none items-center justify-between border-b border-slate-900 bg-slate-950/90 px-3">
            <div
              data-tauri-drag-region
              className="absolute inset-0 z-0 cursor-default"
            />
            <div className="relative z-10 flex items-center gap-2 pointer-events-none">
              <TerminalSquare className="h-4 w-4 text-sky-500" />
              <span className="text-[11px] font-bold tracking-[0.2em] text-slate-400 uppercase">
                Machdoch
              </span>
            </div>
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

                <nav className="flex flex-col items-center gap-3">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label="Chat"
                        aria-pressed={sidebarView === "chat"}
                        onClick={() => setSidebarView("chat")}
                        className={cn(
                          "h-12 w-12 rounded-2xl text-slate-400 hover:bg-slate-900 hover:text-slate-100",
                          sidebarView === "chat" &&
                            "bg-slate-900 text-slate-100 shadow-inner shadow-slate-950/60",
                        )}
                      >
                        <MessageSquare className="h-5 w-5" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="right">Sessions</TooltipContent>
                  </Tooltip>

                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label="History"
                        aria-pressed={sidebarView === "history"}
                        onClick={() => setSidebarView("history")}
                        className={cn(
                          "h-12 w-12 rounded-2xl text-slate-400 hover:bg-slate-900 hover:text-slate-100",
                          sidebarView === "history" &&
                            "bg-slate-900 text-slate-100 shadow-inner shadow-slate-950/60",
                        )}
                      >
                        <History className="h-5 w-5" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="right">Activity</TooltipContent>
                  </Tooltip>
                </nav>
              </div>

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label="Settings"
                    onClick={() => setCatalogOpen(true)}
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
                    {sidebarView === "chat" ? "Sessions" : "Activity"}
                  </p>
                  <p className="mt-1 text-sm text-slate-400">
                    {sidebarView === "chat"
                      ? `${shellState.sessions.length} saved session${shellState.sessions.length === 1 ? "" : "s"}`
                      : `${timelineItems.length} timeline item${timelineItems.length === 1 ? "" : "s"}`}
                  </p>
                </div>

                {sidebarView === "chat" ? (
                  <Button
                    type="button"
                    size="sm"
                    onClick={createNewSession}
                    className="rounded-xl bg-sky-600 text-white hover:bg-sky-500"
                  >
                    <Plus className="h-4 w-4" />
                    New
                  </Button>
                ) : null}
              </div>

              <ScrollArea className="min-h-0 flex-1" type="always">
                {sidebarView === "chat" ? (
                  <div className="space-y-5 px-5 py-5 pr-7">
                    <Card className="gap-4 rounded-3xl border-slate-800 bg-slate-900/80 text-slate-100 shadow-none">
                      <CardHeader className="gap-2 px-5 py-5 pb-2">
                        <CardTitle className="text-base font-semibold text-slate-100">
                          Conversation memory
                        </CardTitle>
                      </CardHeader>
                      <CardContent className="grid gap-3 px-5 pb-5">
                        {sortedSessions.map((session) => {
                          const isActive = session.id === activeSession.id;

                          return (
                            <button
                              key={session.id}
                              type="button"
                              onClick={() =>
                                applyShellState((prev) => ({
                                  ...prev,
                                  activeSessionId: session.id,
                                }))
                              }
                              className={cn(
                                "grid gap-1 rounded-xl border px-3 py-2.5 text-left transition-all",
                                isActive
                                  ? "border-sky-500/30 bg-sky-500/10 shadow-lg shadow-sky-950/20"
                                  : "border-slate-800 bg-slate-950/70 hover:border-slate-700 hover:bg-slate-950",
                              )}
                            >
                              <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0">
                                  <p className="truncate text-sm font-semibold text-slate-100 placeholder:text-slate-500">
                                    {getSessionTitle(session)}
                                  </p>
                                </div>
                              </div>

                              <div className="flex items-center justify-between mt-1 text-[10px] font-medium tracking-wide text-slate-500 uppercase">
                                <span className="truncate mr-2">
                                  {createSessionSubtitle(session)}
                                </span>
                                <span className="shrink-0">
                                  {formatSessionTimestamp(session.updatedAt)}
                                </span>
                              </div>
                            </button>
                          );
                        })}
                      </CardContent>
                    </Card>
                  </div>
                ) : (
                  <div className="space-y-5 px-5 py-5 pr-7">
                    <Card className="gap-4 rounded-3xl border-slate-800 bg-slate-900/80 text-slate-100 shadow-none">
                      <CardHeader className="gap-2 px-5 py-5">
                        <CardTitle className="text-base font-semibold text-slate-100">
                          Task activity timeline
                        </CardTitle>
                        <CardDescription className="text-sm leading-6 text-slate-400">
                          Preview, execution state, and approval checkpoints for
                          the active session.
                        </CardDescription>
                      </CardHeader>
                      <CardContent className="px-5 pb-5">
                        <TaskTimeline items={timelineItems} />
                      </CardContent>
                    </Card>

                    <Card className="gap-4 rounded-3xl border-slate-800 bg-slate-900/80 text-slate-100 shadow-none">
                      <CardHeader className="gap-2 px-5 py-5">
                        <CardTitle className="text-base font-semibold text-slate-100">
                          Prompt history
                        </CardTitle>
                        <CardDescription className="text-sm leading-6 text-slate-400">
                          Use ArrowUp and ArrowDown inside the composer to cycle
                          through earlier prompts in this session.
                        </CardDescription>
                      </CardHeader>
                      <CardContent className="grid gap-2 px-5 pb-5">
                        {activePromptHistory.length === 0 ? (
                          <p className="text-sm leading-6 text-slate-500">
                            Send a prompt to start building command-style
                            history.
                          </p>
                        ) : (
                          activePromptHistory.map((prompt, index) => (
                            <button
                              key={`${prompt}-${index}`}
                              type="button"
                              onClick={() => handleDraftChange(prompt)}
                              className="rounded-2xl border border-slate-800 bg-slate-950 px-4 py-3 text-left text-sm leading-6 text-slate-300 transition-all hover:border-slate-700 hover:bg-slate-900"
                            >
                              {prompt}
                            </button>
                          ))
                        )}
                      </CardContent>
                    </Card>
                  </div>
                )}
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
                  onClick={() => setCatalogOpen(true)}
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
                                Select a workspace to inspect the resolved
                                runtime config.
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
                            Pick a workspace and model to begin your task.
                          </p>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="mx-auto flex max-w-5xl flex-col gap-6 py-8 pr-4 lg:pr-6">
                      {visibleMessages.map((message) => (
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
                            <div
                              className={cn(
                                "max-w-[90%] rounded-[1.75rem] px-5 py-4 text-sm leading-7 shadow-lg",
                                message.role === "user"
                                  ? "rounded-tr-md bg-slate-800 text-slate-100 shadow-slate-950/20"
                                  : "rounded-tl-md border border-slate-800 bg-slate-900/80 text-slate-300 shadow-slate-950/30",
                              )}
                            >
                              {message.content}
                            </div>

                            {message.source ? (
                              <div className="w-full pt-1 lg:max-w-4xl">
                                <TaskPanel source={message.source} />
                              </div>
                            ) : null}
                          </div>
                        </div>
                      ))}
                      <div ref={bottomRef} className="h-2" />
                    </div>
                  )}
                </ScrollArea>

                <footer className="border-t border-slate-900 bg-slate-950/80 px-5 py-5 backdrop-blur-xl lg:px-8">
                  <div className="mx-auto grid max-w-5xl gap-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <Popover>
                        <PopoverTrigger asChild>
                          <Button
                            type="button"
                            variant="outline"
                            disabled={chooserProviders.length === 0}
                            className="h-9 rounded-full border-slate-800 bg-slate-900 px-3 text-slate-200 hover:bg-slate-800 hover:text-slate-100 disabled:opacity-50"
                          >
                            <Sparkles className="mr-2 h-4 w-4" />
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
                                          activeSession.provider === provider &&
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

                      <span className="text-xs text-slate-500">
                        Only configured providers are shown here.
                      </span>
                    </div>

                    <form
                      className="relative flex items-center gap-3"
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
                            if (
                              activeSession.workspace &&
                              activeSession.draft.trim()
                            ) {
                              handleSend();
                            }
                          } else {
                            handleComposerHistoryNavigation(event);
                          }
                        }}
                        placeholder={
                          activeSession.workspace
                            ? "What should machdoch do next?"
                            : "Select a workspace to start"
                        }
                        disabled={!activeSession.workspace}
                        className="min-h-14 max-h-[30vh] resize-none overflow-y-auto rounded-[1.4rem] border-slate-800 bg-slate-900 pl-5 pr-16 py-4 text-base text-slate-100 shadow-inner placeholder:text-slate-500 focus-visible:ring-1 focus-visible:ring-sky-500 disabled:cursor-not-allowed disabled:opacity-60"
                      />

                      <Button
                        type="submit"
                        size="icon"
                        aria-label="Send message"
                        disabled={
                          !activeSession.workspace ||
                          !activeSession.draft.trim()
                        }
                        className="absolute right-2 h-10 w-10 rounded-2xl bg-sky-600 text-white hover:bg-sky-500 disabled:opacity-30"
                      >
                        <SendHorizonal className="h-4 w-4" />
                      </Button>
                    </form>
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
                Provider API keys.
              </DialogDescription>
            </DialogHeader>

            <ScrollArea className="min-h-0 flex-1" type="always">
              <div className="grid gap-6 px-6 py-6 pr-8">
                <div className="grid gap-4 rounded-2xl border border-slate-800 bg-slate-900/70 p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    {SUPPORTED_PROVIDER_ORDER.map((provider) => {
                      const configured =
                        runtimeProviderLookup.get(provider) ?? false;

                      return (
                        <Badge
                          key={provider}
                          className={cn(
                            "border px-3 py-1 text-xs",
                            configured
                              ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-200"
                              : "border-slate-700 bg-slate-950 text-slate-400",
                          )}
                        >
                          {getProviderLabel(provider)}
                        </Badge>
                      );
                    })}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {SUPPORTED_PROVIDER_ORDER.map((provider) => (
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
                      type="password"
                      value={providerSetupKey}
                      onChange={(event) => {
                        setProviderSetupKey(event.target.value);
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
                      disabled={!providerSetupKey.trim() || providerSetupSaving}
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
              </div>
            </ScrollArea>
          </div>
        </DialogContent>
      </Dialog>
    </TooltipProvider>
  );
};
