import {
  FileText,
  Globe2,
  LoaderCircle,
  Plus,
  RefreshCw,
  Tags,
} from "lucide-react";
import type { JSX } from "react";
import type { InstructionProfileView } from "@machdoch/fleet-protocol/instruction-contract";
import { Button } from "@machdoch/media-studio/tauri/ui/components/ui/button.js";
import { SearchField } from "@machdoch/media-studio/tauri/ui/components/ui/search-field.js";
import { cn } from "@machdoch/media-studio/tauri/ui/lib/utils.js";
import { InstructionSwitch } from "./instruction-controls";
import {
  INSTRUCTION_FILE_FILTER_LABELS,
  INSTRUCTION_FILE_FILTERS,
  instructionActivation,
  type InstructionActivation,
} from "./instruction-library-model";
import type { FileFilter } from "./types";

export const ACTIVATION_ICONS: Record<InstructionActivation, typeof FileText> =
  {
    global: Globe2,
    "tag-match": Tags,
    manual: FileText,
  };

export const InstructionFileList = ({
  files,
  filteredFiles,
  counts,
  query,
  filter,
  selectedFileId,
  loading,
  busy,
  libraryUnavailable,
  enableBlockedReason,
  onQueryChange,
  onFilterChange,
  onNew,
  onRefresh,
  onSelect,
  onToggleEnabled,
}: {
  files: readonly InstructionProfileView[];
  filteredFiles: readonly InstructionProfileView[];
  counts: Record<FileFilter, number>;
  query: string;
  filter: FileFilter;
  selectedFileId: string | null;
  loading: boolean;
  busy: boolean;
  libraryUnavailable: boolean;
  enableBlockedReason: (file: InstructionProfileView) => string | null;
  onQueryChange: (query: string) => void;
  onFilterChange: (filter: FileFilter) => void;
  onNew: () => void;
  onRefresh: () => void;
  onSelect: (fileId: string) => void;
  onToggleEnabled: (file: InstructionProfileView, enabled: boolean) => void;
}): JSX.Element => {
  const visibleFilters = INSTRUCTION_FILE_FILTERS.filter(
    (candidate) =>
      candidate === "all" || candidate === filter || counts[candidate] > 0,
  );

  return (
    <aside className="flex min-h-0 min-w-0 flex-col border-b border-slate-900 bg-slate-950/70 lg:border-r lg:border-b-0">
      <div className="grid shrink-0 gap-2 border-b border-slate-900 p-3">
        <div className="flex items-center gap-1.5">
          <SearchField
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            aria-label="Search instruction files"
            placeholder="Search"
            className="h-8 min-w-0 flex-1 border-slate-800 bg-slate-950"
          />
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            disabled={loading || busy}
            aria-label="Refresh instructions"
            tooltip="Refresh"
            onClick={onRefresh}
          >
            <RefreshCw className={cn("size-4", loading && "animate-spin")} />
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={loading || busy || libraryUnavailable}
            aria-label="New instruction file"
            onClick={onNew}
          >
            <Plus className="size-4" />
            New
          </Button>
        </div>
        {files.length > 0 ? (
          <div
            className="flex flex-wrap gap-0.5"
            role="group"
            aria-label="File filter"
          >
            {visibleFilters.map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={filter === value}
                onClick={() => onFilterChange(value)}
                className={cn(
                  "inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] outline-none focus-visible:ring-2 focus-visible:ring-sky-500/60",
                  filter === value
                    ? "bg-sky-500/15 text-sky-200"
                    : "text-slate-400 hover:bg-slate-900 hover:text-slate-200",
                )}
              >
                {INSTRUCTION_FILE_FILTER_LABELS[value]}
                <span className="tabular-nums text-slate-500">
                  {counts[value]}
                </span>
              </button>
            ))}
          </div>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {loading && files.length === 0 ? (
          <div className="grid h-24 place-items-center text-slate-500">
            <LoaderCircle className="size-5 animate-spin" />
          </div>
        ) : libraryUnavailable ? null : filteredFiles.length === 0 ? (
          <p className="px-2 py-3 text-sm text-slate-500">
            {files.length === 0
              ? "No instruction files."
              : "No matching files."}
          </p>
        ) : (
          <ul className="grid gap-0.5">
            {filteredFiles.map((file) => {
              const activation = instructionActivation(file);
              const Icon = ACTIVATION_ICONS[activation];
              const selected = selectedFileId === file.id;
              const blockedReason = enableBlockedReason(file);
              return (
                <li
                  key={file.id}
                  className={cn(
                    "flex min-w-0 items-center gap-1 rounded-lg border pr-1.5 transition-colors",
                    selected
                      ? "border-sky-800/70 bg-sky-950/25"
                      : "border-transparent hover:border-slate-800 hover:bg-slate-900/55",
                  )}
                >
                  <button
                    type="button"
                    aria-pressed={selected}
                    onClick={() => onSelect(file.id)}
                    className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg py-2 pl-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-sky-500/60"
                  >
                    <Icon
                      aria-hidden="true"
                      className={cn(
                        "size-4 shrink-0",
                        activation === "global"
                          ? "text-sky-300"
                          : activation === "tag-match"
                            ? "text-violet-300"
                            : "text-slate-500",
                      )}
                    />
                    <span className="grid min-w-0 flex-1">
                      <span
                        className={cn(
                          "truncate text-sm font-medium",
                          file.enabled ? "text-slate-200" : "text-slate-500",
                        )}
                      >
                        {file.name}
                      </span>
                      <span className="truncate text-[11px] text-slate-500">
                        {file.description ||
                          INSTRUCTION_FILE_FILTER_LABELS[activation]}
                      </span>
                    </span>
                  </button>
                  <InstructionSwitch
                    label={`Enable ${file.name}`}
                    checked={file.enabled}
                    disabled={blockedReason !== null}
                    tooltip={blockedReason || undefined}
                    onCheckedChange={(enabled) =>
                      onToggleEnabled(file, enabled)
                    }
                  />
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </aside>
  );
};
