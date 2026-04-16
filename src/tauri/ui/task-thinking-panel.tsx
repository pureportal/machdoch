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
import type { TaskThinkingTrace } from "./task-thinking.model";

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
    <div aria-live="polite" className="min-h-0 w-full">
      <Card
        className={cn(
          "overflow-hidden border text-slate-100",
          isCollapsed
            ? "w-full rounded-[1.1rem] rounded-bl-sm border-slate-800/60 bg-slate-900/28 shadow-none"
            : "w-full rounded-3xl border-slate-800 bg-slate-900/85 shadow-xl shadow-slate-950/25",
        )}
      >
        <CardHeader
          className={cn(
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
                "flex items-center justify-center border border-sky-500/20 bg-sky-500/10 text-sky-200",
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
                    "inline-flex items-center gap-1.5 rounded-full border border-slate-800 bg-slate-950/70 font-medium text-slate-300 transition-colors hover:bg-slate-900 hover:text-slate-100",
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
              className="h-44 overflow-y-auto px-5 py-4 [scrollbar-gutter:stable]"
            >
              <ol className="m-0 grid gap-3 p-0 list-none">
                {entries.map((entry, index) => {
                  const isLastEntry = index === entries.length - 1;

                  return (
                    <li
                      key={entry.id}
                      className="grid grid-cols-[auto_1fr] gap-3"
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

                      <div className="pb-1">
                        <p
                          className={cn(
                            "m-0 text-[11px] font-semibold tracking-[0.18em] uppercase",
                            entryToneLabelClasses[entry.tone],
                          )}
                        >
                          {entry.label}
                        </p>
                        <p className="mt-1 text-sm leading-6 text-slate-300">
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
