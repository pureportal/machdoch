import {
  Activity,
  AlertTriangle,
  BrainCircuit,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock3,
  Copy,
  FileJson,
  Hammer,
  LoaderCircle,
  RotateCcw,
  ShieldCheck,
  TerminalSquare,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type JSX } from "react";
import { createTaskTimeoutIndicator } from "./_helpers/task-timeout-indicator.helper";
import { Card, CardContent, CardHeader, CardTitle } from "./components/ui/card";
import { cn } from "./lib/utils";
import type { TaskPanelTone } from "./task-panel";
import type {
  TaskThinkingModelStream,
  TaskThinkingTimelineEvent,
  TaskThinkingTrace,
} from "./task-thinking.model";

const entryToneLabelClasses: Record<TaskPanelTone, string> = {
  neutral: "text-slate-200",
  info: "text-sky-200",
  success: "text-emerald-200",
  warning: "text-amber-200",
  danger: "text-rose-200",
};

const timelineToneBorderClasses: Record<TaskPanelTone, string> = {
  neutral: "border-slate-700/70",
  info: "border-sky-500/35",
  success: "border-emerald-500/35",
  warning: "border-amber-500/35",
  danger: "border-rose-500/35",
};

const outputLineClasses = {
  stdout: "border-emerald-500/20 text-emerald-100",
  stderr: "border-amber-500/20 text-amber-100",
};

type VisibleModelStreamKind = Exclude<
  TaskThinkingModelStream["kind"],
  "assistant"
>;
type VisibleModelStream = TaskThinkingModelStream & {
  kind: VisibleModelStreamKind;
};

type PanelView = "timeline" | "streams" | "replay";

const modelStreamPanelCopy: Record<
  VisibleModelStreamKind,
  { title: string; badge: string }
> = {
  "tool-call": {
    title: "Live tool input",
    badge: "ready",
  },
  reasoning: {
    title: "Live reasoning",
    badge: "done",
  },
  status: {
    title: "Provider status",
    badge: "done",
  },
  "tool-result": {
    title: "Tool result",
    badge: "sent",
  },
};

const timelineIcons: Record<TaskThinkingTimelineEvent["kind"], LucideIcon> = {
  state: Activity,
  "model-call": BrainCircuit,
  "tool-call": Hammer,
  retry: RotateCcw,
  validator: ShieldCheck,
  output: TerminalSquare,
};

const formatElapsedTime = (elapsedMs: number | undefined): string => {
  const safeElapsedMs =
    typeof elapsedMs === "number" && Number.isFinite(elapsedMs)
      ? Math.max(0, Math.round(elapsedMs))
      : 0;

  if (safeElapsedMs < 1_000) {
    return `${safeElapsedMs}ms`;
  }

  if (safeElapsedMs < 60_000) {
    return `${(safeElapsedMs / 1_000).toFixed(safeElapsedMs < 10_000 ? 1 : 0)}s`;
  }

  const minutes = Math.floor(safeElapsedMs / 60_000);
  const seconds = Math.floor((safeElapsedMs % 60_000) / 1_000);

  return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
};

const formatTokenUsage = (
  usage: TaskThinkingTrace["tokenUsage"] | TaskThinkingTimelineEvent["tokenUsage"],
): string => {
  if (!usage) {
    return "0 tokens";
  }

  const parts = [
    usage.inputTokens !== undefined ? `${usage.inputTokens} in` : undefined,
    usage.outputTokens !== undefined ? `${usage.outputTokens} out` : undefined,
    usage.totalTokens !== undefined ? `${usage.totalTokens} total` : undefined,
    usage.cachedInputTokens !== undefined
      ? `${usage.cachedInputTokens} cached`
      : undefined,
    usage.reasoningTokens !== undefined
      ? `${usage.reasoningTokens} reasoning`
      : undefined,
  ].filter((part): part is string => part !== undefined);

  return parts.length > 0 ? parts.join(" / ") : "0 tokens";
};

const formatMetadataKey = (value: string): string => {
  return value
    .replace(/([a-z])([A-Z])/gu, "$1 $2")
    .replace(/[_-]+/gu, " ")
    .toLowerCase();
};

const createIsoTimestamp = (value: number | undefined): string | undefined => {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }

  return new Date(value).toISOString();
};

const createReplayExport = (
  thinking: TaskThinkingTrace,
  timelineEvents: TaskThinkingTimelineEvent[],
): string => {
  const completedAt =
    thinking.status === "complete" ? thinking.completedAt : undefined;
  const latestEventAt = timelineEvents.at(-1)?.timestamp;
  const elapsedAt = completedAt ?? latestEventAt;
  const elapsedMs =
    elapsedAt !== undefined && thinking.startedAt
      ? elapsedAt - thinking.startedAt
      : 0;

  return JSON.stringify(
    {
      schema: "machdoch.execution-replay.v1",
      task: {
        text: thinking.task ?? "",
        mode: thinking.mode,
      },
      run: {
        status: thinking.status,
        startedAt: createIsoTimestamp(thinking.startedAt),
        completedAt: createIsoTimestamp(completedAt) ?? null,
        lastEventAt: createIsoTimestamp(latestEventAt) ?? null,
        elapsedMs: Math.max(0, elapsedMs),
      },
      usage: thinking.tokenUsage ?? null,
      timeline: timelineEvents.map((event) => ({
        kind: event.kind,
        phase: event.phase,
        label: event.label,
        detail: event.detail,
        elapsedMs: event.elapsedMs,
        timestamp: createIsoTimestamp(event.timestamp),
        provider: event.provider,
        model: event.model,
        toolName: event.toolName,
        callId: event.callId,
        stream: event.stream,
        tokenUsage: event.tokenUsage,
        metadata: event.metadata,
      })),
      streams: {
        assistantText: thinking.assistantText ?? "",
        modelStream: thinking.modelStream ?? null,
        actionOutputLines: thinking.actionOutputLines ?? [],
      },
    },
    null,
    2,
  );
};

const createLegacyTimelineEvents = (
  thinking: TaskThinkingTrace,
): TaskThinkingTimelineEvent[] => {
  const startedAt = thinking.startedAt ?? thinking.entries[0]?.timestamp ?? 0;

  return thinking.entries.map((entry, index) => ({
    id: `legacy-${entry.id}`,
    kind: "state",
    phase: index === thinking.entries.length - 1 ? "completed" : "started",
    label: entry.label,
    detail: entry.detail,
    tone: entry.tone,
    timestamp: entry.timestamp,
    elapsedMs: Math.max(0, entry.timestamp - startedAt),
  }));
};

const createUniqueRenderKeys = (
  entries: readonly { id: string }[],
): string[] => {
  const occurrences = new Map<string, number>();

  return entries.map((entry) => {
    const occurrence = occurrences.get(entry.id) ?? 0;
    occurrences.set(entry.id, occurrence + 1);

    return occurrence === 0
      ? entry.id
      : `${entry.id}\0duplicate-${occurrence}`;
  });
};

export interface TaskThinkingPanelProps {
  thinking: TaskThinkingTrace;
}

/**
 * Fixed-height execution timeline that shows live agent progress before the
 * final assistant response is rendered.
 */
export const TaskThinkingPanel = ({
  thinking,
}: TaskThinkingPanelProps): JSX.Element => {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const entries = thinking.entries;
  const latestEntry = entries.at(-1);
  const isRunning = thinking.status === "running";
  const statusTone: TaskPanelTone = latestEntry?.tone ?? "neutral";
  const assistantText = thinking.assistantText?.trim();
  const modelStream = thinking.modelStream;
  const actionOutputLines = thinking.actionOutputLines ?? [];
  const timelineEvents = useMemo(
    () =>
      thinking.timelineEvents && thinking.timelineEvents.length > 0
        ? thinking.timelineEvents
        : createLegacyTimelineEvents(thinking),
    [thinking.entries, thinking.startedAt, thinking.timelineEvents],
  );
  const timelineEventKeys = useMemo(
    () => createUniqueRenderKeys(timelineEvents),
    [timelineEvents],
  );
  const actionOutputLineKeys = useMemo(
    () => createUniqueRenderKeys(actionOutputLines),
    [actionOutputLines],
  );
  const latestTimelineEvent = timelineEvents.at(-1);
  const visibleModelStream: VisibleModelStream | undefined =
    modelStream && modelStream.kind !== "assistant"
      ? (modelStream as VisibleModelStream)
      : undefined;
  const [currentTimeMs, setCurrentTimeMs] = useState(() => Date.now());
  const elapsedMs = Math.max(
    0,
    (isRunning
      ? currentTimeMs
      : thinking.completedAt ?? latestTimelineEvent?.timestamp ?? thinking.startedAt) -
      thinking.startedAt,
  );
  const timeoutIndicator = isRunning
    ? createTaskTimeoutIndicator(thinking.timeout, currentTimeMs)
    : undefined;
  const timeoutProgressFillClassName =
    (timeoutIndicator?.progress ?? 0) >= 0.9
      ? "bg-rose-300/70"
      : (timeoutIndicator?.progress ?? 0) >= 0.75
        ? "bg-amber-300/75"
        : "bg-sky-400/70";
  const timeoutValueText = timeoutIndicator
    ? timeoutIndicator.kind === "absolute"
      ? `${formatElapsedTime(timeoutIndicator.remainingMs)} until the absolute execution timeout`
      : `${formatElapsedTime(timeoutIndicator.remainingMs)} until timeout if no further activity`
    : undefined;
  const [isCollapsed, setIsCollapsed] = useState<boolean>(!isRunning);
  const [activeView, setActiveView] = useState<PanelView>("timeline");
  const replayExport = useMemo(
    () =>
      activeView === "replay"
        ? createReplayExport(thinking, timelineEvents)
        : "",
    [activeView, thinking, timelineEvents],
  );
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle",
  );

  useEffect(() => {
    if (!isRunning) {
      return;
    }

    const node = scrollContainerRef.current;

    if (!node) {
      return;
    }

    node.scrollTop = node.scrollHeight;
  }, [timelineEvents.length, entries.length, activeView, isRunning]);

  useEffect(() => {
    if (!isRunning) {
      return;
    }

    const updateCurrentTime = (): void => {
      setCurrentTimeMs(Date.now());
    };

    updateCurrentTime();

    const intervalId = window.setInterval(updateCurrentTime, 1_000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [isRunning]);

  useEffect(() => {
    setIsCollapsed(!isRunning);
  }, [isRunning]);

  useEffect(() => {
    if (copyState === "idle") {
      return;
    }

    const timeout = window.setTimeout(() => setCopyState("idle"), 1_800);

    return () => window.clearTimeout(timeout);
  }, [copyState]);

  const copyReplayExport = async (): Promise<void> => {
    try {
      if (!navigator.clipboard) {
        throw new Error("Clipboard API unavailable.");
      }

      await navigator.clipboard.writeText(replayExport);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  };

  const HeaderIcon = (() => {
    if (isRunning) {
      return LoaderCircle;
    }

    if (statusTone === "warning" || statusTone === "danger") {
      return AlertTriangle;
    }

    return CheckCircle2;
  })();

  const ToggleIcon = isCollapsed ? ChevronRight : ChevronDown;

  return (
    <div aria-live="polite" className="app-thinking-panel min-h-0 min-w-0 w-full">
      <Card
        className={cn(
          "app-thinking-card relative min-w-0 gap-0 overflow-hidden border py-0 text-slate-100",
          isCollapsed
            ? "w-full rounded-2xl rounded-bl-sm border-slate-800/60 bg-slate-900/28 shadow-none"
            : "w-full rounded-3xl border-slate-800 bg-slate-900/85 shadow-xl shadow-slate-950/25",
        )}
      >
        <CardHeader
          className={cn(
            "app-thinking-header",
            isCollapsed
              ? "gap-0 px-3 py-1.5"
              : "gap-0 border-b border-slate-800/90 px-4 py-2.5",
          )}
        >
          <div
            className={cn(
              "flex gap-3",
              isCollapsed ? "items-center gap-2" : "items-center gap-2.5",
            )}
          >
            <div
              className={cn(
                "app-thinking-main-icon flex items-center justify-center border border-sky-500/20 bg-sky-500/10 text-sky-200",
                isCollapsed ? "h-5 w-5 rounded-md" : "h-8 w-8 rounded-xl",
              )}
            >
              <HeaderIcon
                className={cn(
                  isCollapsed ? "h-2.5 w-2.5" : "h-3.5 w-3.5",
                  isRunning && "animate-spin",
                )}
              />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-3">
                <div
                  className={cn(
                    "min-w-0",
                    !isCollapsed && "flex items-center gap-2.5",
                  )}
                >
                  <CardTitle
                    className={cn(
                      "font-semibold text-slate-100",
                      isCollapsed ? "text-[12px] leading-none" : "text-sm",
                    )}
                  >
                    Execution timeline
                  </CardTitle>
                  {isCollapsed ? (
                    <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[10px] text-slate-500">
                      <Clock3 className="h-2.5 w-2.5" />
                      <span>{formatElapsedTime(elapsedMs)}</span>
                    </div>
                  ) : (
                    <div className="flex shrink-0 items-center gap-1 text-[11px] font-medium tabular-nums text-slate-400">
                      <Clock3 className="h-3 w-3 text-slate-500" />
                      <span aria-label={`Elapsed time ${formatElapsedTime(elapsedMs)}`}>
                        {formatElapsedTime(elapsedMs)}
                      </span>
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  aria-expanded={!isCollapsed}
                  aria-label={
                    isCollapsed
                      ? "Expand thinking process"
                      : "Collapse thinking process"
                  }
                  onClick={() => setIsCollapsed((value) => !value)}
                  className={cn(
                    "app-thinking-toggle inline-flex items-center gap-1.5 rounded-full border border-slate-800 bg-slate-950/70 font-medium text-slate-300 transition-colors hover:bg-slate-900 hover:text-slate-100",
                    isCollapsed
                      ? "h-5 px-2 text-[10px]"
                      : "h-7 px-2.5 text-[11px]",
                  )}
                >
                  <ToggleIcon
                    className={cn(
                      isCollapsed ? "h-2.5 w-2.5" : "h-3.5 w-3.5",
                    )}
                  />
                  {isCollapsed ? "Details" : "Hide details"}
                </button>
              </div>
            </div>
          </div>
        </CardHeader>

        {!isCollapsed ? (
          <CardContent className="px-0 py-0">
            <div className="flex items-center gap-1 border-b border-slate-800/80 px-5 py-2">
              {(
                [
                  ["timeline", Activity, "Timeline"],
                  ["streams", TerminalSquare, "Streams"],
                  ["replay", FileJson, "Replay"],
                ] as const
              ).map(([view, Icon, label]) => (
                <button
                  key={view}
                  type="button"
                  aria-pressed={activeView === view}
                  onClick={() => setActiveView(view)}
                  className={cn(
                    "inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[11px] font-medium transition-colors",
                    activeView === view
                      ? "bg-sky-500/12 text-sky-100"
                      : "text-slate-400 hover:bg-slate-900/70 hover:text-slate-200",
                  )}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {label}
                </button>
              ))}
            </div>

            {visibleModelStream ? (
              <div className="border-b border-slate-800/80 px-5 py-3">
                <div className="app-thinking-detail-block min-w-0 rounded-xl border border-violet-500/15 bg-violet-500/5 px-3 py-2">
                  <div className="flex min-w-0 items-center justify-between gap-3">
                    <p className="m-0 text-[11px] font-semibold tracking-[0.16em] text-violet-200 uppercase">
                      {modelStreamPanelCopy[visibleModelStream.kind].title}
                    </p>
                    <span className="shrink-0 rounded-full border border-violet-400/20 px-2 py-0.5 text-[10px] text-violet-100">
                      {visibleModelStream.complete
                        ? modelStreamPanelCopy[visibleModelStream.kind].badge
                        : "streaming"}
                    </span>
                  </div>
                  <p className="mt-1 text-xs font-medium text-violet-100 wrap-break-word">
                    {visibleModelStream.label}
                  </p>
                  {visibleModelStream.content.trim() ? (
                    <pre className="app-thinking-code mt-2 max-h-24 max-w-full overflow-auto whitespace-pre-wrap rounded-lg bg-slate-950/80 px-3 py-2 text-xs leading-5 text-slate-300 wrap-break-word">
                      {visibleModelStream.content}
                    </pre>
                  ) : null}
                </div>
              </div>
            ) : null}

            <div
              ref={scrollContainerRef}
              className="app-thinking-scroll h-72 min-w-0 overflow-y-auto px-5 py-4 [scrollbar-gutter:stable]"
            >
              {activeView === "timeline" ? (
                <ol className="app-thinking-entries m-0 grid gap-3 p-0 list-none">
                  {timelineEvents.map((event, index) => {
                    const Icon = timelineIcons[event.kind];
                    const durationMs =
                      typeof event.metadata?.durationMs === "number"
                        ? event.metadata.durationMs
                        : undefined;
                    const metadataEntries = Object.entries(
                      event.metadata ?? {},
                    ).filter(
                      ([key]) =>
                        key !== "durationMs" &&
                        key !== "argumentsPreview" &&
                        key !== "outputPreview",
                    );
                    const previewEntries = [
                      event.metadata?.argumentsPreview
                        ? `arguments: ${event.metadata.argumentsPreview}`
                        : undefined,
                      event.metadata?.outputPreview
                        ? `output: ${event.metadata.outputPreview}`
                        : undefined,
                    ].filter((line): line is string => line !== undefined);
                    const isLastEvent = index === timelineEvents.length - 1;

                    return (
                      <li
                        key={timelineEventKeys[index]}
                        className="app-thinking-entry grid grid-cols-[4.25rem_auto_minmax(0,1fr)] gap-3"
                      >
                        <span className="pt-0.5 text-right font-mono text-[11px] text-slate-500">
                          +{formatElapsedTime(event.elapsedMs)}
                        </span>
                        <div className="flex min-h-full flex-col items-center">
                          <span
                            className={cn(
                              "flex h-6 w-6 items-center justify-center rounded-lg border bg-slate-950/60",
                              timelineToneBorderClasses[event.tone],
                              entryToneLabelClasses[event.tone],
                            )}
                          >
                            <Icon className="h-3.5 w-3.5" />
                          </span>
                          {!isLastEvent ? (
                            <span className="mt-1 min-h-5 w-px flex-1 bg-slate-800/80" />
                          ) : null}
                        </div>

                        <div className="min-w-0 pb-1">
                          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                            <p
                              className={cn(
                                "m-0 text-[11px] font-semibold tracking-[0.14em] uppercase",
                                entryToneLabelClasses[event.tone],
                              )}
                            >
                              {event.label}
                            </p>
                            <span className="rounded-full border border-slate-800 px-1.5 py-0.5 text-[10px] text-slate-400">
                              {event.phase}
                            </span>
                            {durationMs !== undefined ? (
                              <span className="rounded-full border border-slate-800 px-1.5 py-0.5 text-[10px] text-slate-400">
                                {formatElapsedTime(durationMs)}
                              </span>
                            ) : null}
                          </div>
                          {event.detail ? (
                            <p className="app-thinking-entry-detail mt-1 text-sm leading-6 text-slate-300 wrap-break-word">
                              {event.detail}
                            </p>
                          ) : null}
                          {event.tokenUsage ? (
                            <p className="mt-1 text-xs text-sky-200">
                              {formatTokenUsage(event.tokenUsage)}
                            </p>
                          ) : null}
                          {metadataEntries.length > 0 ? (
                            <div className="mt-2 flex flex-wrap gap-1.5">
                              {metadataEntries.map(([key, value]) => (
                                <span
                                  key={key}
                                  className="rounded-md border border-slate-800 bg-slate-950/50 px-1.5 py-0.5 text-[10px] text-slate-400"
                                >
                                  {formatMetadataKey(key)}: {String(value)}
                                </span>
                              ))}
                            </div>
                          ) : null}
                          {previewEntries.length > 0 ? (
                            <pre className="app-thinking-code mt-2 max-h-24 max-w-full overflow-auto whitespace-pre-wrap rounded-lg bg-slate-950/80 px-3 py-2 text-xs leading-5 text-slate-300 wrap-break-word">
                              {previewEntries.join("\n")}
                            </pre>
                          ) : null}
                        </div>
                      </li>
                    );
                  })}
                </ol>
              ) : null}

              {activeView === "streams" ? (
                <>
                  {assistantText ? (
                    <div className="app-thinking-detail-block mb-4 min-w-0 rounded-xl border border-sky-500/15 bg-sky-500/5 px-3 py-2">
                      <p className="m-0 text-[11px] font-semibold tracking-[0.16em] text-sky-200 uppercase">
                        Live response
                      </p>
                      <p className="mt-1 max-h-24 overflow-y-auto whitespace-pre-wrap text-sm leading-6 text-slate-200 wrap-break-word">
                        {assistantText}
                      </p>
                    </div>
                  ) : null}

                  {modelStream && modelStream.kind !== "assistant" ? (
                    <div className="app-thinking-detail-block mb-4 min-w-0 rounded-xl border border-violet-500/15 bg-violet-500/5 px-3 py-2">
                      <div className="flex min-w-0 items-center justify-between gap-3">
                        <p className="m-0 text-[11px] font-semibold tracking-[0.16em] text-violet-200 uppercase">
                          {modelStreamPanelCopy[modelStream.kind].title}
                        </p>
                        <span className="shrink-0 rounded-full border border-violet-400/20 px-2 py-0.5 text-[10px] text-violet-100">
                          {modelStream.complete
                            ? modelStreamPanelCopy[modelStream.kind].badge
                            : "streaming"}
                        </span>
                      </div>
                      <p className="mt-1 text-xs font-medium text-violet-100 wrap-break-word">
                        {modelStream.label}
                      </p>
                      {modelStream.content.trim() ? (
                        <pre className="app-thinking-code mt-2 max-h-24 max-w-full overflow-auto whitespace-pre-wrap rounded-lg bg-slate-950/80 px-3 py-2 text-xs leading-5 text-slate-300 wrap-break-word">
                          {modelStream.content}
                        </pre>
                      ) : null}
                    </div>
                  ) : null}

                  {actionOutputLines.length > 0 ? (
                    <div className="app-thinking-detail-block mb-4 min-w-0 rounded-xl border border-slate-800 bg-slate-950/55 px-3 py-2">
                      <p className="m-0 text-[11px] font-semibold tracking-[0.16em] text-slate-300 uppercase">
                        Stdout / stderr
                      </p>
                      <div className="mt-2 max-h-40 overflow-y-auto font-mono text-[11px] leading-5">
                        {actionOutputLines.map((line, index) => (
                          <div
                            key={actionOutputLineKeys[index]}
                            className={cn(
                              "grid min-w-0 grid-cols-[4.5rem_minmax(0,1fr)] gap-2 border-l-2 pl-2",
                              outputLineClasses[line.stream],
                            )}
                          >
                            <span className="text-slate-500">
                              {line.stream}
                            </span>
                            <span className="min-w-0 break-words">
                              {line.text}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}

                  {!assistantText &&
                  (!modelStream || modelStream.kind === "assistant") &&
                  actionOutputLines.length === 0 ? (
                    <p className="m-0 text-sm text-slate-400">
                      No stream output yet.
                    </p>
                  ) : null}
                </>
              ) : null}

              {activeView === "replay" ? (
                <div className="app-thinking-detail-block min-w-0 rounded-xl border border-slate-800 bg-slate-950/55 px-3 py-2">
                  <div className="flex min-w-0 items-center justify-between gap-3">
                    <p className="m-0 text-[11px] font-semibold tracking-[0.16em] text-slate-300 uppercase">
                      Replay export
                    </p>
                    <button
                      type="button"
                      onClick={() => void copyReplayExport()}
                      className="inline-flex h-7 items-center gap-1.5 rounded-md border border-slate-800 bg-slate-950/70 px-2 text-[11px] font-medium text-slate-300 hover:bg-slate-900 hover:text-slate-100"
                    >
                      <Copy className="h-3.5 w-3.5" />
                      {copyState === "copied"
                        ? "Copied"
                        : copyState === "failed"
                          ? "Copy failed"
                          : "Copy JSON"}
                    </button>
                  </div>
                  <pre className="app-thinking-code mt-2 max-h-56 max-w-full overflow-auto whitespace-pre-wrap rounded-lg bg-slate-950/80 px-3 py-2 text-xs leading-5 text-slate-300 wrap-break-word">
                    {replayExport}
                  </pre>
                </div>
              ) : null}
            </div>
          </CardContent>
        ) : null}
        {timeoutIndicator ? (
          <div
            role="progressbar"
            aria-label="AI chat timeout progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={timeoutIndicator.progressPercent}
            aria-valuetext={timeoutValueText}
            className="app-thinking-timeout-progress pointer-events-none absolute inset-x-0 bottom-0 h-[2px] overflow-hidden bg-slate-800/80"
          >
            <div
              className={cn(
                "h-full transition-[width,background-color] duration-500",
                timeoutProgressFillClassName,
              )}
              style={{ width: `${timeoutIndicator.progressPercent}%` }}
            />
          </div>
        ) : null}
      </Card>
    </div>
  );
};
