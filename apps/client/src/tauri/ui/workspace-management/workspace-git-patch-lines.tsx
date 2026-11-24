import { Minus, Plus, Undo2 } from "lucide-react";
import { useMemo, useState, type JSX } from "react";
import { Button } from "@machdoch/media-studio/tauri/ui/components/ui/button.js";
import { cn } from "@machdoch/media-studio/tauri/ui/lib/utils.js";
import type { WorkspaceGitActionOptions, WorkspaceGitPatch } from "../runtime";
import {
  buildPartialPatch,
  hunkLineKeys,
  parseFilePatch,
  patchLineKey,
  type ParsedFilePatch,
} from "./workspace-git-partial-patch";

export type PatchLineAction = "stage" | "unstage" | "discard";

export type ApplyPatchLines = (
  options: Pick<WorkspaceGitActionOptions, "patch" | "patchTarget" | "reverse">,
  action: PatchLineAction,
) => Promise<boolean>;

const ACTION_OPTIONS: Record<
  PatchLineAction,
  { target: "index" | "worktree"; reverse: boolean; label: string }
> = {
  stage: { target: "index", reverse: false, label: "Stage" },
  unstage: { target: "index", reverse: true, label: "Unstage" },
  discard: { target: "worktree", reverse: true, label: "Discard" },
};

const ACTION_ICONS = { stage: Plus, unstage: Minus, discard: Undo2 } as const;

const actionsFor = (kind: WorkspaceGitPatch["kind"]): PatchLineAction[] =>
  kind === "staged" ? ["unstage"] : ["stage", "discard"];

interface NumberedLine {
  key: string;
  marker: " " | "+" | "-";
  text: string;
  oldLine: number | null;
  newLine: number | null;
}

const numberLines = (patch: ParsedFilePatch): NumberedLine[][] =>
  patch.hunks.map((hunk, hunkIndex) => {
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;
    return hunk.lines.map((line, lineIndex) => ({
      key: patchLineKey(hunkIndex, lineIndex),
      marker: line.marker,
      text: line.text,
      oldLine: line.marker === "+" ? null : oldLine++,
      newLine: line.marker === "-" ? null : newLine++,
    }));
  });

const LINE_TONES = {
  "+": "bg-emerald-500/10 text-emerald-200",
  "-": "bg-red-500/10 text-rose-200",
  " ": "text-slate-400",
} as const;

export const canSelectPatchLines = (patch: WorkspaceGitPatch): boolean =>
  (patch.kind === "staged" || patch.kind === "unstaged") &&
  !patch.binary &&
  !patch.truncated &&
  parseFilePatch(patch.content) !== null;

export const WorkspaceGitPatchLines = ({
  patch,
  busy,
  onApply,
}: {
  patch: WorkspaceGitPatch;
  busy: boolean;
  onApply: ApplyPatchLines;
}): JSX.Element | null => {
  const parsed = useMemo(() => parseFilePatch(patch.content), [patch.content]);
  const hunks = useMemo(() => (parsed ? numberLines(parsed) : []), [parsed]);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  if (!parsed) return null;
  const actions = actionsFor(patch.kind);

  const apply = async (
    keys: ReadonlySet<string>,
    action: PatchLineAction,
  ): Promise<void> => {
    const options = ACTION_OPTIONS[action];
    const partial = buildPartialPatch(parsed, keys, {
      reverse: options.reverse,
    });
    if (!partial) return;
    if (
      action === "discard" &&
      !window.confirm("Discard the selected changes? This cannot be undone.")
    ) {
      return;
    }
    if (
      await onApply(
        {
          patch: partial,
          patchTarget: options.target,
          reverse: options.reverse,
        },
        action,
      )
    ) {
      setSelected(new Set());
    }
  };

  const toggle = (key: string): void =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <div className="font-mono text-[11px] leading-5">
      {selected.size > 0 ? (
        <div className="sticky top-0 z-10 flex items-center gap-1 border-b border-slate-800 bg-slate-950 px-2 py-1 font-sans">
          <span className="flex-1 text-[11px] text-slate-400">
            {selected.size} {selected.size === 1 ? "line" : "lines"}
          </span>
          {actions.map((action) => {
            const Icon = ACTION_ICONS[action];
            return (
              <Button
                key={action}
                type="button"
                size="xs"
                variant={action === "discard" ? "ghost" : "outline"}
                disabled={busy}
                onClick={() => void apply(selected, action)}
              >
                <Icon />
                {ACTION_OPTIONS[action].label} lines
              </Button>
            );
          })}
          <Button
            type="button"
            size="xs"
            variant="ghost"
            onClick={() => setSelected(new Set())}
          >
            Clear
          </Button>
        </div>
      ) : null}
      <table className="min-w-full border-collapse">
        {hunks.map((lines, hunkIndex) => {
          const hunk = parsed.hunks[hunkIndex];
          return (
            <tbody key={`${hunk?.oldStart}:${hunk?.newStart}:${hunkIndex}`}>
              <tr className="group bg-sky-500/10 text-sky-300">
                <td colSpan={3} className="px-2">
                  <div className="flex min-h-6 items-center gap-1">
                    <span className="min-w-0 flex-1 truncate whitespace-pre">
                      {`@@ -${hunk?.oldStart} +${hunk?.newStart} @@${hunk?.section ?? ""}`}
                    </span>
                    {actions.map((action) => {
                      const Icon = ACTION_ICONS[action];
                      return (
                        <Button
                          key={action}
                          type="button"
                          size="xs"
                          variant="ghost"
                          disabled={busy}
                          className="h-5 font-sans text-[11px] text-slate-300"
                          onClick={() =>
                            void apply(
                              new Set(hunkLineKeys(parsed, hunkIndex)),
                              action,
                            )
                          }
                        >
                          <Icon />
                          {ACTION_OPTIONS[action].label} hunk
                        </Button>
                      );
                    })}
                  </div>
                </td>
              </tr>
              {lines.map((line) => {
                const changed = line.marker !== " ";
                const checked = selected.has(line.key);
                return (
                  <tr
                    key={line.key}
                    aria-selected={changed ? checked : undefined}
                    onClick={changed ? () => toggle(line.key) : undefined}
                    className={cn(
                      LINE_TONES[line.marker],
                      changed && "cursor-pointer hover:brightness-125",
                      checked &&
                        "outline outline-1 -outline-offset-1 outline-sky-500/70",
                    )}
                  >
                    <td className="w-10 min-w-10 select-none border-r border-slate-800 pr-2 text-right text-slate-600 tabular-nums">
                      {line.oldLine ?? ""}
                    </td>
                    <td className="w-10 min-w-10 select-none border-r border-slate-800 pr-2 text-right text-slate-600 tabular-nums">
                      {line.newLine ?? ""}
                    </td>
                    <td className="whitespace-pre px-3">
                      {`${line.marker}${line.text}` || " "}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          );
        })}
      </table>
    </div>
  );
};
