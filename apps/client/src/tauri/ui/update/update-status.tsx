import { Download, LoaderCircle } from "lucide-react";
import type { useDesktopUpdate } from "./use-desktop-update";

export function UpdateStatus({
  updater,
}: {
  updater: ReturnType<typeof useDesktopUpdate>;
}) {
  const downloading = updater.phase === "downloading";
  if (
    !downloading &&
    updater.phase !== "installing" &&
    updater.phase !== "installed"
  )
    return null;

  const percent = updater.progress.total
    ? Math.min(
        100,
        Math.floor(
          (updater.progress.downloaded / updater.progress.total) * 100,
        ),
      )
    : null;
  const label = updater.canceling
    ? "Canceling…"
    : downloading
      ? `Downloading update${percent === null ? "…" : ` ${percent}%`}`
      : updater.phase === "installing"
        ? "Installing update…"
        : "Update installed";

  return (
    <div
      className="relative z-10 ml-3 flex min-w-0 items-center gap-2 text-xs text-sky-300"
      data-tauri-no-drag
    >
      <button
        type="button"
        className="flex h-7 min-w-0 items-center gap-1.5 rounded px-1.5 hover:bg-slate-800 focus-visible:outline focus-visible:outline-sky-400"
        onClick={updater.show}
        aria-label={label}
        aria-haspopup="dialog"
        aria-controls="app-update-dialog"
      >
        {downloading && !updater.canceling ? (
          <Download className="size-3.5 shrink-0" aria-hidden="true" />
        ) : updater.phase !== "installed" ? (
          <LoaderCircle
            className="size-3.5 shrink-0 animate-spin"
            aria-hidden="true"
          />
        ) : null}
        <span className="truncate" role="status">
          {label}
        </span>
      </button>
      {downloading ? (
        <>
          <progress
            aria-label="Update download"
            className="hidden h-1 w-12 accent-sky-500 sm:block"
            max={updater.progress.total || 1}
            value={
              updater.progress.total
                ? Math.min(updater.progress.downloaded, updater.progress.total)
                : undefined
            }
          />
          <button
            type="button"
            className="h-7 rounded px-1.5 text-slate-400 hover:bg-slate-800 hover:text-slate-100 disabled:opacity-50"
            aria-label="Cancel update download"
            disabled={updater.canceling}
            onClick={() => void updater.cancel()}
          >
            Cancel
          </button>
        </>
      ) : null}
    </div>
  );
}
