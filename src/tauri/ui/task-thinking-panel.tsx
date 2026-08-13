import {
  Activity,
  AlertTriangle,
  BrainCircuit,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock3,
  Hammer,
  LoaderCircle,
  MessageSquareText,
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
import {
  createTaskExecutionStory,
  type TaskExecutionStoryItem,
} from "./task-execution-story";
import type {
  TaskThinkingModelStream,
  TaskThinkingTrace,
} from "./task-thinking.model";

const entryToneLabelClasses: Record<TaskPanelTone, string> = {
  neutral: "text-slate-300",
  info: "text-sky-200",
  success: "text-emerald-200",
  warning: "text-amber-200",
  danger: "text-rose-200",
};

const entryToneBorderClasses: Record<TaskPanelTone, string> = {
  neutral: "border-slate-700/70",
  info: "border-sky-500/35",
  success: "border-emerald-500/35",
  warning: "border-amber-500/35",
  danger: "border-rose-500/35",
};

const headerToneClasses: Record<TaskPanelTone, string> = {
  neutral: "border-slate-700/70 bg-slate-800/50 text-slate-200",
  info: "border-sky-500/20 bg-sky-500/10 text-sky-200",
  success: "border-emerald-500/20 bg-emerald-500/10 text-emerald-200",
  warning: "border-amber-500/25 bg-amber-500/10 text-amber-200",
  danger: "border-rose-500/25 bg-rose-500/10 text-rose-200",
};

const outputLineClasses = {
  stdout: "text-emerald-100",
  stderr: "text-amber-100",
};

const storyIcons: Record<TaskExecutionStoryItem["kind"], LucideIcon> = {
  state: Activity,
  "model-call": BrainCircuit,
  "tool-call": Hammer,
  retry: RotateCcw,
  validator: ShieldCheck,
  output: TerminalSquare,
  terminal: TerminalSquare,
};

type VisibleModelStreamKind = Exclude<
  TaskThinkingModelStream["kind"],
  "assistant" | "status"
>;

type VisibleModelStream = TaskThinkingModelStream & {
  kind: VisibleModelStreamKind;
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
  usage: NonNullable<TaskExecutionStoryItem["tokenUsage"]>,
): string => {
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

  return parts.join(" / ");
};

const formatMetadataKey = (value: string): string => {
  return value
    .replace(/([a-z])([A-Z])/gu, "$1 $2")
    .replace(/[_-]+/gu, " ")
    .toLowerCase();
};

const getTechnicalMetadata = (
  item: TaskExecutionStoryItem,
): Array<[string, string]> => {
  const entries: Array<[string, string]> = [];

  if (item.sourceLabel !== item.label) {
    entries.push(["event", item.sourceLabel]);
  }

  if (item.provider || item.model) {
    entries.push([
      "model",
      [item.provider, item.model].filter(Boolean).join(" / "),
    ]);
  }

  if (item.callId) {
    entries.push(["call id", item.callId]);
  }

  if (item.tokenUsage) {
    entries.push(["tokens", formatTokenUsage(item.tokenUsage)]);
  }

  for (const [key, value] of Object.entries(item.metadata ?? {})) {
    if (
      key === "durationMs" ||
      key === "argumentsPreview" ||
      key === "outputPreview"
    ) {
      continue;
    }

    entries.push([formatMetadataKey(key), String(value)]);
  }

  return entries;
};

const getPreview = (
  item: TaskExecutionStoryItem,
  key: "argumentsPreview" | "outputPreview",
): string | undefined => {
  const value = item.metadata?.[key];

  return typeof value === "string" && value.trim() ? value : undefined;
};

const StoryItemDetails = ({
  item,
}: {
  item: TaskExecutionStoryItem;
}): JSX.Element | null => {
  const inputPreview = getPreview(item, "argumentsPreview");
  const outputPreview = getPreview(item, "outputPreview");
  const metadata = getTechnicalMetadata(item);
  const hasStartedDetail =
    Boolean(item.startedDetail) && item.startedDetail !== item.detail;
  const hasCommandDetails =
    Boolean(inputPreview) ||
    Boolean(outputPreview) ||
    item.outputLines.length > 0;

  if (!hasStartedDetail && !hasCommandDetails && metadata.length === 0) {
    return null;
  }

  const summary =
    item.kind === "terminal"
      ? "Show output"
      : item.kind === "tool-call" && hasCommandDetails
        ? "Command and output"
        : "Technical details";

  return (
    <details className="app-thinking-disclosure mt-2 min-w-0 text-xs text-slate-400">
      <summary className="w-fit cursor-pointer rounded-md text-[11px] font-medium text-slate-400 outline-none hover:text-slate-200 focus-visible:ring-2 focus-visible:ring-sky-400/60">
        {summary}
      </summary>
      <div className="mt-2 grid min-w-0 gap-2 rounded-xl border border-slate-800 bg-slate-950/50 p-3">
        {hasStartedDetail ? (
          <div className="min-w-0">
            <p className="m-0 text-[10px] font-semibold tracking-[0.12em] text-slate-500 uppercase">
              Started
            </p>
            <p className="mt-1 text-xs leading-5 text-slate-300 wrap-break-word">
              {item.startedDetail}
            </p>
          </div>
        ) : null}

        {inputPreview ? (
          <div className="min-w-0">
            <p className="m-0 text-[10px] font-semibold tracking-[0.12em] text-slate-500 uppercase">
              Input
            </p>
            <pre className="app-thinking-code mt-1 max-h-28 max-w-full overflow-auto whitespace-pre-wrap rounded-lg bg-slate-950/80 px-3 py-2 text-xs leading-5 text-slate-300 wrap-break-word">
              {inputPreview}
            </pre>
          </div>
        ) : null}

        {outputPreview ? (
          <div className="min-w-0">
            <p className="m-0 text-[10px] font-semibold tracking-[0.12em] text-slate-500 uppercase">
              Result
            </p>
            <pre className="app-thinking-code mt-1 max-h-28 max-w-full overflow-auto whitespace-pre-wrap rounded-lg bg-slate-950/80 px-3 py-2 text-xs leading-5 text-slate-300 wrap-break-word">
              {outputPreview}
            </pre>
          </div>
        ) : null}

        {item.outputLines.length > 0 ? (
          <div className="min-w-0">
            <p className="m-0 text-[10px] font-semibold tracking-[0.12em] text-slate-500 uppercase">
              Terminal
            </p>
            <div className="app-thinking-code mt-1 max-h-40 overflow-y-auto rounded-lg bg-slate-950/80 px-3 py-2 font-mono text-[11px] leading-5">
              {item.outputLines.map((line, index) => (
                <div
                  key={`${line.id}\0${index}`}
                  className={cn(
                    "grid min-w-0 grid-cols-[3.5rem_minmax(0,1fr)] gap-2",
                    outputLineClasses[line.stream],
                  )}
                >
                  <span className="text-slate-500">{line.stream}</span>
                  <span className="min-w-0 break-words">{line.text}</span>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {metadata.length > 0 ? (
          <dl className="m-0 grid min-w-0 gap-x-3 gap-y-1 text-[11px] sm:grid-cols-[max-content_minmax(0,1fr)]">
            {metadata.map(([label, value], index) => (
              <div key={`${label}\0${index}`} className="contents">
                <dt className="text-slate-500">{label}</dt>
                <dd className="m-0 min-w-0 break-words text-slate-300">
                  {value}
                </dd>
              </div>
            ))}
          </dl>
        ) : null}
      </div>
    </details>
  );
};

const StoryRow = ({
  item,
  isLast,
}: {
  item: TaskExecutionStoryItem;
  isLast: boolean;
}): JSX.Element => {
  const Icon = storyIcons[item.kind];

  return (
    <li className="app-thinking-entry grid grid-cols-[4.25rem_auto_minmax(0,1fr)] gap-3">
      <span className="pt-0.5 text-right font-mono text-[11px] text-slate-500">
        +{formatElapsedTime(item.elapsedMs)}
      </span>
      <div className="flex min-h-full flex-col items-center">
        <span
          className={cn(
            "flex h-6 w-6 items-center justify-center rounded-lg border bg-slate-950/60",
            entryToneBorderClasses[item.tone],
            entryToneLabelClasses[item.tone],
          )}
        >
          <Icon className="h-3.5 w-3.5" />
        </span>
        {!isLast ? (
          <span className="mt-1 min-h-5 w-px flex-1 bg-slate-800/80" />
        ) : null}
      </div>

      <div className="min-w-0 pb-2">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <p
            className={cn(
              "m-0 text-sm font-semibold leading-5",
              entryToneLabelClasses[item.tone],
            )}
          >
            {item.label}
          </p>
          {item.durationMs !== undefined ? (
            <span className="text-[10px] tabular-nums text-slate-500">
              {formatElapsedTime(item.durationMs)}
            </span>
          ) : null}
        </div>
        {item.detail ? (
          <p className="app-thinking-entry-detail mt-1 text-sm leading-6 text-slate-300 wrap-break-word">
            {item.detail}
          </p>
        ) : null}
        <StoryItemDetails item={item} />
      </div>
    </li>
  );
};

const createUniqueRenderKeys = (
  entries: readonly { id: string }[],
): string[] => {
  const occurrences = new Map<string, number>();

  return entries.map((entry) => {
    const occurrence = occurrences.get(entry.id) ?? 0;
    occurrences.set(entry.id, occurrence + 1);

    return occurrence === 0 ? entry.id : `${entry.id}\0duplicate-${occurrence}`;
  });
};

const getLiveActivityLabel = (stream: VisibleModelStream): string => {
  switch (stream.kind) {
    case "tool-call":
      return `Preparing ${stream.label}`;
    case "tool-result":
      return `Reviewing ${stream.label}`;
    case "reasoning":
      return "Thinking";
  }
};

export interface TaskThinkingPanelProps {
  thinking: TaskThinkingTrace;
}

export const TaskThinkingPanel = ({
  thinking,
}: TaskThinkingPanelProps): JSX.Element => {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const shouldFollowLatestRef = useRef(true);
  const isRunning = thinking.status === "running";
  const assistantText = isRunning ? thinking.assistantText?.trim() : undefined;
  const storyItems = useMemo(
    () => createTaskExecutionStory(thinking),
    [thinking],
  );
  const storyItemKeys = useMemo(
    () => createUniqueRenderKeys(storyItems),
    [storyItems],
  );
  const latestStoryItem = storyItems.at(-1);
  const latestOutcomeItem = [...storyItems]
    .reverse()
    .find((item) => item.kind !== "terminal");
  const statusTone: TaskPanelTone = latestOutcomeItem?.tone ?? "neutral";
  const modelStream = thinking.modelStream;
  const visibleModelStream: VisibleModelStream | undefined =
    isRunning &&
    modelStream &&
    !modelStream.complete &&
    modelStream.kind !== "assistant" &&
    modelStream.kind !== "status"
      ? (modelStream as VisibleModelStream)
      : undefined;
  const [currentTimeMs, setCurrentTimeMs] = useState(() => Date.now());
  const elapsedMs = Math.max(
    0,
    (isRunning
      ? currentTimeMs
      : (thinking.completedAt ??
        latestStoryItem?.timestamp ??
        thinking.startedAt)) - thinking.startedAt,
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

  useEffect(() => {
    if (!isRunning || isCollapsed || !shouldFollowLatestRef.current) {
      return;
    }

    const node = scrollContainerRef.current;

    if (node) {
      node.scrollTop = node.scrollHeight;
    }
  }, [
    assistantText?.length,
    isCollapsed,
    isRunning,
    storyItems,
    visibleModelStream?.content.length,
  ]);

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
    shouldFollowLatestRef.current = true;
  }, [isRunning]);

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
  const headerTone = isRunning ? "info" : statusTone;
  const hasLiveRows = Boolean(visibleModelStream || assistantText);

  return (
    <div className="app-thinking-panel min-h-0 min-w-0 w-full">
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
              data-tone={headerTone}
              className={cn(
                "app-thinking-main-icon flex items-center justify-center border",
                headerToneClasses[headerTone],
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
                    Execution
                  </CardTitle>
                  {isCollapsed ? (
                    <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[10px] text-slate-500">
                      <Clock3 className="h-2.5 w-2.5" />
                      <span>{formatElapsedTime(elapsedMs)}</span>
                    </div>
                  ) : (
                    <div className="flex shrink-0 items-center gap-1 text-[11px] font-medium tabular-nums text-slate-400">
                      <Clock3 className="h-3 w-3 text-slate-500" />
                      <span
                        aria-label={`Elapsed time ${formatElapsedTime(elapsedMs)}`}
                      >
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
                      ? "Expand execution details"
                      : "Collapse execution details"
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
                    className={cn(isCollapsed ? "h-2.5 w-2.5" : "h-3.5 w-3.5")}
                  />
                  {isCollapsed ? "Details" : "Hide details"}
                </button>
              </div>
            </div>
          </div>
        </CardHeader>

        {!isCollapsed ? (
          <CardContent className="px-0 py-0">
            <div
              ref={scrollContainerRef}
              onScroll={(event) => {
                const node = event.currentTarget;
                shouldFollowLatestRef.current =
                  node.scrollHeight - node.scrollTop - node.clientHeight < 32;
              }}
              className="app-thinking-scroll max-h-80 min-w-0 overflow-y-auto px-5 py-4 [scrollbar-gutter:stable]"
            >
              <ol
                aria-live="polite"
                aria-relevant="additions text"
                className="app-thinking-entries m-0 grid gap-3 p-0 list-none"
              >
                {storyItems.map((item, index) => (
                  <StoryRow
                    key={storyItemKeys[index]}
                    item={item}
                    isLast={index === storyItems.length - 1 && !hasLiveRows}
                  />
                ))}

                {visibleModelStream ? (
                  <li className="app-thinking-entry grid grid-cols-[4.25rem_auto_minmax(0,1fr)] gap-3">
                    <span className="pt-0.5 text-right font-mono text-[11px] text-slate-500">
                      +{formatElapsedTime(elapsedMs)}
                    </span>
                    <div className="flex min-h-full flex-col items-center">
                      <span className="flex h-6 w-6 items-center justify-center rounded-lg border border-sky-500/35 bg-slate-950/60 text-sky-200">
                        <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                      </span>
                      {assistantText ? (
                        <span className="mt-1 min-h-5 w-px flex-1 bg-slate-800/80" />
                      ) : null}
                    </div>
                    <div className="min-w-0 pb-2">
                      <p className="m-0 text-sm font-semibold leading-5 text-sky-200">
                        {getLiveActivityLabel(visibleModelStream)}
                      </p>
                      {visibleModelStream.content.trim() ? (
                        <details className="app-thinking-disclosure mt-2 min-w-0 text-xs text-slate-400">
                          <summary className="w-fit cursor-pointer rounded-md text-[11px] font-medium text-slate-400 outline-none hover:text-slate-200 focus-visible:ring-2 focus-visible:ring-sky-400/60">
                            Technical details
                          </summary>
                          <pre className="app-thinking-code mt-2 max-h-28 max-w-full overflow-auto whitespace-pre-wrap rounded-lg bg-slate-950/80 px-3 py-2 text-xs leading-5 text-slate-300 wrap-break-word">
                            {visibleModelStream.content}
                          </pre>
                        </details>
                      ) : null}
                    </div>
                  </li>
                ) : null}

                {assistantText ? (
                  <li className="app-thinking-entry grid grid-cols-[4.25rem_auto_minmax(0,1fr)] gap-3">
                    <span className="pt-0.5 text-right font-mono text-[11px] text-slate-500">
                      +{formatElapsedTime(elapsedMs)}
                    </span>
                    <div className="flex min-h-full flex-col items-center">
                      <span className="flex h-6 w-6 items-center justify-center rounded-lg border border-sky-500/35 bg-slate-950/60 text-sky-200">
                        <MessageSquareText className="h-3.5 w-3.5" />
                      </span>
                    </div>
                    <div className="min-w-0 pb-2">
                      <p className="m-0 text-sm font-semibold leading-5 text-sky-200">
                        Drafting response
                      </p>
                      <p className="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap text-sm leading-6 text-slate-300 wrap-break-word">
                        {assistantText}
                      </p>
                    </div>
                  </li>
                ) : null}
              </ol>
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
