import {
    AlertTriangle,
    CheckCircle2,
    ChevronDown,
    ChevronRight,
    LoaderCircle,
} from "lucide-react";
import { useEffect, useRef, useState, type JSX } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "./components/ui/card";
import { cn } from "./lib/utils";
import type { TaskPanelTone } from "./task-panel.model";
import type {
  TaskThinkingModelStream,
  TaskThinkingTrace,
} from "./task-thinking.model";

const entryToneDotClasses: Record<TaskPanelTone, string> = {
  neutral: "bg-slate-500",
  info: "bg-sky-400",
  success: "bg-emerald-400",
  warning: "bg-amber-400",
  danger: "bg-rose-400",
};

const entryToneLabelClasses: Record<TaskPanelTone, string> = {
  neutral: "text-slate-200",
  info: "text-sky-200",
  success: "text-emerald-200",
  warning: "text-amber-200",
  danger: "text-rose-200",
};

const outputLineClasses = {
  stdout: "border-emerald-500/20 text-emerald-100",
  stderr: "border-amber-500/20 text-amber-100",
};

type VisibleModelStreamKind = Exclude<
  TaskThinkingModelStream["kind"],
  "assistant"
>;

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

export interface TaskThinkingPanelProps {
  thinking: TaskThinkingTrace;
}

/**
 * Small fixed-height activity panel that shows the task's live execution
 * thinking/progress feed before the final assistant response is rendered.
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
  const [isCollapsed, setIsCollapsed] = useState<boolean>(!isRunning);

  useEffect(() => {
    if (!isRunning) {
      return;
    }

    const node = scrollContainerRef.current;

    if (!node) {
      return;
    }

    node.scrollTop = node.scrollHeight;
  }, [entries.length, isRunning]);

  useEffect(() => {
    setIsCollapsed(!isRunning);
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

  return (
    <div aria-live="polite" className="app-thinking-panel min-h-0 min-w-0 w-full">
      <Card
        className={cn(
          "app-thinking-card min-w-0 overflow-hidden border text-slate-100",
          isCollapsed
            ? "w-full rounded-[1.1rem] rounded-bl-sm border-slate-800/60 bg-slate-900/28 shadow-none"
            : "w-full rounded-3xl border-slate-800 bg-slate-900/85 shadow-xl shadow-slate-950/25",
        )}
      >
        <CardHeader
          className={cn(
            "app-thinking-header",
            isCollapsed
              ? "gap-0 px-3 py-1.5"
              : "gap-3 px-5 py-4 border-b border-slate-800/90",
          )}
        >
          <div
            className={cn(
              "flex gap-3",
              isCollapsed ? "items-center gap-2" : "items-start",
            )}
          >
            <div
              className={cn(
                "app-thinking-main-icon flex items-center justify-center border border-sky-500/20 bg-sky-500/10 text-sky-200",
                isCollapsed ? "h-5 w-5 rounded-md" : "h-9 w-9 rounded-2xl",
              )}
            >
              <HeaderIcon
                className={cn(
                  isCollapsed ? "h-2.5 w-2.5" : "h-4 w-4",
                  isRunning && "animate-spin",
                )}
              />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-3">
                <CardTitle
                  className={cn(
                    "font-semibold text-slate-100",
                    isCollapsed ? "text-[12px] leading-none" : "text-sm",
                  )}
                >
                  Thinking process
                </CardTitle>
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
                      : "h-8 px-3 text-xs",
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
            <div
              ref={scrollContainerRef}
              className="app-thinking-scroll h-44 min-w-0 overflow-y-auto px-5 py-4 [scrollbar-gutter:stable]"
            >
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
                    Command output
                  </p>
                  <div className="mt-2 max-h-28 overflow-y-auto font-mono text-[11px] leading-5">
                    {actionOutputLines.map((line) => (
                      <div
                        key={line.id}
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

              <ol className="app-thinking-entries m-0 grid gap-3 p-0 list-none">
                {entries.map((entry, index) => {
                  const isLastEntry = index === entries.length - 1;

                  return (
                    <li
                      key={entry.id}
                      className="app-thinking-entry grid grid-cols-[auto_1fr] gap-3"
                    >
                      <div className="flex min-h-full flex-col items-center">
                        <span
                          className={cn(
                            "mt-1 h-2.5 w-2.5 rounded-full",
                            entryToneDotClasses[entry.tone],
                          )}
                        />
                        {!isLastEntry ? (
                          <span className="mt-1 min-h-5 w-px flex-1 bg-slate-800/80" />
                        ) : null}
                      </div>

                      <div className="min-w-0 pb-1">
                        <p
                          className={cn(
                            "m-0 text-[11px] font-semibold tracking-[0.18em] uppercase",
                            entryToneLabelClasses[entry.tone],
                          )}
                        >
                          {entry.label}
                        </p>
                        <p className="app-thinking-entry-detail mt-1 text-sm leading-6 text-slate-300 wrap-break-word">
                          {entry.detail}
                        </p>
                      </div>
                    </li>
                  );
                })}
              </ol>
            </div>
          </CardContent>
        ) : null}
      </Card>
    </div>
  );
};
