import {
  Archive,
  ArchiveRestore,
  LoaderCircle,
  Trash2,
  Upload,
} from "lucide-react";
import { useState, type JSX } from "react";
import { Button } from "@machdoch/media-studio/tauri/ui/components/ui/button.js";
import { EmptyState } from "@machdoch/media-studio/tauri/ui/components/ui/empty-state.js";
import { Input } from "@machdoch/media-studio/tauri/ui/components/ui/input.js";
import {
  SUBMIT_SHORTCUT_ACTION_PROPS,
  SubmitShortcut,
} from "@machdoch/media-studio/tauri/ui/components/ui/submit-shortcut.js";
import type { WorkspaceGitOverview } from "../runtime";
import type { WorkspaceGitControls } from "./use-workspace-git";
import { formatWorkspaceGitTime } from "./workspace-git-time";

export const WorkspaceGitStashes = ({
  controls,
  overview,
}: {
  controls: WorkspaceGitControls;
  overview: WorkspaceGitOverview;
}): JSX.Element => {
  const [message, setMessage] = useState("");
  const [includeUntracked, setIncludeUntracked] = useState(true);
  const stash = async (): Promise<void> => {
    if (await controls.runAction("stash-push", { message, includeUntracked })) {
      setMessage("");
    }
  };
  return (
    <div className="space-y-3">
      <SubmitShortcut asChild>
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-800 bg-slate-950/50 p-2">
          <Input
            value={message}
            aria-label="Stash message"
            placeholder="Stash message"
            disabled={overview.clean}
            onChange={(event) => setMessage(event.target.value)}
            className="h-8 min-w-40 flex-1 border-slate-800 bg-slate-950 text-xs"
          />
          <label className="flex h-8 items-center gap-2 px-1 text-xs text-slate-300">
            <input
              type="checkbox"
              checked={includeUntracked}
              disabled={overview.clean}
              onChange={(event) => setIncludeUntracked(event.target.checked)}
              className="accent-sky-500"
            />
            Include untracked
          </label>
          <Button
            type="button"
            size="sm"
            disabled={controls.busy || overview.clean}
            tooltip={overview.clean ? "Nothing to stash." : undefined}
            onClick={() => void stash()}
            {...SUBMIT_SHORTCUT_ACTION_PROPS}
          >
            {controls.pendingAction === "stash-push" ? (
              <LoaderCircle className="size-4 animate-spin" />
            ) : (
              <Archive className="size-4" />
            )}
            Stash
          </Button>
        </div>
      </SubmitShortcut>
      {overview.stashes.length === 0 ? (
        <EmptyState icon={Archive} title="No stashes" size="compact" />
      ) : (
        <ul className="space-y-1">
          {overview.stashes.map((entry) => (
            <li
              key={entry.reference}
              className="flex min-w-0 items-center gap-3 rounded-lg border border-slate-800 bg-slate-950/40 px-3 py-2"
            >
              <Archive
                aria-hidden="true"
                className="size-4 shrink-0 text-slate-500"
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs text-slate-200">
                  {entry.message}
                </p>
                <p className="mt-0.5 truncate text-[11px] text-slate-500">
                  {entry.reference} · {formatWorkspaceGitTime(entry.createdAt)}
                </p>
              </div>
              <Button
                type="button"
                size="xs"
                variant="ghost"
                disabled={controls.busy}
                onClick={() =>
                  void controls.runAction("stash-apply", {
                    stashRef: entry.reference,
                  })
                }
              >
                <ArchiveRestore />
                Apply
              </Button>
              <Button
                type="button"
                size="xs"
                variant="ghost"
                disabled={controls.busy}
                onClick={() =>
                  void controls.runAction("stash-pop", {
                    stashRef: entry.reference,
                  })
                }
              >
                <Upload />
                Pop
              </Button>
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                aria-label={`Drop ${entry.reference}`}
                disabled={controls.busy}
                onClick={() => {
                  if (
                    window.confirm(
                      `Drop ${entry.reference}? This cannot be undone.`,
                    )
                  ) {
                    void controls.runAction("stash-drop", {
                      stashRef: entry.reference,
                    });
                  }
                }}
              >
                <Trash2 className="text-red-300" />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
