import { File } from "lucide-react";
import { useEffect, useRef, useState, type JSX } from "react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@machdoch/media-studio/tauri/ui/components/ui/dialog.js";
import { cn } from "@machdoch/media-studio/tauri/ui/lib/utils.js";
import type { WorkspaceFileMatch } from "@machdoch/fleet-protocol/workspace-contract";
import {
  parseQuickOpenQuery,
  highlightSegments,
} from "./workspace-quick-open-model";
import { searchWorkspaceFiles } from "./workspace-tools-runtime";

export const WorkspaceQuickOpen = ({
  workspaceRoot,
  open,
  onOpenChange,
  onOpenFile,
}: {
  workspaceRoot: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenFile: (path: string, line?: number) => void;
}): JSX.Element => {
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<WorkspaceFileMatch[]>([]);
  const [active, setActive] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);
  const { pattern, line } = parseQuickOpenQuery(query);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setMatches([]);
      setError(null);
      return;
    }
    const request = ++requestRef.current;
    void searchWorkspaceFiles(workspaceRoot, pattern)
      .then((result) => {
        if (request !== requestRef.current) return;
        setMatches(result.matches);
        setActive(0);
        setError(null);
      })
      .catch((failure: unknown) => {
        if (request !== requestRef.current) return;
        setError(failure instanceof Error ? failure.message : String(failure));
      });
  }, [open, pattern, workspaceRoot]);

  const choose = (match: WorkspaceFileMatch | undefined): void => {
    if (!match) return;
    onOpenChange(false);
    onOpenFile(match.path, line);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        aria-describedby={undefined}
        className="top-[12%] flex max-h-[70dvh] w-[min(40rem,calc(100vw-2rem))] max-w-none translate-y-0 flex-col gap-0 overflow-hidden rounded-xl border-slate-800 bg-slate-950 p-0 text-slate-100 sm:max-w-none"
      >
        <DialogTitle className="sr-only">Go to file</DialogTitle>
        <input
          autoFocus
          value={query}
          aria-label="File name"
          placeholder="File name, then :line"
          className="h-11 shrink-0 border-b border-slate-800 bg-transparent px-4 text-sm outline-none placeholder:text-slate-600"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setActive((current) => Math.min(current + 1, matches.length - 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setActive((current) => Math.max(current - 1, 0));
            } else if (event.key === "Enter") {
              event.preventDefault();
              choose(matches[active]);
            }
          }}
        />
        {error ? (
          <p className="px-4 py-3 text-xs text-red-300">{error}</p>
        ) : null}
        <ul
          role="listbox"
          aria-label="Files"
          className="min-h-0 overflow-auto py-1"
        >
          {matches.map((match, index) => {
            const separator = match.path.lastIndexOf("/");
            return (
              <li
                key={match.path}
                role="option"
                aria-selected={index === active}
              >
                <button
                  type="button"
                  className={cn(
                    "flex w-full items-center gap-2 px-4 py-1.5 text-left text-xs",
                    index === active
                      ? "bg-sky-500/15 text-slate-100"
                      : "text-slate-400 hover:bg-slate-900",
                  )}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => choose(match)}
                >
                  <File className="size-3.5 shrink-0 text-slate-500" />
                  <span className="min-w-0 truncate">
                    {highlightSegments(
                      match.path,
                      match.positions,
                      separator + 1,
                    ).map((segment, part) => (
                      <span
                        key={part}
                        className={cn(
                          segment.directory && "text-slate-500",
                          segment.highlighted && "font-semibold text-sky-300",
                        )}
                      >
                        {segment.text}
                      </span>
                    ))}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </DialogContent>
    </Dialog>
  );
};
