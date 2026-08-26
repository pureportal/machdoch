import {
  Check,
  FolderOpen,
  FolderPlus,
  LockKeyhole,
  Search,
  X,
} from "lucide-react";
import { useMemo, useRef, useState, type JSX, type KeyboardEvent } from "react";
import { Button } from "../../components/ui/button";
import { EmptyState } from "../../components/ui/empty-state";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../../components/ui/popover";
import { SearchField } from "../../components/ui/search-field";
import {
  ControlTooltip,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../../components/ui/tooltip";
import { cn } from "../../lib/utils";

export interface WorkspaceSelectOption {
  id: string;
  label: string;
  path: string | null;
  icon?: "folder" | "not-set";
  removable?: boolean;
}

export interface WorkspaceSelectAction {
  label: string;
  onSelect: () => void | Promise<void>;
}

export interface WorkspaceSelectProps {
  selectedOptionId: string | null;
  options: readonly WorkspaceSelectOption[];
  buttonLabel: string;
  active: boolean;
  workspaceLocked?: boolean;
  buttonAriaLabel?: string;
  buttonClassName?: string;
  contentClassName?: string;
  description?: string;
  action?: WorkspaceSelectAction;
  selectActionOnTrigger?: boolean;
  onSelectOption: (option: WorkspaceSelectOption) => void;
  onRemoveOption?: (option: WorkspaceSelectOption) => void;
}

type RankedWorkspaceSelectOption = WorkspaceSelectOption & {
  order: number;
  score: number;
};

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

const scoreWorkspaceSelectOption = (
  option: WorkspaceSelectOption,
  searchText: string,
): number => {
  const normalizedQuery = normalizeWorkspaceSearchText(searchText);
  const tokens = tokenizeWorkspaceSearchText(searchText);

  if (!normalizedQuery || tokens.length === 0) {
    return 0;
  }

  const labelScore = scoreNormalizedWorkspaceCandidate(
    normalizeWorkspaceSearchText(option.label),
    normalizedQuery,
    tokens,
    120,
  );
  const pathScore = option.path
    ? scoreNormalizedWorkspaceCandidate(
        normalizeWorkspaceSearchText(option.path),
        normalizedQuery,
        tokens,
        0,
      )
    : 0;

  return Math.max(labelScore, pathScore);
};

const WorkspaceSelectButtonContent = ({
  buttonLabel,
  active,
  workspaceLocked,
}: Pick<
  WorkspaceSelectProps,
  "active" | "buttonLabel" | "workspaceLocked"
>): JSX.Element => (
  <>
    {workspaceLocked ? (
      <LockKeyhole className="h-3.5 w-3.5 text-slate-500" />
    ) : (
      <FolderOpen
        className={cn(
          "h-3.5 w-3.5",
          active ? "text-sky-300" : "text-slate-500",
        )}
      />
    )}
    <span className="min-w-0 flex-1 truncate text-left">{buttonLabel}</span>
  </>
);

export const WorkspaceSelect = ({
  selectedOptionId,
  options,
  buttonLabel,
  active,
  workspaceLocked = false,
  buttonAriaLabel,
  buttonClassName,
  contentClassName,
  description,
  action,
  selectActionOnTrigger = false,
  onSelectOption,
  onRemoveOption,
}: WorkspaceSelectProps): JSX.Element => {
  const [open, setOpen] = useState(false);
  const [workspaceSearchText, setWorkspaceSearchText] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const rankedOptions = useMemo<RankedWorkspaceSelectOption[]>(() => {
    const orderedOptions = options.map((option, order) => ({
      ...option,
      order,
      score: 0,
    }));

    if (!workspaceSearchText.trim()) {
      return orderedOptions;
    }

    return orderedOptions
      .map((option) => ({
        ...option,
        score: scoreWorkspaceSelectOption(option, workspaceSearchText),
      }))
      .filter((option) => option.score > 0)
      .sort((firstOption, secondOption) => {
        const scoreDifference = secondOption.score - firstOption.score;

        if (scoreDifference !== 0) {
          return scoreDifference;
        }

        return firstOption.order - secondOption.order;
      });
  }, [options, workspaceSearchText]);
  const resolvedButtonClassName = buttonClassName
    ? cn(
        buttonClassName,
        active &&
          "border-sky-500/20 bg-sky-500/10 text-sky-100 hover:bg-sky-500/15",
      )
    : cn(
        "app-composer-toolbar-pill h-8 rounded-full border-slate-800 bg-slate-950/70 px-3 text-xs font-medium text-slate-300 shadow-none hover:bg-slate-900 hover:text-slate-100",
        active &&
          "border-sky-500/20 bg-sky-500/10 text-sky-100 hover:bg-sky-500/15",
      );

  const handleOpenChange = (nextOpen: boolean): void => {
    setOpen(nextOpen);

    if (nextOpen) {
      setWorkspaceSearchText("");
    }
  };

  const selectOption = (option: WorkspaceSelectOption): void => {
    setOpen(false);
    setWorkspaceSearchText("");
    onSelectOption(option);
  };

  const selectAction = (): void => {
    if (!action) {
      return;
    }

    setOpen(false);
    void action.onSelect();
  };

  const handleSearchKeyDown = (
    event: KeyboardEvent<HTMLInputElement>,
  ): void => {
    if (event.key !== "Enter" || !workspaceSearchText.trim()) {
      return;
    }

    const bestMatch = rankedOptions[0];

    if (!bestMatch) {
      return;
    }

    event.preventDefault();
    selectOption(bestMatch);
  };

  if (workspaceLocked) {
    return (
      <ControlTooltip content="Workspace locked after first message">
        <span className="inline-flex max-w-full">
          <Button
            type="button"
            variant="outline"
            aria-label={buttonAriaLabel}
            tooltip={null}
            disabled
            className={cn(
              resolvedButtonClassName,
              "cursor-not-allowed opacity-75 disabled:opacity-75",
            )}
          >
            <WorkspaceSelectButtonContent
              buttonLabel={buttonLabel}
              active={active}
              workspaceLocked={workspaceLocked}
            />
          </Button>
        </span>
      </ControlTooltip>
    );
  }

  if ((selectActionOnTrigger || options.length === 0) && action) {
    return (
      <Button
        type="button"
        variant="outline"
        aria-label={buttonAriaLabel}
        onClick={selectAction}
        className={resolvedButtonClassName}
      >
        <WorkspaceSelectButtonContent
          buttonLabel={buttonLabel}
          active={active}
          workspaceLocked={workspaceLocked}
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
          <WorkspaceSelectButtonContent
            buttonLabel={buttonLabel}
            active={active}
            workspaceLocked={workspaceLocked}
          />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className={cn(
          "w-96 max-w-[calc(100vw-2rem)] rounded-3xl border-slate-800 bg-slate-950/95 p-4 shadow-2xl backdrop-blur-xl",
          contentClassName,
        )}
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
            {description ? (
              <p className="text-sm leading-5 text-slate-400">{description}</p>
            ) : null}
          </div>

          <SearchField
            ref={searchInputRef}
            value={workspaceSearchText}
            onChange={(event) => setWorkspaceSearchText(event.target.value)}
            onKeyDown={handleSearchKeyDown}
            aria-label="Search workspaces"
            placeholder="Search workspaces"
            autoComplete="off"
            spellCheck={false}
            className="h-10 rounded-2xl border-slate-800 bg-slate-900/70 pr-3 text-sm text-slate-100 shadow-none placeholder:text-slate-500 focus-visible:border-sky-400/50 focus-visible:ring-sky-400/30"
          />

          <div className="grid max-h-72 gap-2 overflow-y-auto pr-1">
            {rankedOptions.length === 0 ? (
              <EmptyState
                icon={Search}
                title="No matching workspaces"
                size="compact"
                role="status"
                className="rounded-2xl bg-slate-900/60"
              />
            ) : null}

            {rankedOptions.map((option) => {
              const selected = selectedOptionId === option.id;
              const removable = Boolean(option.removable && onRemoveOption);
              const OptionIcon = option.icon === "not-set" ? X : FolderOpen;

              return (
                <div
                  key={option.id}
                  className={cn(
                    "group grid w-full items-center gap-1 rounded-2xl border p-1.5 transition-all",
                    removable
                      ? "grid-cols-[minmax(0,1fr)_2rem]"
                      : "grid-cols-[minmax(0,1fr)]",
                    selected
                      ? "border-sky-500/30 bg-sky-500/10 text-sky-100"
                      : "border-slate-800 bg-slate-900/70 text-slate-300 hover:border-slate-700 hover:bg-slate-900 hover:text-slate-100",
                  )}
                >
                  <ControlTooltip content={option.path ?? option.label}>
                    <button
                      type="button"
                      aria-pressed={selected}
                      onClick={() => selectOption(option)}
                      className="flex min-w-0 items-center gap-3 rounded-xl px-1.5 py-1 text-left outline-none transition-colors hover:bg-white/[0.03] focus-visible:ring-2 focus-visible:ring-sky-400/60 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950"
                    >
                      <div
                        className={cn(
                          "flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-slate-800 bg-slate-950",
                          option.icon === "not-set"
                            ? "text-slate-500"
                            : "text-sky-300",
                        )}
                      >
                        <OptionIcon className="h-4 w-4" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold text-slate-100">
                          {option.label}
                        </p>
                        {option.path ? (
                          <p className="truncate text-xs leading-5 text-slate-500">
                            {option.path}
                          </p>
                        ) : null}
                      </div>
                      {selected ? (
                        <Check className="h-4 w-4 shrink-0 text-sky-300" />
                      ) : null}
                    </button>
                  </ControlTooltip>
                  {removable ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          aria-label={`Remove ${option.label} from workspace list`}
                          onClick={() => onRemoveOption?.(option)}
                          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl text-slate-500 opacity-70 outline-none transition-colors hover:bg-rose-500/10 hover:text-rose-200 hover:opacity-100 focus-visible:bg-rose-500/10 focus-visible:text-rose-200 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-rose-400/60 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950"
                        >
                          <X className="h-4 w-4" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="left">
                        Remove from list
                      </TooltipContent>
                    </Tooltip>
                  ) : null}
                </div>
              );
            })}
          </div>

          {action ? (
            <Button
              type="button"
              variant="outline"
              onClick={selectAction}
              className="h-10 justify-start rounded-2xl border-slate-800 bg-slate-950/70 px-3 text-sm text-slate-300 shadow-none hover:bg-slate-900 hover:text-slate-100"
            >
              <FolderPlus className="h-4 w-4 text-slate-500" />
              {action.label}
            </Button>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
};
