import { GitPullRequest, LoaderCircle } from "lucide-react";
import { useState, type JSX } from "react";
import { Button } from "@machdoch/media-studio/tauri/ui/components/ui/button.js";
import { Input } from "@machdoch/media-studio/tauri/ui/components/ui/input.js";
import { Textarea } from "@machdoch/media-studio/tauri/ui/components/ui/textarea.js";
import type { WorkspaceGitOverview } from "../runtime";
import type { WorkspaceGitControls } from "./use-workspace-git";

export const WorkspaceGitPullRequestForm = ({
  controls,
  overview,
  template,
  onDone,
}: {
  controls: WorkspaceGitControls;
  overview: WorkspaceGitOverview;
  template: string | undefined;
  onDone: () => void;
}): JSX.Element => {
  const [title, setTitle] = useState(
    overview.recentCommits[0]?.subject ?? overview.branch,
  );
  const [body, setBody] = useState(template ?? "");
  const [baseBranch, setBaseBranch] = useState(overview.defaultBranch ?? "");
  const [draft, setDraft] = useState(false);
  const creating = controls.pendingAction === "create-pull-request";

  const create = async (): Promise<void> => {
    if (
      await controls.runAction("create-pull-request", {
        title,
        body,
        baseBranch,
        draft,
      })
    ) {
      onDone();
    }
  };

  return (
    <form
      aria-label="New pull request"
      className="grid gap-2 rounded-lg border border-slate-800 bg-slate-950/50 p-2"
      onSubmit={(event) => {
        event.preventDefault();
        void create();
      }}
    >
      <Input
        autoFocus
        value={title}
        aria-label="Title"
        onChange={(event) => setTitle(event.target.value)}
        className="h-8 border-slate-800 bg-slate-950 text-xs"
      />
      <Textarea
        value={body}
        aria-label="Description"
        rows={6}
        onChange={(event) => setBody(event.target.value)}
        className="resize-y border-slate-800 bg-slate-950 font-mono text-xs"
      />
      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
        <span>{overview.branch} →</span>
        <Input
          value={baseBranch}
          aria-label="Base branch"
          list="workspace-pull-request-bases"
          onChange={(event) => setBaseBranch(event.target.value)}
          className="h-7 w-40 border-slate-800 bg-slate-950 font-mono text-xs"
        />
        <datalist id="workspace-pull-request-bases">
          {overview.remoteBranches.map((branch) => (
            <option
              key={branch.name}
              value={branch.name.replace(/^[^/]+\//u, "")}
            />
          ))}
        </datalist>
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            checked={draft}
            onChange={(event) => setDraft(event.target.checked)}
          />
          Draft
        </label>
        <span className="flex-1" />
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={creating}
          onClick={onDone}
        >
          Cancel
        </Button>
        <Button
          type="submit"
          size="sm"
          disabled={
            controls.isActionBlocked("create-pull-request") || !title.trim()
          }
        >
          {creating ? (
            <LoaderCircle className="animate-spin" />
          ) : (
            <GitPullRequest />
          )}
          Create
        </Button>
      </div>
    </form>
  );
};
