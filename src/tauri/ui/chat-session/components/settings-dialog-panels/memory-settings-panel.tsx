import type { JSX } from "react";
import { Badge } from "../../../components/ui/badge";
import {
  ChoiceButtons,
  SettingPanel,
  SettingsCard,
  SettingsStatus,
} from "./shared";
import type { MemorySettingsControls } from "./types";

export interface MemorySettingsPanelProps {
  setup: MemorySettingsControls;
}

export const MemorySettingsPanel = ({
  setup,
}: MemorySettingsPanelProps): JSX.Element => {
  return (
    <SettingsCard
      title="Global memory"
      description="Global memory changes apply immediately."
    >
      <SettingPanel label="Status">
        <div className="flex flex-wrap items-center gap-2">
          <ChoiceButtons
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
        <div className="grid gap-2">
          {setup.settings.entries.map((entry) => (
            <div
              key={entry.id}
              className="rounded-lg border border-slate-800 bg-slate-950 px-4 py-3 text-sm leading-6 text-slate-300"
            >
              {entry.content}
            </div>
          ))}
        </div>
      ) : null}

      <SettingsStatus message={setup.message} />
    </SettingsCard>
  );
};
