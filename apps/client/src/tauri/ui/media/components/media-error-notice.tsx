import { CopyContextMenu } from "../../components/ui/copy-context-menu";
import { RotateCw } from "lucide-react";
import type { JSX } from "react";
import type {
  MediaErrorAction,
  MediaErrorDetail,
} from "../../../../core/media/contracts.js";
import { Button } from "../../components/ui/button";
import { AppNotification } from "../../components/ui/notification";

interface MediaErrorNoticeProps {
  error: MediaErrorDetail;
  onAction: (action: MediaErrorAction["id"]) => void;
  onDismiss: () => void;
}

export const MediaErrorNotice = ({
  error,
  onAction,
  onDismiss,
}: MediaErrorNoticeProps): JSX.Element => (
  <AppNotification
    tone="error"
    title={
      error.code === "QUALITY_GATE_FAILED"
        ? "Quality checks stopped this run."
        : error.message
    }
    titleId="media-error-title"
    dismissAfterMs={null}
    dismissLabel="Dismiss Media Studio error"
    onDismiss={onDismiss}
    className="mx-5 mt-4 shrink-0 shadow-lg shadow-slate-950/20"
  >
    {error.partialOutputsExist ? (
      <p className="mt-1.5 text-xs text-rose-100/65">
        Generated assets remain in Assets.
      </p>
    ) : null}

    {error.suggestedActions.length > 0 ? (
      <div className="mt-3 flex flex-wrap gap-2">
        {error.suggestedActions
          .filter(
            (action) =>
              (action.id !== "review-input" || Boolean(error.context.runId)) &&
              action.id !== "choose-location",
          )
          .map((action) => (
            <Button
              key={action.id}
              type="button"
              size="sm"
              variant="outline"
              tooltip={action.description}
              onClick={() =>
                onAction(
                  action.id === "review-input" ? "review-run" : action.id,
                )
              }
              className="h-7 border-rose-300/20 bg-slate-950/25 px-2.5 text-[9px] text-rose-100 hover:bg-rose-300/10"
            >
              {action.id === "refresh" || action.id === "retry" ? (
                <RotateCw className="mr-1.5 h-3 w-3" />
              ) : null}
              {action.id === "review-input"
                ? "Review results"
                : action.id === "retry"
                  ? error.context.runId
                    ? "Edit and rerun"
                    : "Refresh"
                  : action.label}
            </Button>
          ))}
      </div>
    ) : null}

    <details className="mt-3 text-[9px] text-slate-500">
      <summary className="cursor-pointer select-none outline-none hover:text-slate-300 focus-visible:text-slate-200">
        Technical details
      </summary>
      <CopyContextMenu
        values={[
          {
            label: "Copy diagnostic",
            value: [
              error.code,
              error.technicalDiagnostic,
              error.context.operation,
              error.context.runId,
              error.context.nodeId,
            ]
              .filter(Boolean)
              .join("\n"),
          },
        ]}
      >
        <div className="mt-2 rounded-lg border border-slate-800 bg-slate-950/45 p-2.5">
          <p className="break-words font-mono leading-4 text-slate-400">
            {error.code} · {error.technicalDiagnostic}
          </p>
          <p className="mt-1.5 font-mono text-[8px] text-slate-600">
            operation {error.context.operation ?? "unknown"}
            {error.context.runId ? ` · run ${error.context.runId}` : ""}
            {error.context.nodeId ? ` · node ${error.context.nodeId}` : ""}
          </p>
        </div>
      </CopyContextMenu>
    </details>
  </AppNotification>
);
