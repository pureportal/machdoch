import type { LucideIcon } from "lucide-react";
import type { JSX, KeyboardEvent } from "react";
import { cn } from "@machdoch/media-studio/tauri/ui/lib/utils.js";

export interface WorkspaceTab<T extends string> {
  value: T;
  label: string;
  icon: LucideIcon;
  count?: number;
}

export const workspaceTabId = (scope: string, value: string): string =>
  `${scope}-tab-${value}`;

export const workspaceTabPanelId = (scope: string, value: string): string =>
  `${scope}-panel-${value}`;

const selectAdjacentTab = (event: KeyboardEvent<HTMLButtonElement>): void => {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const tabs = Array.from(
    event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
      '[role="tab"]',
    ) ?? [],
  );
  const currentIndex = tabs.indexOf(event.currentTarget);
  const nextIndex =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? tabs.length - 1
        : event.key === "ArrowRight"
          ? (currentIndex + 1) % tabs.length
          : (currentIndex - 1 + tabs.length) % tabs.length;
  tabs[nextIndex]?.focus();
  tabs[nextIndex]?.click();
};

export const WorkspaceTabList = <T extends string>({
  scope,
  label,
  tabs,
  value,
  onChange,
  className,
}: {
  scope: string;
  label: string;
  tabs: readonly WorkspaceTab<T>[];
  value: T;
  onChange: (value: T) => void;
  className?: string;
}): JSX.Element => (
  <div
    role="tablist"
    aria-label={label}
    className={cn("flex min-w-0 overflow-x-auto", className)}
  >
    {tabs.map(({ value: tabValue, label: tabLabel, icon: Icon, count }) => {
      const active = tabValue === value;
      return (
        <button
          key={tabValue}
          type="button"
          role="tab"
          id={workspaceTabId(scope, tabValue)}
          aria-controls={workspaceTabPanelId(scope, tabValue)}
          aria-selected={active}
          tabIndex={active ? 0 : -1}
          onClick={() => onChange(tabValue)}
          onKeyDown={selectAdjacentTab}
          className={cn(
            "relative flex h-9 shrink-0 items-center gap-1.5 border-b-2 px-3 text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sky-500/70",
            active
              ? "border-sky-400 text-sky-100"
              : "border-transparent text-slate-500 hover:text-slate-200",
          )}
        >
          <Icon aria-hidden="true" className="size-3.5" />
          {tabLabel}
          {count ? (
            <span
              className={cn(
                "rounded-full px-1.5 text-[10px] leading-4",
                active
                  ? "bg-sky-500/20 text-sky-200"
                  : "bg-slate-800 text-slate-400",
              )}
            >
              {count > 999 ? "999+" : count}
            </span>
          ) : null}
        </button>
      );
    })}
  </div>
);
