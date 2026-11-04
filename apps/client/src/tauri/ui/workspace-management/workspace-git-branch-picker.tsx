import { Check, ChevronsUpDown, GitBranch, Layers, Plus } from "lucide-react";
import { useRef, useState, type JSX } from "react";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@machdoch/media-studio/tauri/ui/components/ui/command.js";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@machdoch/media-studio/tauri/ui/components/ui/popover.js";
import { cn } from "@machdoch/media-studio/tauri/ui/lib/utils.js";
import type { WorkspaceGitOverview } from "../runtime";
import type { WorkspaceGitControls } from "./use-workspace-git";

export const WorkspaceGitBranchPicker = ({
  controls,
  overview,
  className,
}: {
  controls: WorkspaceGitControls;
  overview: WorkspaceGitOverview;
  className?: string;
}): JSX.Element => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const current = overview.detached ? "" : overview.branch;
  const draftName = query.trim();
  const canCreate =
    draftName.length > 0 &&
    !overview.localBranches.some((branch) => branch.name === draftName);

  const choose = (run: () => Promise<boolean>): void => {
    setOpen(false);
    setQuery("");
    void run();
  };

  return (
    <Popover
      modal
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) setQuery("");
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Branch ${overview.branch || "detached HEAD"}`}
          disabled={controls.busy}
          className={cn(
            "flex h-8 min-w-0 max-w-full items-center gap-2 rounded-md border border-slate-700 bg-slate-950 px-2.5 text-xs text-slate-100 outline-none hover:border-slate-500 focus-visible:border-sky-400 disabled:opacity-50",
            className,
          )}
        >
          <GitBranch
            aria-hidden="true"
            className="size-3.5 shrink-0 text-sky-300"
          />
          <span className="min-w-0 truncate font-medium">
            {overview.detached
              ? `${overview.branch} (detached)`
              : overview.branch}
          </span>
          <ChevronsUpDown
            aria-hidden="true"
            className="size-3 shrink-0 text-slate-500"
          />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[min(24rem,calc(100vw-2rem))] p-0"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          inputRef.current?.focus();
        }}
      >
        <Command>
          <CommandInput
            ref={inputRef}
            value={query}
            onValueChange={setQuery}
            aria-label="Search or create branch"
            placeholder="Switch or create branch…"
          />
          <CommandList>
            <CommandEmpty>No branches</CommandEmpty>
            {canCreate ? (
              <CommandGroup heading="Create">
                <CommandItem
                  value={`create:${draftName}`}
                  keywords={[draftName]}
                  onSelect={() =>
                    choose(() =>
                      controls.runAction("create-branch", {
                        branchName: draftName,
                      }),
                    )
                  }
                >
                  <Plus className="size-3.5" />
                  <span className="min-w-0 flex-1 truncate">
                    Create <strong>{draftName}</strong>
                  </span>
                </CommandItem>
                {current ? (
                  <CommandItem
                    value={`stack:${draftName}`}
                    keywords={[draftName]}
                    onSelect={() =>
                      choose(() =>
                        controls.runAction("create-stacked-branch", {
                          branchName: draftName,
                        }),
                      )
                    }
                  >
                    <Layers className="size-3.5 text-violet-300" />
                    <span className="min-w-0 flex-1 truncate">
                      Create <strong>{draftName}</strong> stacked on {current}
                    </span>
                  </CommandItem>
                ) : null}
              </CommandGroup>
            ) : null}
            <CommandGroup heading="Local">
              {overview.localBranches.map((branch) => (
                <CommandItem
                  key={branch.name}
                  value={`local:${branch.name}`}
                  keywords={[branch.name]}
                  disabled={branch.name === current}
                  onSelect={() =>
                    choose(() =>
                      controls.runAction("checkout", {
                        branchName: branch.name,
                      }),
                    )
                  }
                >
                  <GitBranch className="size-3.5 text-slate-500" />
                  <span className="min-w-0 flex-1 truncate">{branch.name}</span>
                  {branch.parent ? (
                    <Layers
                      aria-label="Stacked"
                      className="size-3 text-violet-300/70"
                    />
                  ) : null}
                  {branch.name === current ? (
                    <Check className="size-3.5 text-sky-400" />
                  ) : null}
                </CommandItem>
              ))}
            </CommandGroup>
            {overview.remoteBranches.length > 0 ? (
              <CommandGroup heading="Remote">
                {overview.remoteBranches.map((branch) => (
                  <CommandItem
                    key={branch.name}
                    value={`remote:${branch.name}`}
                    keywords={[branch.name]}
                    onSelect={() =>
                      choose(() =>
                        controls.runAction("checkout-remote", {
                          branchName: branch.name,
                        }),
                      )
                    }
                  >
                    <GitBranch className="size-3.5 text-slate-600" />
                    <span className="min-w-0 flex-1 truncate text-slate-400">
                      {branch.name}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
};
