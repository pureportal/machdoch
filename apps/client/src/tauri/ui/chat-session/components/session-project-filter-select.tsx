import {
  SESSION_PROJECT_FILTER_MODES,
  WorkspaceIcon,
  type SessionProjectFilter,
} from "@machdoch/product-ui";
import { Check, ChevronDown, RotateCcw, Search, X } from "lucide-react";
import { useMemo, useRef, useState, type JSX, type KeyboardEvent } from "react";
import { Button } from "@machdoch/media-studio/tauri/ui/components/ui/button.js";
import { EmptyState } from "@machdoch/media-studio/tauri/ui/components/ui/empty-state.js";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@machdoch/media-studio/tauri/ui/components/ui/popover.js";
import { SearchField } from "@machdoch/media-studio/tauri/ui/components/ui/search-field.js";
import { ControlTooltip } from "@machdoch/media-studio/tauri/ui/components/ui/tooltip.js";
import { cn } from "@machdoch/media-studio/tauri/ui/lib/utils.js";
import {
  ALL_SESSION_PROJECTS_FILTER,
  type SessionHistoryProjectFacet,
} from "../_helpers/session-history-index";
import {
  DEFAULT_SESSION_PROJECT_FILTER,
  toggleSessionProjectFilterProject,
} from "../_helpers/session-project-filter";
import { rankWorkspaceOptions } from "../_helpers/workspace-option-search";

const OPTION_SELECTOR = "[data-project-filter-option]";

const NAVIGATION_OFFSETS: Readonly<Record<string, number>> = {
  ArrowDown: 1,
  ArrowUp: -1,
};

interface SessionProjectFilterSelectProps {
  filter: SessionProjectFilter;
  projects: readonly SessionHistoryProjectFacet[];
  onFilterChange: (filter: SessionProjectFilter) => void;
}

interface ProjectFilterOptionProps {
  label: string;
  checked: boolean;
  excluded: boolean;
  detail?: string | null;
  count?: number;
  tooltip?: string | null;
  onToggle: () => void;
}

const getParentPath = (path: string): string | null => {
  const trimmedPath = path.replace(/[\\/]+$/u, "");
  const separatorIndex = Math.max(
    trimmedPath.lastIndexOf("\\"),
    trimmedPath.lastIndexOf("/"),
  );

  return separatorIndex > 0 ? trimmedPath.slice(0, separatorIndex) : null;
};

const getFilterButtonLabel = (
  filter: SessionProjectFilter,
  selectedProjects: readonly SessionHistoryProjectFacet[],
): string => {
  const [firstSelectedProject] = selectedProjects;

  if (!firstSelectedProject) {
    return "All workspaces";
  }

  const selectionLabel =
    selectedProjects.length === 1
      ? firstSelectedProject.label
      : `${selectedProjects.length} workspaces`;

  return filter.mode === "exclude"
    ? `All except ${selectionLabel}`
    : selectionLabel;
};

const ProjectFilterOption = ({
  label,
  checked,
  excluded,
  detail,
  count,
  tooltip,
  onToggle,
}: ProjectFilterOptionProps): JSX.Element => {
  const CheckIcon = excluded ? X : Check;

  return (
    <ControlTooltip content={tooltip} side="right">
      <button
        type="button"
        role="checkbox"
        aria-checked={checked}
        data-project-filter-option=""
        onClick={onToggle}
        className="flex w-full min-w-0 items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm text-slate-300 outline-none transition-colors hover:bg-slate-900 hover:text-slate-100 focus-visible:bg-slate-900 focus-visible:text-slate-100 focus-visible:ring-1 focus-visible:ring-sky-400/50"
      >
        <span
          aria-hidden="true"
          className={cn(
            "flex size-4 shrink-0 items-center justify-center rounded-[5px] border border-slate-700 bg-slate-950",
            checked &&
              (excluded
                ? "border-rose-400/60 bg-rose-500/20 text-rose-200"
                : "border-sky-400/60 bg-sky-500/20 text-sky-200"),
          )}
        >
          {checked ? <CheckIcon className="size-3" strokeWidth={3} /> : null}
        </span>
        <span className="min-w-0 flex-1">
          <span
            className={cn(
              "block truncate",
              checked && "font-medium text-slate-100",
            )}
          >
            {label}
          </span>
          {detail ? (
            <span className="block truncate text-[11px] leading-4 text-slate-500">
              {detail}
            </span>
          ) : null}
        </span>
        {count === undefined ? null : (
          <span className="shrink-0 text-xs text-slate-500 tabular-nums">
            {count}
          </span>
        )}
      </button>
    </ControlTooltip>
  );
};

export const SessionProjectFilterSelect = ({
  filter,
  projects,
  onFilterChange,
}: SessionProjectFilterSelectProps): JSX.Element => {
  const [open, setOpen] = useState(false);
  const [searchText, setSearchText] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const rankedProjects = useMemo(
    () => rankWorkspaceOptions(projects, searchText),
    [projects, searchText],
  );
  const duplicateLabels = useMemo(() => {
    const seenLabels = new Set<string>();
    const duplicates = new Set<string>();

    for (const { label } of projects) {
      (seenLabels.has(label) ? duplicates : seenLabels).add(label);
    }

    return duplicates;
  }, [projects]);
  const selectedProjects = projects.filter((project) =>
    filter.projectIds.includes(project.id),
  );
  const filterActive = selectedProjects.length > 0;
  const filterResettable =
    filter.projectIds.length > 0 ||
    filter.mode !== DEFAULT_SESSION_PROJECT_FILTER.mode;
  const excluding = filter.mode === "exclude";
  const searching = searchText.trim().length > 0;
  const buttonLabel = getFilterButtonLabel(filter, selectedProjects);

  const toggleProject = (projectId: string): void => {
    onFilterChange(toggleSessionProjectFilterProject(filter, projectId));
  };

  const resetFilter = (): void => {
    onFilterChange(DEFAULT_SESSION_PROJECT_FILTER);
  };

  const getOptionElements = (): HTMLElement[] => [
    ...(listRef.current?.querySelectorAll<HTMLElement>(OPTION_SELECTOR) ?? []),
  ];

  const handleOpenChange = (nextOpen: boolean): void => {
    setOpen(nextOpen);

    if (nextOpen) {
      setSearchText("");
    }
  };

  const handleSearchKeyDown = (
    event: KeyboardEvent<HTMLInputElement>,
  ): void => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      getOptionElements()[0]?.focus();
      return;
    }

    const bestMatch = rankedProjects[0];

    if (event.key === "Enter" && searching && bestMatch) {
      event.preventDefault();
      toggleProject(bestMatch.id);
    }
  };

  const handleListKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const offset = NAVIGATION_OFFSETS[event.key];

    if (offset === undefined) {
      return;
    }

    const options = getOptionElements();
    const nextIndex = options.indexOf(event.target as HTMLElement) + offset;

    event.preventDefault();

    if (nextIndex < 0) {
      searchInputRef.current?.focus();
      return;
    }

    options[Math.min(nextIndex, options.length - 1)]?.focus();
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <div className="relative min-w-0">
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            tooltip={null}
            aria-label={`Workspace filter: ${buttonLabel}`}
            data-active={filterActive}
            className={cn(
              "app-sessions-workspace-filter h-9 w-full min-w-0 justify-start gap-2 rounded-xl border-slate-800 bg-slate-950/80 px-3 text-sm font-medium text-slate-200 shadow-none hover:border-slate-700 hover:bg-slate-900 hover:text-slate-100",
              filterActive &&
                "border-sky-500/30 bg-sky-500/10 pr-9 text-sky-100 hover:bg-sky-500/15 hover:text-white",
            )}
          >
            <WorkspaceIcon
              className={cn(
                "h-3.5 w-3.5 shrink-0",
                filterActive ? "text-sky-300" : "text-slate-500",
              )}
            />
            <span className="min-w-0 flex-1 truncate text-left">
              {buttonLabel}
            </span>
            {filterActive ? null : (
              <ChevronDown className="h-3.5 w-3.5 shrink-0 text-slate-500" />
            )}
          </Button>
        </PopoverTrigger>
        {filterActive ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Reset workspace filter"
            onClick={resetFilter}
            className="absolute top-1/2 right-1.5 -translate-y-1/2 rounded-lg text-sky-300 hover:bg-sky-500/15 hover:text-white"
          >
            <X />
          </Button>
        ) : null}
      </div>
      <PopoverContent
        align="start"
        className="flex w-(--radix-popover-trigger-width) min-w-64 flex-col gap-2 overflow-hidden rounded-2xl border-slate-800 bg-slate-950/95 p-2 shadow-2xl backdrop-blur-xl"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          searchInputRef.current?.focus();
        }}
      >
        <div className="flex shrink-0 items-center gap-1.5">
          <div
            role="group"
            aria-label="Workspace match"
            className="grid flex-1 grid-cols-2 gap-1 rounded-xl border border-slate-800 bg-slate-900/60 p-1"
          >
            {SESSION_PROJECT_FILTER_MODES.map((mode) => {
              const selected = filter.mode === mode.id;

              return (
                <button
                  key={mode.id}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => onFilterChange({ ...filter, mode: mode.id })}
                  className={cn(
                    "h-7 rounded-lg text-xs font-medium text-slate-400 outline-none transition-colors hover:text-slate-100 focus-visible:ring-1 focus-visible:ring-sky-400/50",
                    selected &&
                      (mode.id === "exclude"
                        ? "bg-rose-500/15 text-rose-100 hover:text-rose-50"
                        : "bg-sky-500/15 text-sky-100 hover:text-sky-50"),
                  )}
                >
                  {mode.label}
                </button>
              );
            })}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Reset workspace filter"
            disabled={!filterResettable}
            onClick={resetFilter}
            className="size-[38px] rounded-xl border border-slate-800 bg-slate-900/60 text-slate-400 hover:bg-slate-900 hover:text-slate-100"
          >
            <RotateCcw className="size-3.5" />
          </Button>
        </div>

        <SearchField
          ref={searchInputRef}
          value={searchText}
          onChange={(event) => setSearchText(event.target.value)}
          onKeyDown={handleSearchKeyDown}
          aria-label="Search workspaces"
          placeholder="Search workspaces"
          autoComplete="off"
          spellCheck={false}
          containerClassName="shrink-0"
          className="h-8 rounded-lg border-slate-800 bg-slate-900/70 pr-3 text-sm text-slate-100 shadow-none placeholder:text-slate-500 focus-visible:border-sky-400/50 focus-visible:ring-sky-400/30"
        />

        <div
          ref={listRef}
          role="group"
          aria-label="Workspaces"
          onKeyDown={handleListKeyDown}
          className="grid max-h-72 min-h-0 gap-0.5 overflow-y-auto overscroll-contain"
        >
          {searching ? null : (
            <>
              <ProjectFilterOption
                label="All workspaces"
                checked={!filterActive}
                excluded={false}
                onToggle={() => toggleProject(ALL_SESSION_PROJECTS_FILTER)}
              />
              <div
                aria-hidden="true"
                className="mx-2 my-0.5 h-px bg-slate-800"
              />
            </>
          )}

          {rankedProjects.map((project) => (
            <ProjectFilterOption
              key={project.id}
              label={project.label}
              checked={filter.projectIds.includes(project.id)}
              excluded={excluding}
              detail={
                project.path && duplicateLabels.has(project.label)
                  ? getParentPath(project.path)
                  : null
              }
              count={project.count}
              tooltip={project.path}
              onToggle={() => toggleProject(project.id)}
            />
          ))}

          {rankedProjects.length === 0 ? (
            <EmptyState
              icon={Search}
              title="No matching workspaces"
              size="compact"
              role="status"
              className="rounded-xl bg-slate-900/60"
            />
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
};
