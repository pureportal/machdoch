import {
  Check,
  FolderOpen,
  FolderPlus,
  LockKeyhole,
  Search,
  X,
} from "lucide-react";
import {
  useMemo,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
} from "react";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../../components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../../components/ui/tooltip";
import { cn } from "../../lib/utils";
import { getWorkspaceLabel } from "../_helpers/session-shell";

export interface WorkspacePickerProps {
  currentWorkspace: string | null;
  workspaceLabel: string;
  recentWorkspaces: string[];
  hasActiveWorkspace: boolean;
  workspaceLocked: boolean;
  allowNotSet?: boolean;
  buttonAriaLabel?: string;
  buttonClassName?: string;
  onSelectWorkspace: (workspace: string | null) => void;
  onRemoveWorkspace: (workspace: string) => void;
  onChooseNewWorkspace: () => Promise<void>;
}

const createWorkspaceKey = (workspace: string): string => {
  return workspace.trim().replace(/\\/gu, "/").toLowerCase();
};

type WorkspaceSearchEntry =
  | {
      type: "not-set";
      key: "not-set";
      label: "Not Set";
      path: null;
      workspace: null;
      order: number;
    }
  | {
      type: "workspace";
      key: string;
      label: string;
      path: string;
      workspace: string;
      order: number;
    };

type RankedWorkspaceSearchEntry = WorkspaceSearchEntry & { score: number };

const normalizeWorkspaceSearchText = (value: string): string => {
  return value
    .trim()
    .replace(/\\/gu, "/")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
};

const tokenizeWorkspaceSearchText = (value: string): string[] => {
  const normalized = normalizeWorkspaceSearchText(value);
  return normalized ? normalized.split(" ") : [];
};

const scoreNormalizedWorkspaceCandidate = (
  normalizedCandidate: string,
  normalizedQuery: string,
  tokens: readonly string[],
  labelBonus: number,
): number => {
  if (!normalizedCandidate) {
    return 0;
  }

  const words = normalizedCandidate.split(" ");
  let score = 0;

  for (const token of tokens) {
    if (normalizedCandidate === token) {
      score += 500;
      continue;
    }

    if (normalizedCandidate.startsWith(token)) {
      score += 420;
      continue;
    }

    if (words.includes(token)) {
      score += 360;
      continue;
    }

    if (words.some((word) => word.startsWith(token))) {
      score += 300;
      continue;
    }

    const tokenIndex = normalizedCandidate.indexOf(token);

    if (tokenIndex < 0) {
      return 0;
    }

    score += 160 - Math.min(tokenIndex, 100);
  }

  if (normalizedCandidate === normalizedQuery) {
    return score + 800 + labelBonus;
  }

  if (normalizedCandidate.startsWith(normalizedQuery)) {
    return score + 620 + labelBonus;
  }

  const phraseIndex = normalizedCandidate.indexOf(normalizedQuery);

  if (phraseIndex >= 0) {
    return score + 420 - Math.min(phraseIndex, 100) + labelBonus;
  }

  return score + labelBonus;
};

const scoreWorkspaceSearchEntry = (
  entry: WorkspaceSearchEntry,
  searchText: string,
): number => {
  const normalizedQuery = normalizeWorkspaceSearchText(searchText);
  const tokens = tokenizeWorkspaceSearchText(searchText);

  if (!normalizedQuery || tokens.length === 0) {
    return 0;
  }

  const labelScore = scoreNormalizedWorkspaceCandidate(
    normalizeWorkspaceSearchText(entry.label),
    normalizedQuery,
    tokens,
    120,
  );
  const pathScore = entry.path
    ? scoreNormalizedWorkspaceCandidate(
        normalizeWorkspaceSearchText(entry.path),
        normalizedQuery,
        tokens,
        0,
      )
    : 0;

  return Math.max(labelScore, pathScore);
};

const createWorkspaceSearchEntries = (
  allowNotSet: boolean,
  recentWorkspaces: readonly string[],
): WorkspaceSearchEntry[] => {
  const entries: WorkspaceSearchEntry[] = [];

  if (allowNotSet) {
    entries.push({
      type: "not-set",
      key: "not-set",
      label: "Not Set",
      path: null,
      workspace: null,
      order: entries.length,
    });
  }

  for (const workspace of recentWorkspaces) {
    entries.push({
      type: "workspace",
      key: createWorkspaceKey(workspace),
      label: getWorkspaceLabel(workspace),
      path: workspace,
      workspace,
      order: entries.length,
    });
  }

  return entries;
};

const WorkspaceButtonContent = ({
  hasActiveWorkspace,
  workspaceLocked,
  workspaceLabel,
}: Pick<
  WorkspacePickerProps,
  "hasActiveWorkspace" | "workspaceLocked" | "workspaceLabel"
>): JSX.Element => (
  <>
    {workspaceLocked ? (
      <LockKeyhole className="mr-2 h-3.5 w-3.5 text-slate-500" />
    ) : (
      <FolderOpen
        className={cn(
          "mr-2 h-3.5 w-3.5",
          hasActiveWorkspace ? "text-sky-300" : "text-slate-500",
        )}
      />
    )}
    {workspaceLabel}
  </>
);

export const WorkspacePicker = ({
  currentWorkspace,
  workspaceLabel,
  recentWorkspaces,
  hasActiveWorkspace,
  workspaceLocked,
  allowNotSet = true,
  buttonAriaLabel,
  buttonClassName,
  onSelectWorkspace,
  onRemoveWorkspace,
  onChooseNewWorkspace,
}: WorkspacePickerProps): JSX.Element => {
  const [open, setOpen] = useState(false);
  const [workspaceSearchText, setWorkspaceSearchText] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const currentWorkspaceKey = currentWorkspace
    ? createWorkspaceKey(currentWorkspace)
    : null;
  const workspaceSearchEntries = useMemo(
    () => createWorkspaceSearchEntries(allowNotSet, recentWorkspaces),
    [allowNotSet, recentWorkspaces],
  );
  const rankedWorkspaceSearchEntries = useMemo<
    RankedWorkspaceSearchEntry[]
  >(() => {
    if (!workspaceSearchText.trim()) {
      return workspaceSearchEntries.map((entry) => ({ ...entry, score: 0 }));
    }

    return workspaceSearchEntries
      .map((entry) => ({
        ...entry,
        score: scoreWorkspaceSearchEntry(entry, workspaceSearchText),
      }))
      .filter((entry) => entry.score > 0)
      .sort((firstEntry, secondEntry) => {
        const scoreDifference = secondEntry.score - firstEntry.score;

        if (scoreDifference !== 0) {
          return scoreDifference;
        }

        return firstEntry.order - secondEntry.order;
      });
  }, [workspaceSearchEntries, workspaceSearchText]);
  const resolvedButtonClassName = buttonClassName
    ? cn(
        buttonClassName,
        hasActiveWorkspace &&
          "border-sky-500/20 bg-sky-500/10 text-sky-100 hover:bg-sky-500/15",
      )
    : cn(
        "h-8 rounded-full border-slate-800 bg-slate-950/70 px-3 text-xs font-medium text-slate-300 shadow-none hover:bg-slate-900 hover:text-slate-100",
        "app-composer-toolbar-pill",
        hasActiveWorkspace &&
          "border-sky-500/20 bg-sky-500/10 text-sky-100 hover:bg-sky-500/15",
      );

  const handleOpenChange = (nextOpen: boolean): void => {
    setOpen(nextOpen);

    if (nextOpen) {
      setWorkspaceSearchText("");
    }
  };

  const selectWorkspaceEntry = (entry: WorkspaceSearchEntry): void => {
    setOpen(false);
    setWorkspaceSearchText("");
    onSelectWorkspace(entry.workspace);
  };

  const handleSearchKeyDown = (
    event: KeyboardEvent<HTMLInputElement>,
  ): void => {
    if (event.key !== "Enter" || !workspaceSearchText.trim()) {
      return;
    }

    const bestMatch = rankedWorkspaceSearchEntries[0];

    if (!bestMatch) {
      return;
    }

    event.preventDefault();
    selectWorkspaceEntry(bestMatch);
  };

  if (workspaceLocked) {
    return (
      <Button
        type="button"
        variant="outline"
        aria-label={buttonAriaLabel}
        title="Workspace locked after first message"
        disabled
        className={cn(
          resolvedButtonClassName,
          "cursor-not-allowed opacity-75 disabled:opacity-75",
        )}
      >
        <WorkspaceButtonContent
          hasActiveWorkspace={hasActiveWorkspace}
          workspaceLocked={workspaceLocked}
          workspaceLabel={workspaceLabel}
        />
      </Button>
    );
  }

  if (recentWorkspaces.length === 0 && (!hasActiveWorkspace || !allowNotSet)) {
    return (
      <Button
        type="button"
        variant="outline"
        aria-label={buttonAriaLabel}
        onClick={() => {
          void onChooseNewWorkspace();
        }}
        className={resolvedButtonClassName}
      >
        <WorkspaceButtonContent
          hasActiveWorkspace={hasActiveWorkspace}
          workspaceLocked={workspaceLocked}
          workspaceLabel={workspaceLabel}
        />
      </Button>
    );
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          aria-label={buttonAriaLabel}
          className={resolvedButtonClassName}
        >
          <WorkspaceButtonContent
            hasActiveWorkspace={hasActiveWorkspace}
            workspaceLocked={workspaceLocked}
            workspaceLabel={workspaceLabel}
          />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-96 rounded-3xl border-slate-800 bg-slate-950/95 p-4 shadow-2xl backdrop-blur-xl"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          searchInputRef.current?.focus();
        }}
      >
        <div className="grid gap-3">
          <div className="grid gap-1">
            <p className="text-xs font-semibold tracking-[0.18em] text-slate-500 uppercase">
              Workspaces
            </p>
            <p className="text-sm leading-5 text-slate-400">
              Workspace target for this session.
            </p>
          </div>

          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-slate-500" />
            <Input
              ref={searchInputRef}
              type="search"
              value={workspaceSearchText}
              onChange={(event) => setWorkspaceSearchText(event.target.value)}
              onKeyDown={handleSearchKeyDown}
              aria-label="Search workspaces"
              placeholder="Search workspaces"
              autoComplete="off"
              spellCheck={false}
              className="h-10 rounded-2xl border-slate-800 bg-slate-900/70 pr-3 pl-9 text-sm text-slate-100 shadow-none placeholder:text-slate-500 focus-visible:border-sky-400/50 focus-visible:ring-sky-400/30"
            />
          </div>

          <div className="grid max-h-72 gap-2 overflow-y-auto pr-1">
            {rankedWorkspaceSearchEntries.length === 0 ? (
              <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-3 text-sm text-slate-500">
                No matching workspaces
              </div>
            ) : null}

            {rankedWorkspaceSearchEntries.map((entry) => {
              if (entry.type === "not-set") {
                return (
                  <button
                    key={entry.key}
                    type="button"
                    onClick={() => selectWorkspaceEntry(entry)}
                    className={cn(
                      "flex min-w-0 items-center gap-3 rounded-2xl border p-3 text-left outline-none transition-all focus-visible:ring-2 focus-visible:ring-sky-400/60 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950",
                      currentWorkspaceKey === null
                        ? "border-sky-500/30 bg-sky-500/10 text-sky-100"
                        : "border-slate-800 bg-slate-900/70 text-slate-300 hover:border-slate-700 hover:bg-slate-900 hover:text-slate-100",
                    )}
                  >
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-slate-800 bg-slate-950 text-slate-500">
                      <X className="h-4 w-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-slate-100">
                        Not Set
                      </p>
                    </div>
                    {currentWorkspaceKey === null ? (
                      <Check className="h-4 w-4 shrink-0 text-sky-300" />
                    ) : null}
                  </button>
                );
              }

              const workspaceKey = entry.key;
              const workspaceLabel = entry.label;
              const workspace = entry.workspace;
              const selected = currentWorkspaceKey === workspaceKey;

              return (
                <div
                  key={workspaceKey}
                  className={cn(
                    "group grid w-full grid-cols-[minmax(0,1fr)_2rem] items-center gap-1 rounded-2xl border p-1.5 transition-all",
                    selected
                      ? "border-sky-500/30 bg-sky-500/10 text-sky-100"
                      : "border-slate-800 bg-slate-900/70 text-slate-300 hover:border-slate-700 hover:bg-slate-900 hover:text-slate-100",
                  )}
                >
                  <button
                    type="button"
                    title={workspace}
                    onClick={() => selectWorkspaceEntry(entry)}
                    className="flex min-w-0 items-center gap-3 rounded-xl px-1.5 py-1 text-left outline-none transition-colors hover:bg-white/[0.03] focus-visible:ring-2 focus-visible:ring-sky-400/60 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950"
                  >
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-slate-800 bg-slate-950 text-sky-300">
                      <FolderOpen className="h-4 w-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-slate-100">
                        {workspaceLabel}
                      </p>
                      <p className="truncate text-xs leading-5 text-slate-500">
                        {workspace}
                      </p>
                    </div>
                    {selected ? (
                      <Check className="h-4 w-4 shrink-0 text-sky-300" />
                    ) : null}
                  </button>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        aria-label={`Remove ${workspaceLabel} from workspace list`}
                        onClick={() => {
                          onRemoveWorkspace(workspace);
                        }}
                        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl text-slate-500 opacity-70 outline-none transition-colors hover:bg-rose-500/10 hover:text-rose-200 hover:opacity-100 focus-visible:bg-rose-500/10 focus-visible:text-rose-200 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-rose-400/60 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="left">Remove from list</TooltipContent>
                  </Tooltip>
                </div>
              );
            })}
          </div>

          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setOpen(false);
              void onChooseNewWorkspace();
            }}
            className="h-10 justify-start rounded-2xl border-slate-800 bg-slate-950/70 px-3 text-sm text-slate-300 shadow-none hover:bg-slate-900 hover:text-slate-100"
          >
            <FolderPlus className="mr-2 h-4 w-4 text-slate-500" />
            Choose new workspace folder
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
};
