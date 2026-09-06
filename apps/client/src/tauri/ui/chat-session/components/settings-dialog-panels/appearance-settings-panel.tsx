import { Check } from "lucide-react";
import { useState, type JSX } from "react";
import { Button } from "../../../components/ui/button";
import { cn } from "../../../lib/utils";
import type {
  AppearanceAccent,
  AppearanceDensity,
  AppearanceTheme,
  QuickChatBubbleStyle,
} from "../../../lib/shell-store";
import {
  ChoiceButtons,
  SettingsCard,
  SettingsAutoSaveStatus,
  SettingsStatus,
  SettingPanel,
  type ChoiceOption,
} from "./shared";
import type { AppearanceSettingsControls } from "./types";
import { useSettingsNavigationGuard } from "./navigation-guard";

const THEME_OPTIONS = [
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
] as const satisfies ReadonlyArray<ChoiceOption<AppearanceTheme>>;

const DENSITY_OPTIONS = [
  { value: "comfortable", label: "Comfortable" },
  { value: "compact", label: "Compact" },
] as const satisfies ReadonlyArray<ChoiceOption<AppearanceDensity>>;

const ACCENT_OPTIONS = [
  {
    value: "sky",
    label: "Sky",
    swatchClassName: "bg-sky-500",
  },
  {
    value: "emerald",
    label: "Sage",
    swatchClassName: "bg-emerald-500",
  },
  {
    value: "violet",
    label: "Violet",
    swatchClassName: "bg-violet-500",
  },
  {
    value: "amber",
    label: "Amber",
    swatchClassName: "bg-amber-500",
  },
] as const satisfies ReadonlyArray<{
  value: AppearanceAccent;
  label: string;
  swatchClassName: string;
}>;

const QUICK_CHAT_BUBBLE_STYLE_OPTIONS = [
  { value: "classic", label: "Classic" },
  { value: "glass", label: "Glass" },
  { value: "pulse", label: "Pulse" },
  { value: "orbit", label: "Orbit" },
] as const satisfies ReadonlyArray<ChoiceOption<QuickChatBubbleStyle>>;

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
  const savePartial = (
    partial: Partial<AppearanceSettingsControls["settings"]>,
  ): void => {
    setSaveError(null);
    void Promise.resolve(
      setup.onSave({
        ...setup.settings,
        ...partial,
        version: 1,
      }),
    ).catch((error: unknown) => {
      console.error("Failed to save appearance settings", error);
      setSaveError("Appearance settings could not be saved. Try again.");
    });
  };

  return (
    <SettingsCard title="Interface">
      <SettingPanel label="Theme">
        <ChoiceButtons
          label="Theme"
          value={setup.settings.theme}
          options={THEME_OPTIONS}
          disabled={setup.saving}
          onChange={(theme) => savePartial({ theme })}
        />
      </SettingPanel>

      <SettingPanel label="Density">
        <ChoiceButtons
          label="Density"
          value={setup.settings.density}
          options={DENSITY_OPTIONS}
          disabled={setup.saving}
          onChange={(density) => savePartial({ density })}
        />
      </SettingPanel>

      <SettingPanel label="Accent">
        <div
          role="group"
          aria-label="Accent color"
          className="flex flex-wrap gap-2"
        >
          {ACCENT_OPTIONS.map((option) => {
            const selected = setup.settings.accent === option.value;

            return (
              <Button
                key={option.value}
                type="button"
                variant="outline"
                aria-pressed={selected}
                disabled={setup.saving}
                onClick={() => savePartial({ accent: option.value })}
                className={cn(
                  "h-9 rounded-lg border-slate-800 bg-slate-950/80 px-3 text-xs text-slate-300 hover:border-slate-700 hover:bg-slate-900 hover:text-slate-100",
                  selected && "border-sky-500/35 bg-sky-500/10 text-sky-100",
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn("h-3 w-3 rounded-full", option.swatchClassName)}
                />
                {option.label}
                {selected ? <Check className="h-3.5 w-3.5" /> : null}
              </Button>
            );
          })}
        </div>
      </SettingPanel>

      <SettingPanel label="Quick Chat bubble">
        <ChoiceButtons
          label="Quick Chat bubble style"
          value={setup.settings.quickChatBubbleStyle}
          options={QUICK_CHAT_BUBBLE_STYLE_OPTIONS}
          disabled={setup.saving}
          onChange={(quickChatBubbleStyle) =>
            savePartial({ quickChatBubbleStyle })
          }
        />
      </SettingPanel>

      <SettingsAutoSaveStatus
        dirty={false}
        dirtyText=""
        cleanText={saveError ? "" : "Appearance saved"}
        saving={setup.saving}
      />
      <SettingsStatus
        message={saveError ? { tone: "error", text: saveError } : null}
      />
    </SettingsCard>
  );
};
