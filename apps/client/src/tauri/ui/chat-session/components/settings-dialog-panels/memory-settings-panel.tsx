import type { JSX } from "react";
import type { ConversationMemoryEntry } from "../../../../../core/types.js";
import { Button } from "../../../components/ui/button";
import {
  ChoiceButtons,
  SettingPanel,
  SettingsCard,
  SettingsStatus,
} from "./shared";
import { useSettingsNavigationGuard } from "./navigation-guard";
import type { MemorySettingsControls } from "./types";

export interface MemorySettingsPanelProps {
  setup: MemorySettingsControls;
}

interface MemoryEntryListProps {
  entries: ConversationMemoryEntry[];
  label: string;
  emptyText: string;
  saving: boolean;
  onForget: (id: string) => Promise<void> | void;
}

const MemoryEntryList = ({
  entries,
  label,
  emptyText,
  saving,
  onForget,
}: MemoryEntryListProps): JSX.Element => {
  if (entries.length === 0) {
    return <p className="py-1 text-sm text-slate-400">{emptyText}</p>;
  }

  return (
    <div role="list" aria-label={label} className="grid gap-2 pt-1">
      {entries.map((entry) => (
        <div
          key={entry.id}
          role="listitem"
          className="flex items-start justify-between gap-3 rounded-lg border border-slate-800 bg-slate-950 px-4 py-3"
        >
          <span className="min-w-0 break-words text-sm leading-6 text-slate-300">
            {entry.content}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={saving}
            onClick={() => void onForget(entry.id)}
            className="mt-0.5 text-slate-400 hover:text-red-300"
          >
            Forget
          </Button>
        </div>
      ))}
    </div>
  );
};

export const MemorySettingsPanel = ({
  setup,
}: MemorySettingsPanelProps): JSX.Element => {
  useSettingsNavigationGuard({
    dirty: setup.saving,
    title: "Updating memory",
    description:
      "Wait for the memory update to finish before leaving this section.",
    canDiscard: false,
    onDiscard: () => undefined,
  });

  return (
    <>
      <SettingsCard title="Workspace memory">
        {setup.workspaceRoot ? (
          <MemoryEntryList
            entries={setup.workspaceEntries}
            label="Saved workspace memory"
            emptyText="No workspace facts saved."
            saving={setup.saving}
            onForget={setup.onForgetWorkspace}
          />
        ) : (
          <p className="py-1 text-sm text-slate-400">
            Select a workspace to view its memory.
          </p>
        )}
      </SettingsCard>

      <SettingsCard title="Global memory">
        <SettingPanel label="Use global memory">
          <ChoiceButtons
            label="Global memory status"
            value={setup.settings.globalEnabled ? "enabled" : "disabled"}
            options={[
              { value: "enabled", label: "Enabled" },
              { value: "disabled", label: "Disabled" },
            ]}
            disabled={setup.saving}
            onChange={(value) => {
              void setup.onGlobalEnabledChange(value === "enabled");
            }}
          />
        </SettingPanel>

        <MemoryEntryList
          entries={setup.settings.entries}
          label="Saved global memory"
          emptyText="No global facts saved."
          saving={setup.saving}
          onForget={setup.onForgetGlobal}
        />

        {setup.saving ? (
          <p
            role="status"
            aria-live="polite"
            className="text-sm text-slate-400"
          >
            Updating memory…
          </p>
        ) : null}

        <SettingsStatus message={setup.message} />
      </SettingsCard>
    </>
  );
};
