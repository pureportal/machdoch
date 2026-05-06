import { Check } from "lucide-react";
import type { JSX } from "react";
import { StatusBadge } from "../../../../common/_components/status-badge";
import type { TaskExecutionResult } from "../../../../core/types.js";
import { Button } from "../../components/ui/button";
import { getRelatedFileButtonLabel } from "../_helpers/execution-message.tsx";

export interface ExecutionInsightRowProps {
  execution: TaskExecutionResult;
  onOpenWorkspaceFile: (relativePath: string) => void;
  onApprovePlan?: () => void;
}

export const ExecutionInsightRow = ({
  execution,
  onOpenWorkspaceFile,
  onApprovePlan,
}: ExecutionInsightRowProps): JSX.Element | null => {
  const relatedFiles = execution.response?.relatedFiles ?? [];
  const verification = execution.response?.verification ?? [];
  const continuationCount = execution.autopilot?.continuationCount ?? 0;
  const canApprovePlan = execution.status === "planned" && !!onApprovePlan;

  if (
    !canApprovePlan &&
    relatedFiles.length === 0 &&
    verification.length === 0 &&
    continuationCount === 0
  ) {
    return null;
  }

  return (
    <div className="flex max-w-[90%] flex-wrap items-center gap-2">
      {continuationCount > 0 ? (
        <StatusBadge tone="accent">{`Auto review ×${continuationCount}`}</StatusBadge>
      ) : null}

      {verification.length > 0 ? (
        <StatusBadge tone="success" title={verification.join(" • ")}>
          {`${verification.length} check${verification.length === 1 ? "" : "s"}`}
        </StatusBadge>
      ) : null}

      {canApprovePlan ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onApprovePlan}
          className="h-8 rounded-full border-sky-500/30 bg-sky-500/10 px-3 text-xs text-sky-100 hover:bg-sky-500/15 hover:text-white"
        >
          <Check className="mr-1.5 h-3.5 w-3.5" />
          Approve plan
        </Button>
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
