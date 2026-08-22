import type { JSX } from "react";
import { Badge } from "../../../components/ui/badge";
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

export const MemorySettingsPanel = ({
  setup,
}: MemorySettingsPanelProps): JSX.Element => {
  useSettingsNavigationGuard({
    dirty: setup.saving,
    title: "Saving memory preference",
    description:
      "Wait for the memory preference to finish saving before leaving this section.",
    canDiscard: false,
    onDiscard: () => undefined,
  });

  return (
    <SettingsCard
      title="Global memory"
      description="Saved facts can be reused across sessions when both global and session memory are enabled."
    >
      <SettingPanel label="Use global memory">
        <div className="flex flex-wrap items-center gap-2">
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
          <Badge className="h-8 rounded-md border-slate-700 bg-slate-950 px-3 text-slate-300">
            {setup.settings.entries.length} saved fact
            {setup.settings.entries.length === 1 ? "" : "s"}
          </Badge>
        </div>
      </SettingPanel>

      {setup.settings.entries.length > 0 ? (
        <div role="list" aria-label="Saved global memory facts" className="grid gap-2 pt-1">
          {setup.settings.entries.map((entry) => (
            <div
              key={entry.id}
              role="listitem"
              className="break-words rounded-lg border border-slate-800 bg-slate-950 px-4 py-3 text-sm leading-6 text-slate-300"
            >
              {entry.content}
            </div>
          ))}
        </div>
      ) : (
        <p className="py-1 text-sm text-slate-400">No global facts saved yet.</p>
      )}

      <p role="status" aria-live="polite" className="text-sm text-slate-400">
        {setup.saving ? "Saving memory preference…" : "Memory preference is up to date."}
      </p>

      <SettingsStatus message={setup.message} />
    </SettingsCard>
  );
};
