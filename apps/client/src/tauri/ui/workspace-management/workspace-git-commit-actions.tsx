import { Cherry, Tag, TagsIcon, Undo2 } from "lucide-react";
import { useState, type JSX } from "react";
import { Button } from "@machdoch/media-studio/tauri/ui/components/ui/button.js";
import { Input } from "@machdoch/media-studio/tauri/ui/components/ui/input.js";
import type { WorkspaceGitGraphCommit } from "../runtime";
import type { WorkspaceGitControls } from "./use-workspace-git";

export const WorkspaceGitCommitActions = ({
  controls,
  commit,
  head,
}: {
  controls: WorkspaceGitControls;
  commit: WorkspaceGitGraphCommit;
  head: boolean;
}): JSX.Element => {
  const [tagName, setTagName] = useState<string | null>(null);
  const [pushTag, setPushTag] = useState(false);

  const createTag = async (): Promise<void> => {
    const name = tagName?.trim();
    if (!name) return;
    if (
      !(await controls.runAction("create-tag", {
        tagName: name,
        startPoint: commit.hash,
      }))
    ) {
      return;
    }
    if (pushTag) await controls.runAction("push-tag", { tagName: name });
    setTagName(null);
  };

  const deleteTag = (tag: string): void => {
    if (!window.confirm(`Delete tag ${tag}?`)) return;
    const remote = window.confirm(`Also delete ${tag} from the remote?`);
    void controls.runAction("delete-tag", { tagName: tag, remote });
  };

  return (
    <>
      {commit.refs
        .filter((reference) => reference.kind === "tag")
        .map((reference) => (
          <Button
            key={reference.name}
            type="button"
            size="xs"
            variant="ghost"
            disabled={controls.busy}
            onClick={() => deleteTag(reference.name)}
          >
            <TagsIcon />
            Delete {reference.name}
          </Button>
        ))}
      {head ? null : (
        <Button
          type="button"
          size="xs"
          variant="ghost"
          disabled={controls.busy}
          onClick={() =>
            void controls.runAction("cherry-pick", { commit: commit.hash })
          }
        >
          <Cherry />
          Cherry-pick
        </Button>
      )}
      <Button
        type="button"
        size="xs"
        variant="ghost"
        disabled={controls.busy}
        onClick={() => {
          if (
            window.confirm(`Create a commit that reverts ${commit.shortHash}?`)
          ) {
            void controls.runAction("revert", { commit: commit.hash });
          }
        }}
      >
        <Undo2 />
        Revert
      </Button>
      {tagName === null ? (
        <Button
          type="button"
          size="xs"
          variant="ghost"
          onClick={() => setTagName("")}
        >
          <Tag />
          Tag
        </Button>
      ) : (
        <form
          className="flex items-center gap-1"
          onSubmit={(event) => {
            event.preventDefault();
            void createTag();
          }}
        >
          <Input
            autoFocus
            value={tagName}
            aria-label="Tag name"
            placeholder="v1.2.0"
            onChange={(event) => setTagName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setTagName(null);
            }}
            className="h-6 w-28 border-slate-800 bg-slate-950 text-xs"
          />
          <label className="flex items-center gap-1 text-[11px] text-slate-400">
            <input
              type="checkbox"
              checked={pushTag}
              onChange={(event) => setPushTag(event.target.checked)}
            />
            Push
          </label>
          <Button
            type="submit"
            size="xs"
            disabled={controls.busy || !tagName.trim()}
          >
            Create
          </Button>
        </form>
      )}
    </>
  );
};
