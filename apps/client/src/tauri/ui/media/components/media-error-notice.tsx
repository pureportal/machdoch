import { RotateCw } from "lucide-react";
import type { JSX } from "react";
import type {
  MediaErrorAction,
  MediaErrorDetail,
} from "../../../../core/media/contracts.js";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { AppNotification } from "../../components/ui/notification";

interface MediaErrorNoticeProps {
  error: MediaErrorDetail;
  onAction: (action: MediaErrorAction["id"]) => void;
  onDismiss: () => void;
}

const retryabilityLabel = (
  retryability: MediaErrorDetail["retryability"],
): string => {
  switch (retryability) {
    case "retry-safe":
      return "Safe to retry";
    case "after-user-action":
      return "Needs a change";
    case "reconcile-first":
      return "Reconcile first";
    case "user-approval-required":
      return "Approval required";
    default:
      return "Do not retry";
  }
};

export const MediaErrorNotice = ({
  error,
  onAction,
  onDismiss,
}: MediaErrorNoticeProps): JSX.Element => (
  <AppNotification
    tone="error"
    title={
      <>
        <span>{error.message}</span>
        <Badge
          variant="outline"
          className="border-rose-300/20 font-mono text-[8px] text-rose-200/70"
        >
          {error.code}
        </Badge>
        <Badge
          variant="outline"
          className="border-slate-600/60 text-[8px] text-slate-400"
        >
          {retryabilityLabel(error.retryability)}
        </Badge>
      </>
    }
    titleId="media-error-title"
    dismissAfterMs={null}
    dismissLabel="Dismiss Media Studio error"
    onDismiss={onDismiss}
    className="mx-5 mt-4 shrink-0 shadow-lg shadow-slate-950/20"
  >
    <p className="mt-1.5 text-[10px] leading-4 text-rose-100/65">
      {error.partialOutputsExist
        ? "Completed outputs were preserved and remain available in the Library."
        : "No completed output was published by this failed operation."}
    </p>

    {error.suggestedActions.length > 0 ? (
      <div className="mt-3 flex flex-wrap gap-2">
        {error.suggestedActions.map((action) => (
          <Button
            key={action.id}
            type="button"
            size="sm"
            variant="outline"
            tooltip={action.description}
            onClick={() => onAction(action.id)}
            className="h-7 border-rose-300/20 bg-slate-950/25 px-2.5 text-[9px] text-rose-100 hover:bg-rose-300/10"
          >
            {action.id === "refresh" || action.id === "retry" ? (
              <RotateCw className="mr-1.5 h-3 w-3" />
            ) : null}
            {action.label}
          </Button>
        ))}
      </div>
    ) : null}

    <details className="mt-3 text-[9px] text-slate-500">
      <summary className="cursor-pointer select-none outline-none hover:text-slate-300 focus-visible:text-slate-200">
        Technical details
      </summary>
      <div className="mt-2 rounded-lg border border-slate-800 bg-slate-950/45 p-2.5">
        <p className="break-words font-mono leading-4 text-slate-400">
          {error.technicalDiagnostic}
        </p>
        <p className="mt-1.5 font-mono text-[8px] text-slate-600">
          operation {error.context.operation ?? "unknown"}
          {error.context.runId ? ` · run ${error.context.runId}` : ""}
          {error.context.nodeId ? ` · node ${error.context.nodeId}` : ""}
        </p>
      </div>
    </details>
  </AppNotification>
);
