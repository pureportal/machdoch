import {
  FileCode2,
  GitBranch,
  ScrollText,
  Settings2,
  SlidersHorizontal,
} from "lucide-react";
import type { JSX, KeyboardEvent } from "react";
import { cn } from "../lib/utils";

export type WorkspaceDetailSection =
  | "output"
  | "files"
  | "configuration"
  | "git"
  | "settings";

const WORKSPACE_DETAIL_SECTIONS = [
  { value: "output", label: "Output", icon: ScrollText },
  { value: "files", label: "Files", icon: FileCode2 },
  {
    value: "configuration",
    label: "Configuration",
    icon: SlidersHorizontal,
  },
  { value: "git", label: "Git", icon: GitBranch },
  { value: "settings", label: "Settings", icon: Settings2 },
] as const;

export const workspaceDetailTabId = (section: WorkspaceDetailSection): string =>
  `workspace-detail-tab-${section}`;

export const workspaceDetailPanelId = (
  section: WorkspaceDetailSection,
): string => `workspace-detail-panel-${section}`;

const selectAdjacentTab = (event: KeyboardEvent<HTMLButtonElement>): void => {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
    return;
  }

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

export const WorkspaceDetailNavigation = ({
  activeSection,
  onSectionChange,
}: {
  activeSection: WorkspaceDetailSection;
  onSectionChange: (section: WorkspaceDetailSection) => void;
}): JSX.Element => (
  <div
    role="tablist"
    aria-label="Workspace sections"
    className="flex min-w-0 overflow-x-auto rounded-lg border border-slate-800 bg-slate-900/30 px-1"
  >
    {WORKSPACE_DETAIL_SECTIONS.map(({ value, label, icon: Icon }) => {
      const active = activeSection === value;
      return (
        <button
          key={value}
          type="button"
          role="tab"
          id={workspaceDetailTabId(value)}
          aria-controls={workspaceDetailPanelId(value)}
          aria-selected={active}
          tabIndex={active ? 0 : -1}
          onClick={() => onSectionChange(value)}
          onKeyDown={selectAdjacentTab}
          className={cn(
            "relative flex h-10 shrink-0 items-center gap-2 border-b-2 px-3 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sky-500/70 sm:px-4",
            active
              ? "border-sky-400 bg-sky-950/25 text-sky-100"
              : "border-transparent text-slate-500 hover:bg-slate-900/60 hover:text-slate-200",
          )}
        >
          <Icon aria-hidden="true" className="size-3.5" />
          {label}
        </button>
      );
    })}
  </div>
);
