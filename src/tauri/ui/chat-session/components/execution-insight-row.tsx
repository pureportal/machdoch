import { Play, RotateCcw } from "lucide-react";
import type { JSX } from "react";
import { StatusBadge } from "../../../../common/_components/status-badge";
import type { TaskExecutionResult } from "../../../../core/types.js";
import { Button } from "../../components/ui/button";
import { getRelatedFileButtonLabel } from "../_helpers/execution-message.tsx";

const insightMetadataBadgeClassName =
  "app-execution-metadata h-6 cursor-default select-none rounded-md border-transparent bg-transparent px-1.5 py-0 text-[11px] font-medium text-slate-400 shadow-none";

const actionButtonClassName =
  "app-execution-action h-9 rounded-lg px-3.5 text-xs font-semibold shadow-sm shadow-slate-950/25 transition-colors";

export interface ExecutionInsightRowProps {
  execution: TaskExecutionResult;
  onOpenWorkspaceFile: (relativePath: string) => void;
  onRetryTask?: () => void;
  onContinueTask?: () => void;
}

export const ExecutionInsightRow = ({
  execution,
  onOpenWorkspaceFile,
  onRetryTask,
  onContinueTask,
}: ExecutionInsightRowProps): JSX.Element | null => {
  const relatedFiles = execution.response?.relatedFiles ?? [];
  const verification = execution.response?.verification ?? [];
  const continuationCount = execution.autopilot?.continuationCount ?? 0;
  const canRetryTask =
    !!onRetryTask &&
    (execution.status === "blocked" ||
      execution.status === "cancelled" ||
      execution.status === "unsupported");
  const canContinueTask =
    !!onContinueTask &&
    (execution.status === "executed" ||
      execution.status === "blocked" ||
      execution.status === "cancelled");

  if (
    !canRetryTask &&
    !canContinueTask &&
    relatedFiles.length === 0 &&
    verification.length === 0 &&
    continuationCount === 0
  ) {
    return null;
  }

  return (
    <div className="app-execution-insight-row flex max-w-[90%] flex-wrap items-center gap-2">
      {continuationCount > 0 ? (
        <StatusBadge
          tone="accent"
          variant="ghost"
          className={insightMetadataBadgeClassName}
        >
          <span
            aria-hidden="true"
            className="h-1.5 w-1.5 rounded-full bg-violet-300/70"
          />
          {`Auto review \u00d7${continuationCount}`}
        </StatusBadge>
      ) : null}

      {verification.length > 0 ? (
        <StatusBadge
          tone="success"
          variant="ghost"
          title={verification.join(" \u2022 ")}
          className={insightMetadataBadgeClassName}
        >
          <span
            aria-hidden="true"
            className="h-1.5 w-1.5 rounded-full bg-emerald-300/75"
          />
          {`${verification.length} check${verification.length === 1 ? "" : "s"}`}
        </StatusBadge>
      ) : null}

      {canRetryTask ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onRetryTask}
          className={`${actionButtonClassName} border-amber-400/40 bg-amber-500/15 text-amber-50 hover:border-amber-300/55 hover:bg-amber-500/25 hover:text-white`}
        >
          <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
          Retry
        </Button>
      ) : null}

      {canContinueTask ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onContinueTask}
          className={`${actionButtonClassName} border-emerald-400/40 bg-emerald-500/15 text-emerald-50 hover:border-emerald-300/55 hover:bg-emerald-500/25 hover:text-white`}
        >
          <Play className="mr-1.5 h-3.5 w-3.5" />
          Continue
        </Button>
      ) : null}

      {relatedFiles.map((fileReference) => (
        <Button
          key={`${execution.task}-${fileReference.path}`}
          type="button"
          variant="outline"
          size="sm"
          title={`${fileReference.path} \u2014 ${fileReference.description}`}
          onClick={() => onOpenWorkspaceFile(fileReference.path)}
          className="app-related-file-button h-8 max-w-full rounded-full border-slate-700 bg-slate-950/70 px-3 text-xs text-slate-300 hover:bg-slate-900 hover:text-slate-100 disabled:opacity-60"
        >
          <span className="truncate">
            {getRelatedFileButtonLabel(fileReference.path)}
          </span>
        </Button>
      ))}
    </div>
  );
};
