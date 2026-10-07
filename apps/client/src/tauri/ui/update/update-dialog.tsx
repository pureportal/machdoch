import { ArrowUpRight, Download, LoaderCircle } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@machdoch/media-studio/tauri/ui/components/ui/dialog.js";
import { Button } from "@machdoch/media-studio/tauri/ui/components/ui/button.js";
import { useState } from "react";
import type { useDesktopUpdate } from "./use-desktop-update";

export function UpdateDialog({
  updater,
  blocked,
}: {
  updater: ReturnType<typeof useDesktopUpdate>;
  blocked: boolean;
}) {
  const [duration, setDuration] = useState<"hour" | "day" | "week" | "release">(
    "day",
  );
  const working = ["downloading", "installing", "checking"].includes(
    updater.phase,
  );
  const title =
    updater.phase === "current"
      ? "You're up to date"
      : updater.phase === "checking"
        ? "Checking for updates"
        : updater.phase === "installed"
          ? "Update installed"
          : "Machdoch update";
  return (
    <Dialog
      open={updater.open && !blocked}
      onOpenChange={(open) => {
        if (!open && !working) updater.close();
      }}
      commandOverlayId="app-update"
    >
      <DialogContent
        className="sm:max-w-md"
        showCloseButton={!working && !updater.saving}
        onInteractOutside={(event) => event.preventDefault()}
        aria-describedby={updater.release ? "update-description" : undefined}
      >
        <DialogHeader>
          <div className="mb-3 grid size-12 place-items-center rounded-2xl bg-sky-950/70 text-sky-300">
            <Download aria-hidden="true" className="size-6" />
          </div>
          <DialogTitle>{title}</DialogTitle>
          {updater.release ? (
            <DialogDescription id="update-description">{`${updater.release.currentVersion} → ${updater.release.version}`}</DialogDescription>
          ) : null}
        </DialogHeader>
        {updater.release && !working && updater.phase !== "installed" ? (
          <Button
            variant="link"
            className="h-auto w-fit justify-start px-0"
            onClick={() => {
              void openUrl(
                `https://github.com/pureportal/machdoch/releases/tag/v${updater.release!.version}`,
              ).catch((error: unknown) =>
                console.error("Could not open release notes", error),
              );
            }}
          >
            Release notes <ArrowUpRight aria-hidden="true" className="size-4" />
          </Button>
        ) : null}
        {updater.phase === "downloading" ? (
          <div className="grid gap-2" role="status">
            <div className="flex justify-between text-sm">
              <span>Downloading</span>
              {updater.progress.total ? (
                <span>
                  {Math.min(
                    100,
                    Math.floor(
                      (updater.progress.downloaded / updater.progress.total) *
                        100,
                    ),
                  )}
                  %
                </span>
              ) : null}
            </div>
            <progress
              aria-label="Update download"
              className="h-2 w-full accent-sky-500"
              max={updater.progress.total ?? 1}
              value={
                updater.progress.total ? updater.progress.downloaded : undefined
              }
            />
          </div>
        ) : updater.phase === "installing" ? (
          <p className="flex items-center gap-2 text-sm" role="status">
            <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
            Installing…
          </p>
        ) : null}
        {updater.error ? (
          <p role="alert" className="text-sm text-rose-300">
            {updater.error}
          </p>
        ) : null}
        {updater.release && !working && updater.phase !== "installed" ? (
          <label className="grid gap-2 text-sm">
            Remind me
            <select
              className="h-9 rounded-md border border-slate-700 bg-slate-950 px-3 text-slate-100"
              value={duration}
              onChange={(event) =>
                setDuration(event.target.value as typeof duration)
              }
              disabled={updater.saving}
            >
              <option value="hour">In 1 hour</option>
              <option value="day">Tomorrow</option>
              <option value="week">In 1 week</option>
              <option value="release">Until the next release</option>
            </select>
          </label>
        ) : null}
        <DialogFooter>
          {updater.phase === "installed" ? (
            <Button
              className="bg-sky-600 text-white hover:bg-sky-500"
              onClick={() => {
                void updater.restart();
              }}
            >
              Restart Machdoch
            </Button>
          ) : updater.release && !working ? (
            <>
              <Button
                variant="outline"
                disabled={updater.saving}
                onClick={() => {
                  void updater.defer(duration);
                }}
              >
                {duration === "release"
                  ? "Skip this release"
                  : "Remind me later"}
              </Button>
              <Button
                className="bg-sky-600 text-white hover:bg-sky-500"
                disabled={updater.saving}
                onClick={() => {
                  void updater.install();
                }}
              >
                Update and restart
              </Button>
            </>
          ) : !working ? (
            <>
              <Button variant="outline" onClick={updater.close}>
                Close
              </Button>
              {updater.phase === "error" ? (
                <Button onClick={updater.check}>Retry</Button>
              ) : null}
            </>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
