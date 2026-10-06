import { useState, type JSX } from "react";
import { AppearanceOptions } from "@machdoch/product-ui";
import { SettingsCard, SettingsStatus } from "./shared";
import type { AppearanceSettingsControls } from "./types";
import { useSettingsNavigationGuard } from "./navigation-guard";

export const AppearanceSettingsPanel = ({
  setup,
}: {
  setup: AppearanceSettingsControls;
}): JSX.Element => {
  const [saveError, setSaveError] = useState<string | null>(null);
  useSettingsNavigationGuard({
    dirty: setup.saving,
    title: "Saving appearance",
    description:
      "Wait for the appearance change to finish saving before leaving this section.",
    canDiscard: false,
    onDiscard: () => undefined,
  });
  return (
    <SettingsCard title="Interface">
      <AppearanceOptions
        settings={setup.settings}
        disabled={setup.saving}
        onChange={(settings) => {
          setSaveError(null);
          void Promise.resolve(setup.onSave(settings)).catch(
            (cause: unknown) => {
              console.error("Failed to save appearance settings", cause);
              setSaveError(
                "Appearance settings could not be saved. Try again.",
              );
            },
          );
        }}
      />
      {setup.saving ? <p role="status">Saving…</p> : null}
      <SettingsStatus
        message={saveError ? { tone: "error", text: saveError } : null}
      />
    </SettingsCard>
  );
};
