import { MemoryManagementTable } from "@machdoch/product-ui";
import type { JSX } from "react";
import { createMemoryManagementEntries } from "../../../components/memory-management-entries";
import { SettingPanel, SettingsCard, SettingsStatus } from "./shared";
import { useSettingsNavigationGuard } from "./navigation-guard";
import type { MemorySettingsControls } from "./types";
import { SettingsToggle } from "./settings-toggle";

export interface MemorySettingsPanelProps {
  setup: MemorySettingsControls;
}

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
    <SettingsCard title="Memory">
      <SettingPanel label="Use global memory">
        <SettingsToggle
          label="Global memory status"
          checked={setup.settings.globalEnabled}
          disabled={setup.saving}
          onCheckedChange={(checked) => {
            void setup.onGlobalEnabledChange(checked);
          }}
        />
      </SettingPanel>

      <SettingPanel label="Default workspace memory">
        <SettingsToggle
          label="Default workspace memory status"
          checked={setup.settings.workspaceDefaultEnabled !== false}
          disabled={setup.saving}
          onCheckedChange={(checked) => {
            void setup.onWorkspaceDefaultEnabledChange?.(checked);
          }}
        />
      </SettingPanel>

      <MemoryManagementTable
        entries={createMemoryManagementEntries(
          setup.settings.entries,
          setup.sourceSessions,
        )}
        emptyLabel="No global memory saved."
        disabled={setup.saving}
        onForget={setup.onForgetGlobal}
      />

      {setup.saving ? (
        <p role="status" aria-live="polite" className="text-sm text-slate-400">
          Updating memory…
        </p>
      ) : null}

      <SettingsStatus message={setup.message} />
    </SettingsCard>
  );
};
