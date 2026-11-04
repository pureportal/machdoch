import { CopyContextMenu } from "@machdoch/media-studio/tauri/ui/components/ui/copy-context-menu.js";
import { Network, Plus, Trash2 } from "lucide-react";
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

export const WorkspaceGitRemotes = ({
  controls,
  overview,
}: {
  controls: WorkspaceGitControls;
  overview: WorkspaceGitOverview;
}): JSX.Element => {
  const [remoteName, setRemoteName] = useState("");
  const [remoteUrl, setRemoteUrl] = useState("");
  const addRemote = async (): Promise<void> => {
    if (await controls.runAction("add-remote", { remoteName, remoteUrl })) {
      setRemoteName("");
      setRemoteUrl("");
    }
  };
  return (
    <div className="space-y-3">
      <SubmitShortcut asChild>
        <div className="grid gap-2 rounded-lg border border-slate-800 bg-slate-950/50 p-2 sm:grid-cols-[10rem_minmax(0,1fr)_auto]">
          <Input
            value={remoteName}
            aria-label="Remote name"
            placeholder="Name"
            onChange={(event) => setRemoteName(event.target.value)}
            className="h-8 border-slate-800 bg-slate-950 text-xs"
          />
          <Input
            value={remoteUrl}
            aria-label="Remote URL"
            placeholder="Remote URL"
            onChange={(event) => setRemoteUrl(event.target.value)}
            className="h-8 border-slate-800 bg-slate-950 text-xs"
          />
          <Button
            type="button"
            size="sm"
            disabled={controls.busy || !remoteName.trim() || !remoteUrl.trim()}
            onClick={() => void addRemote()}
            {...SUBMIT_SHORTCUT_ACTION_PROPS}
          >
            <Plus className="size-4" />
            Add
          </Button>
        </div>
      </SubmitShortcut>
      {overview.remotes.length === 0 ? (
        <EmptyState icon={Network} title="No remotes" size="compact" />
      ) : (
        <ul className="space-y-1">
          {overview.remotes.map((remote) => (
            <li
              key={remote.name}
              className="flex min-w-0 items-center gap-3 rounded-lg border border-slate-800 bg-slate-950/40 px-3 py-2"
            >
              <Network
                aria-hidden="true"
                className="size-4 shrink-0 text-slate-500"
              />
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium text-slate-200">
                  {remote.name}
                </p>
                <CopyContextMenu
                  values={[
                    { label: "Copy fetch URL", value: remote.fetchUrl ?? "" },
                    { label: "Copy push URL", value: remote.pushUrl ?? "" },
                  ]}
                >
                  <p className="mt-0.5 break-all font-mono text-[11px] text-slate-500">
                    {remote.fetchUrl ?? remote.pushUrl}
                  </p>
                </CopyContextMenu>
              </div>
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                aria-label={`Remove ${remote.name}`}
                disabled={controls.busy}
                onClick={() => {
                  if (window.confirm(`Remove Git remote ${remote.name}?`)) {
                    void controls.runAction("remove-remote", {
                      remoteName: remote.name,
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
