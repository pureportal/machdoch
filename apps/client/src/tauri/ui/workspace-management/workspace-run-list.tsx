import { Layers, LoaderCircle, Play, Square } from "lucide-react";
import type { JSX } from "react";
import type { WorkspaceRunConfigurationStatus } from "../../../shared/workspace-run.js";
import { Button } from "@machdoch/media-studio/tauri/ui/components/ui/button.js";
import { SearchField } from "@machdoch/media-studio/tauri/ui/components/ui/search-field.js";
import { cn } from "@machdoch/media-studio/tauri/ui/lib/utils.js";
import {
  workspaceRunConfigurationLabel,
  workspaceRunDirectAction,
  workspaceRunIsActive,
  workspaceRunListSections,
  workspaceRunStatusPresentation,
} from "./workspace-run-model";
import { WorkspaceRunStatusDot } from "./workspace-run-status-dot";

const SEARCH_THRESHOLD = 8;
const SECTION_TITLES = { service: "Services", job: "Jobs" } as const;

export type WorkspaceRunQuickAction = "start" | "stop";

const ListRow = ({
  status,
  peers,
  selected,
  busy,
  hasArguments,
  onSelect,
  onQuickAction,
}: {
  status: WorkspaceRunConfigurationStatus;
  peers: readonly WorkspaceRunConfigurationStatus[];
  selected: boolean;
  busy: boolean;
  hasArguments: boolean;
  onSelect: () => void;
  onQuickAction: (action: WorkspaceRunQuickAction) => void;
}): JSX.Element => {
  const label = workspaceRunConfigurationLabel(status, peers);
  const active = workspaceRunIsActive(status);
  const directAction = workspaceRunDirectAction(status);
  const quickAction =
    directAction === "stop" || (directAction === "start" && !hasArguments)
      ? directAction
      : null;

  return (
    <li
      className={cn(
        "group/row flex items-center gap-1 rounded-md pr-1 transition-colors",
        selected ? "bg-slate-800/80" : "hover:bg-slate-900",
      )}
    >
      <button
        type="button"
        aria-current={selected ? "true" : undefined}
        onClick={onSelect}
        className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md py-1.5 pl-2.5 text-left text-[13px] text-slate-300 outline-none focus-visible:ring-2 focus-visible:ring-sky-500/70 aria-[current=true]:text-white"
      >
        <WorkspaceRunStatusDot
          presentation={workspaceRunStatusPresentation(status)}
          active={active}
        />
        <span className="min-w-0 truncate">{label}</span>
        {status.configuration.kind === "composite" ? (
          <Layers
            aria-hidden="true"
            className="size-3 shrink-0 text-slate-500"
          />
        ) : null}
      </button>
      {busy ? (
        <LoaderCircle
          aria-label={`${label} is updating`}
          className="mx-1 size-3.5 shrink-0 animate-spin text-slate-400"
        />
      ) : quickAction ? (
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label={`${quickAction === "start" ? "Run" : "Stop"} ${label}`}
          onClick={() => onQuickAction(quickAction)}
          className={cn(
            "shrink-0 text-slate-400 hover:text-white",
            !active &&
              "opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100",
          )}
        >
          {quickAction === "start" ? (
            <Play aria-hidden="true" />
          ) : (
            <Square aria-hidden="true" className="fill-current" />
          )}
        </Button>
      ) : null}
    </li>
  );
};

export const WorkspaceRunList = ({
  statuses,
  selectedConfigurationId,
  query,
  busyConfigurationIds,
  configurationHasArguments,
  onQueryChange,
  onSelect,
  onQuickAction,
}: {
  statuses: readonly WorkspaceRunConfigurationStatus[];
  selectedConfigurationId: string | null;
  query: string;
  busyConfigurationIds: ReadonlySet<string>;
  configurationHasArguments: (
    status: WorkspaceRunConfigurationStatus,
  ) => boolean;
  onQueryChange: (query: string) => void;
  onSelect: (configurationId: string) => void;
  onQuickAction: (
    configurationId: string,
    action: WorkspaceRunQuickAction,
  ) => void;
}): JSX.Element => {
  const sections = workspaceRunListSections(statuses, query);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {statuses.length > SEARCH_THRESHOLD ? (
        <div className="px-3 pt-3">
          <SearchField
            aria-label="Search run configurations"
            placeholder="Search"
            value={query}
            onChange={(event) => onQueryChange(event.currentTarget.value)}
            className="h-8 border-slate-800 bg-slate-950 text-sm"
          />
        </div>
      ) : null}
      <nav
        aria-label="Run configurations"
        className="min-h-0 flex-1 overflow-y-auto px-2 py-3"
      >
        {sections.length === 0 ? (
          <p className="px-2.5 py-2 text-xs text-slate-500">No matches</p>
        ) : null}
        {sections.map((section) => (
          <section
            key={section.runType}
            aria-label={SECTION_TITLES[section.runType]}
            className="mb-3 last:mb-0"
          >
            <h3 className="px-2.5 pb-1 text-[11px] font-semibold tracking-wide text-slate-500 uppercase">
              {SECTION_TITLES[section.runType]}
            </h3>
            {section.groups.map((group) => (
              <div key={group.name ?? ""} className="mb-1.5 last:mb-0">
                {group.name ? (
                  <h4 className="px-2.5 pt-1.5 pb-0.5 text-[11px] text-slate-500">
                    {group.name}
                  </h4>
                ) : null}
                <ul className="grid gap-0.5">
                  {group.statuses.map((status) => (
                    <ListRow
                      key={status.configuration.id}
                      status={status}
                      peers={statuses}
                      selected={
                        status.configuration.id === selectedConfigurationId
                      }
                      busy={busyConfigurationIds.has(status.configuration.id)}
                      hasArguments={configurationHasArguments(status)}
                      onSelect={() => onSelect(status.configuration.id)}
                      onQuickAction={(action) =>
                        onQuickAction(status.configuration.id, action)
                      }
                    />
                  ))}
                </ul>
              </div>
            ))}
          </section>
        ))}
      </nav>
    </div>
  );
};
