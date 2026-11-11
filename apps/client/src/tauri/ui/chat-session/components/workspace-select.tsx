import { LockedWorkspaceIcon, WorkspaceIcon } from "@machdoch/product-ui";
import { Check, FolderPlus, Search, X } from "lucide-react";
import { useMemo, useRef, useState, type JSX, type KeyboardEvent } from "react";
import { Button } from "@machdoch/media-studio/tauri/ui/components/ui/button.js";
import { EmptyState } from "@machdoch/media-studio/tauri/ui/components/ui/empty-state.js";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@machdoch/media-studio/tauri/ui/components/ui/popover.js";
import { SearchField } from "@machdoch/media-studio/tauri/ui/components/ui/search-field.js";
import {
  ControlTooltip,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@machdoch/media-studio/tauri/ui/components/ui/tooltip.js";
import { cn } from "@machdoch/media-studio/tauri/ui/lib/utils.js";
import { rankWorkspaceOptions } from "../_helpers/workspace-option-search";

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
  highlightSelection?: boolean;
  iconOnly?: boolean;
  workspaceLocked?: boolean;
  workspaceSwitchBlocked?: boolean;
  buttonAriaLabel?: string;
  buttonClassName?: string;
  description?: string;
  action?: WorkspaceSelectAction;
  selectActionOnTrigger?: boolean;
  onSelectOption: (option: WorkspaceSelectOption) => void;
  onRemoveOption?: (option: WorkspaceSelectOption) => void;
}

const WorkspaceSelectButtonContent = ({
  buttonLabel,
  active,
  iconOnly,
  workspaceLocked,
}: Pick<
  WorkspaceSelectProps,
  "active" | "buttonLabel" | "iconOnly" | "workspaceLocked"
>): JSX.Element => (
  <>
    {workspaceLocked ? (
      <LockedWorkspaceIcon className="h-3.5 w-3.5 text-slate-500" />
    ) : (
      <WorkspaceIcon
        className={cn(
          "h-3.5 w-3.5",
          !iconOnly && (active ? "text-sky-300" : "text-slate-500"),
        )}
      />
    )}
    {!iconOnly ? (
      <span className="min-w-0 flex-1 truncate text-left">{buttonLabel}</span>
    ) : null}
  </>
);

export const WorkspaceSelect = ({
  selectedOptionId,
  options,
  buttonLabel,
  active,
  highlightSelection = true,
  iconOnly = false,
  workspaceLocked = false,
  workspaceSwitchBlocked = false,
  buttonAriaLabel,
  buttonClassName,
  description,
  action,
  selectActionOnTrigger = false,
  onSelectOption,
  onRemoveOption,
}: WorkspaceSelectProps): JSX.Element => {
  const [open, setOpen] = useState(false);
  const [workspaceSearchText, setWorkspaceSearchText] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const rankedOptions = useMemo(
    () => rankWorkspaceOptions(options, workspaceSearchText),
    [options, workspaceSearchText],
  );
  const resolvedButtonClassName = cn(
    buttonClassName ??
      (iconOnly
        ? "app-composer-toolbar-icon-button h-8 w-8 rounded-full border-slate-800 bg-slate-950/70 p-0 text-slate-400 shadow-none hover:bg-slate-900"
        : "app-composer-toolbar-pill h-8 rounded-full border-slate-800 bg-slate-950/70 px-3 text-xs font-medium text-slate-300 shadow-none hover:bg-slate-900 hover:text-slate-100"),
    active &&
      highlightSelection &&
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

  if (workspaceSwitchBlocked) {
    return (
      <ControlTooltip content="Finish the current task or remove queued messages">
        <span className="inline-flex max-w-full">
          <Button
            type="button"
            variant="outline"
            size={iconOnly ? "icon-sm" : "default"}
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
              iconOnly={iconOnly}
              workspaceLocked={workspaceLocked}
            />
          </Button>
        </span>
      </ControlTooltip>
    );
  }

  if ((selectActionOnTrigger || options.length === 0) && action) {
    return (
      <ControlTooltip
        content={
          workspaceLocked
            ? "Change workspace"
            : iconOnly
              ? buttonAriaLabel
              : undefined
        }
      >
        <Button
          type="button"
          variant="outline"
          size={iconOnly ? "icon-sm" : "default"}
          tooltip={null}
          aria-label={buttonAriaLabel}
          onClick={selectAction}
          className={resolvedButtonClassName}
        >
          <WorkspaceSelectButtonContent
            buttonLabel={buttonLabel}
            active={active}
            iconOnly={iconOnly}
            workspaceLocked={workspaceLocked}
          />
        </Button>
      </ControlTooltip>
    );
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <ControlTooltip
        content={
          workspaceLocked
            ? "Change workspace"
            : iconOnly
              ? buttonAriaLabel
              : undefined
        }
      >
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size={iconOnly ? "icon-sm" : "default"}
            tooltip={null}
            aria-label={buttonAriaLabel}
            className={resolvedButtonClassName}
          >
            <WorkspaceSelectButtonContent
              buttonLabel={buttonLabel}
              active={active}
              iconOnly={iconOnly}
              workspaceLocked={workspaceLocked}
            />
          </Button>
        </PopoverTrigger>
      </ControlTooltip>
      <PopoverContent
        align="start"
        className="w-96 max-w-[calc(100vw-2rem)] rounded-3xl border-slate-800 bg-slate-950/95 p-4 shadow-2xl backdrop-blur-xl"
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
              const OptionIcon = option.icon === "not-set" ? X : WorkspaceIcon;

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
