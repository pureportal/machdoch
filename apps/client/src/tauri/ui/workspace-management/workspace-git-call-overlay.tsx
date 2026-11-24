import { Gauge, X } from "lucide-react";
import { useEffect, useState, type JSX } from "react";
import { Button } from "@machdoch/media-studio/tauri/ui/components/ui/button.js";
import {
  slowestWorkspaceGitCalls,
  type WorkspaceGitSlowCall,
} from "./workspace-git-call-log";
import { loadWorkspaceGitCallLog } from "./workspace-tools-runtime";

const REFRESH_MS = 2_000;
const SHOWN_CALLS = 10;

export const WorkspaceGitCallOverlay = ({
  workspaceRoot,
}: {
  workspaceRoot: string;
}): JSX.Element | null => {
  const [open, setOpen] = useState(false);
  const [calls, setCalls] = useState<WorkspaceGitSlowCall[] | null>(null);

  useEffect(() => {
    if (!open) return;
    let active = true;
    const read = (): void => {
      void loadWorkspaceGitCallLog(workspaceRoot)
        .then((log) => {
          if (active) {
            setCalls(
              log.enabled
                ? slowestWorkspaceGitCalls(log.calls, SHOWN_CALLS)
                : [],
            );
          }
        })
        .catch((error: unknown) => console.error("Git call log failed", error));
    };
    read();
    const timer = window.setInterval(read, REFRESH_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [open, workspaceRoot]);

  if (!open) {
    return (
      <Button
        type="button"
        size="icon"
        variant="ghost"
        aria-label="Slow Git calls"
        className="fixed right-3 bottom-3 z-50 size-7 opacity-60 hover:opacity-100"
        onClick={() => setOpen(true)}
      >
        <Gauge className="size-3.5" />
      </Button>
    );
  }
  return (
    <aside
      aria-label="Slow Git calls"
      className="fixed right-3 bottom-3 z-50 w-[28rem] max-w-[calc(100vw-1.5rem)] rounded-lg border border-slate-700 bg-slate-950/95 p-2 text-[11px] shadow-xl"
    >
      <div className="mb-1 flex items-center justify-between">
        <span className="font-medium text-slate-300">Slow Git calls</span>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          aria-label="Close"
          className="size-6"
          onClick={() => setOpen(false)}
        >
          <X className="size-3.5" />
        </Button>
      </div>
      <ol className="max-h-64 space-y-0.5 overflow-y-auto font-mono">
        {(calls ?? []).map((call, index) => (
          <li
            key={`${index}-${call.command}`}
            className="grid grid-cols-[3.5rem_1fr] gap-2"
          >
            <span
              className={
                call.success
                  ? "text-right text-amber-300"
                  : "text-right text-red-300"
              }
            >
              {call.durationMs} ms
            </span>
            <span className="truncate text-slate-400" title={call.command}>
              {call.repository} · {call.command}
              {call.queuedMs > 0 ? ` (+${call.queuedMs} ms queued)` : ""}
            </span>
          </li>
        ))}
      </ol>
    </aside>
  );
};
