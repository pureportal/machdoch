import { MemoryManagementTable } from "@machdoch/product-ui";
import type { JSX } from "react";
import { createMemoryManagementEntries } from "../../../components/memory-management-entries";
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
    title: "Updating memory",
    description:
      "Wait for the memory update to finish before leaving this section.",
    canDiscard: false,
    onDiscard: () => undefined,
  });

  return (
    <SettingsCard title="Memory">
      <SettingPanel label="Global memory">
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

      <SettingPanel label="Default workspace memory">
        <ChoiceButtons
          label="Default workspace memory status"
          value={
            setup.settings.workspaceDefaultEnabled !== false
              ? "enabled"
              : "disabled"
          }
          options={[
            { value: "enabled", label: "Enabled" },
            { value: "disabled", label: "Disabled" },
          ]}
          disabled={setup.saving}
          onChange={(value) => {
            void setup.onWorkspaceDefaultEnabledChange?.(value === "enabled");
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
