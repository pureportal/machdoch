import {
  GitCommitHorizontal,
  LoaderCircle,
  Settings2,
  Sparkles,
} from "lucide-react";
import { useState, type JSX } from "react";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@machdoch/client-ui/dropdown-menu";
import { Button } from "@machdoch/media-studio/tauri/ui/components/ui/button.js";
import { Input } from "@machdoch/media-studio/tauri/ui/components/ui/input.js";
import {
  SUBMIT_SHORTCUT_ACTION_PROPS,
  SubmitShortcut,
} from "@machdoch/media-studio/tauri/ui/components/ui/submit-shortcut.js";
import { Textarea } from "@machdoch/media-studio/tauri/ui/components/ui/textarea.js";
import type { WorkspaceGitOverview } from "../runtime";
import type { WorkspaceGitControls } from "./use-workspace-git";
import { generateWorkspaceGitCommitMessage } from "./workspace-tools-runtime";

interface CommitOptions {
  amend: boolean;
  signOff: boolean;
  push: boolean;
  coAuthors: string | null;
}

const commitLabel = (options: CommitOptions, stageFirst: boolean): string => {
  const verb = options.amend ? "Amend" : "Commit";
  const push = options.push
    ? options.amend
      ? " & force push"
      : " & push"
    : "";
  return `${stageFirst && !options.amend ? "Stage all & " : ""}${stageFirst ? verb.toLowerCase() : verb}${push}`;
};

export const WorkspaceGitCommitBox = ({
  overview,
  controls,
}: {
  overview: WorkspaceGitOverview;
  controls: WorkspaceGitControls;
}): JSX.Element => {
  const [message, setMessage] = useState("");
  const [options, setOptions] = useState<CommitOptions>({
    amend: false,
    signOff: false,
    push: false,
    coAuthors: null,
  });
  const [drafting, setDrafting] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);
  const committing = controls.pendingAction === "commit";
  const stageFirst = overview.stagedCount === 0;
  const unavailable =
    overview.conflictedCount > 0
      ? "Resolve conflicts before committing."
      : null;
  const needsMessage = !options.amend && !message.trim();

  const setOption = <K extends keyof CommitOptions>(
    key: K,
    value: CommitOptions[K],
  ): void => setOptions((current) => ({ ...current, [key]: value }));

  const draftMessage = async (): Promise<void> => {
    setDrafting(true);
    setDraftError(null);
    try {
      setMessage(
        await generateWorkspaceGitCommitMessage(
          overview.workspaceRoot,
          overview.repositoryRoot,
        ),
      );
    } catch (error) {
      setDraftError(error instanceof Error ? error.message : String(error));
    } finally {
      setDrafting(false);
    }
  };

  const commit = async (): Promise<void> => {
    if (
      options.amend &&
      options.push &&
      !window.confirm(
        "Amend the last commit and force push? The remote commit is replaced.",
      )
    ) {
      return;
    }
    if (
      stageFirst &&
      !options.amend &&
      !(await controls.runAction("stage-all"))
    )
      return;
    const committed = await controls.runAction("commit", {
      message,
      amend: options.amend,
      signOff: options.signOff,
      pushAfterCommit: options.push,
      force: options.amend && options.push,
      coAuthors: options.coAuthors?.split(/[,\n]/u) ?? [],
    });
    if (committed) {
      setMessage("");
      setOption("amend", false);
    }
  };

  return (
    <SubmitShortcut asChild>
      <div className="grid gap-2 rounded-lg border border-slate-800 bg-slate-950/50 p-2">
        <Textarea
          value={message}
          aria-label="Commit message"
          placeholder={
            options.amend
              ? "Keep the last message"
              : `Message (${overview.branch || "HEAD"})`
          }
          rows={2}
          disabled={unavailable !== null}
          onChange={(event) => setMessage(event.target.value)}
          className="min-h-14 resize-y border-slate-800 bg-slate-950 text-xs"
        />
        {options.coAuthors !== null ? (
          <Input
            value={options.coAuthors}
            aria-label="Co-authors"
            placeholder="Name <email>, …"
            onChange={(event) => setOption("coAuthors", event.target.value)}
            className="h-7 border-slate-800 bg-slate-950 text-xs"
          />
        ) : null}
        {draftError ? (
          <p role="alert" className="text-[11px] text-red-300">
            {draftError}
          </p>
        ) : null}
        <div className="flex items-center gap-1">
          <Button
            type="button"
            size="sm"
            className="flex-1"
            disabled={controls.busy || unavailable !== null || needsMessage}
            tooltip={unavailable ?? undefined}
            onClick={() => void commit()}
            {...SUBMIT_SHORTCUT_ACTION_PROPS}
          >
            {committing ? (
              <LoaderCircle className="size-4 animate-spin" />
            ) : (
              <GitCommitHorizontal className="size-4" />
            )}
            {commitLabel(options, stageFirst)}
          </Button>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label="Draft commit message"
            tooltip={
              stageFirst ? "Stage changes first." : "Draft commit message"
            }
            disabled={drafting || stageFirst || unavailable !== null}
            onClick={() => void draftMessage()}
          >
            {drafting ? (
              <LoaderCircle className="animate-spin" />
            ) : (
              <Sparkles />
            )}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label="Commit options"
              >
                <Settings2 />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuCheckboxItem
                checked={options.amend}
                onCheckedChange={(checked) =>
                  setOption("amend", checked === true)
                }
              >
                Amend last commit
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem
                checked={options.push}
                onCheckedChange={(checked) =>
                  setOption("push", checked === true)
                }
              >
                Push after commit
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem
                checked={options.signOff}
                onCheckedChange={(checked) =>
                  setOption("signOff", checked === true)
                }
              >
                Sign off
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem
                checked={options.coAuthors !== null}
                onCheckedChange={(checked) =>
                  setOption("coAuthors", checked === true ? "" : null)
                }
              >
                Co-authors
              </DropdownMenuCheckboxItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </SubmitShortcut>
  );
};
