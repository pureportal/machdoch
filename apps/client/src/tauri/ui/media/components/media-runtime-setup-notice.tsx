import { LoaderCircle } from "lucide-react";
import { Button } from "../../components/ui/button";
import {
  isMediaRuntimeSetupActive,
  mediaRuntimeSetupLabel,
  type MediaRuntimeSetupStatus,
} from "../media-runtime-setup";

export const MediaRuntimeSetupNotice = ({
  status,
  needed,
  supported,
  refreshFailed,
  statusUnavailable,
  onSetup,
  onRefresh,
}: {
  status: MediaRuntimeSetupStatus;
  needed: boolean;
  supported: boolean;
  refreshFailed: boolean;
  statusUnavailable: boolean;
  onSetup: () => void;
  onRefresh: () => void;
}) => {
  if (
    !supported ||
    (status.phase === "idle" && !needed && !refreshFailed && !statusUnavailable)
  )
    return null;
  const active = isMediaRuntimeSetupActive(status);
  return (
    <div className="shrink-0 border-b border-slate-800 px-5 py-3">
      <div
        className="flex flex-wrap items-center gap-3"
        role="status"
        aria-live="polite"
      >
        {active ? (
          <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" />
        ) : null}
        {status.phase === "failed" ? (
          <p className="text-sm">{status.message}</p>
        ) : active || status.phase === "ready" ? (
          <p className="text-sm">{mediaRuntimeSetupLabel(status)}</p>
        ) : null}
        {status.phase === "idle" || status.phase === "failed" ? (
          <Button size="sm" variant="outline" onClick={onSetup}>
            {mediaRuntimeSetupLabel(status)}
          </Button>
        ) : null}
        {refreshFailed ? (
          <Button size="sm" variant="outline" onClick={onRefresh}>
            Refresh models
          </Button>
        ) : null}
      </div>
      {statusUnavailable ? (
        <p role="status" className="mt-2 text-sm">
          Could not check setup progress. Reconnecting…
        </p>
      ) : null}
      {refreshFailed ? (
        <p className="mt-2 text-sm">
          Could not update model actions. Refresh models to try again.
        </p>
      ) : null}
      {status.phase === "failed" && status.diagnostic ? (
        <details className="mt-2 text-xs text-slate-400">
          <summary className="cursor-pointer">Show details</summary>
          <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words">
            {status.diagnostic}
          </pre>
        </details>
      ) : null}
    </div>
  );
};
