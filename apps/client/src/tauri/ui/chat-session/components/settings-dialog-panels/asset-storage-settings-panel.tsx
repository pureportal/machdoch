import { invoke, isTauri } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { FolderOpen, LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@machdoch/media-studio/tauri/ui/components/ui/button.js";

interface AssetStorageStatus {
  folder: string;
  destination: string | null;
  phase: "ready" | "moving" | "cleaning" | "paused";
  completedBytes: number;
  totalBytes: number;
  error: string | null;
}

const errorMessage = (error: unknown): string =>
  typeof error === "object" && error !== null && "message" in error
    ? String(error.message)
    : String(error);

export function AssetStorageSettingsPanel() {
  const [status, setStatus] = useState<AssetStorageStatus | null>(null);
  const [folder, setFolder] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isTauri()) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const next = await invoke<AssetStorageStatus>(
          "media_get_asset_storage",
        );
        if (active) setStatus(next);
      } catch (failure) {
        if (active) setError(errorMessage(failure));
      } finally {
        if (active) timer = setTimeout(() => void refresh(), 1000);
      }
    };
    void refresh();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, []);

  if (!isTauri()) {
    return (
      <p className="text-sm text-slate-400">
        Open the desktop app to change the asset folder.
      </p>
    );
  }

  const chooseFolder = async () => {
    setBusy(true);
    setError(null);
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: "Choose asset folder",
      });
      if (typeof selected === "string" && selected !== status?.folder)
        setFolder(selected);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  const move = async (resume: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const next = await invoke<AssetStorageStatus>(
        resume ? "media_resume_asset_storage" : "media_move_asset_storage",
        resume ? undefined : { folder },
      );
      setStatus(next);
      setFolder(null);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  const moving = status !== null && status.phase !== "ready";
  const progress =
    status && status.totalBytes > 0
      ? Math.min(
          100,
          Math.round((status.completedBytes / status.totalBytes) * 100),
        )
      : 0;

  return (
    <div className="min-w-0 space-y-5">
      <div className="space-y-2">
        <h3 className="text-sm font-medium text-slate-200">Asset folder</h3>
        {status ? (
          <p className="break-all rounded-lg border border-slate-700 bg-slate-900 px-3 py-2.5 text-sm text-slate-300">
            {status.folder}
          </p>
        ) : (
          !error && (
            <LoaderCircle
              aria-label="Loading asset storage"
              className="h-4 w-4 animate-spin text-slate-400"
            />
          )
        )}
      </div>
      {moving && (
        <div className="space-y-3" role="status" aria-live="polite">
          <div className="flex items-center justify-between gap-3 text-sm text-slate-200">
            <span>
              {status.phase === "paused"
                ? "Move paused"
                : status.phase === "cleaning"
                  ? "Removing original files"
                  : "Moving assets"}
            </span>
            <span className="shrink-0 tabular-nums">{progress}%</span>
          </div>
          <progress
            aria-label="Asset move progress"
            value={status.completedBytes}
            max={Math.max(1, status.totalBytes)}
            className="h-2 w-full accent-sky-400"
          />
          <p className="break-all text-sm text-slate-400">
            {status.destination}
          </p>
          {status.error && (
            <p role="alert" className="text-sm text-rose-300">
              {status.error}
            </p>
          )}
          {status.phase === "paused" && (
            <Button disabled={busy} onClick={() => void move(true)}>
              Resume move
            </Button>
          )}
        </div>
      )}
      {!moving && folder && (
        <div className="space-y-3 rounded-lg border border-slate-700 p-4">
          <p className="break-all text-sm text-slate-200">{folder}</p>
          <p className="text-sm text-slate-400">
            Move all models, LoRAs, and other Media Studio assets here. Media
            Studio pauses until the move finishes; interrupted moves resume on
            restart.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button disabled={busy} onClick={() => void move(false)}>
              {busy && <LoaderCircle className="h-4 w-4 animate-spin" />}Move
              assets
            </Button>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setFolder(null)}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-rose-300">
          {error}
        </p>
      )}
      {!moving && (
        <Button
          variant="outline"
          disabled={busy || !status}
          onClick={() => void chooseFolder()}
        >
          <FolderOpen className="h-4 w-4" />
          Choose folder
        </Button>
      )}
    </div>
  );
}
