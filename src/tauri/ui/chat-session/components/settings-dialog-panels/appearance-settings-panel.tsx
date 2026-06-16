import { Check } from "lucide-react";
import type { JSX } from "react";
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
  SettingPanel,
  type ChoiceOption,
} from "./shared";
import type { AppearanceSettingsControls } from "./types";

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
  const savePartial = (
    partial: Partial<AppearanceSettingsControls["settings"]>,
  ): void => {
    void setup.onSave({
      ...setup.settings,
      ...partial,
      version: 1,
    });
  };

  return (
    <SettingsCard
      title="Appearance"
      description="Tune the shell without changing agent behavior."
    >
      <SettingPanel label="Theme">
        <ChoiceButtons
          value={setup.settings.theme}
          options={THEME_OPTIONS}
          disabled={setup.saving}
          onChange={(theme) => savePartial({ theme })}
        />
      </SettingPanel>

      <SettingPanel label="Density">
        <ChoiceButtons
          value={setup.settings.density}
          options={DENSITY_OPTIONS}
          disabled={setup.saving}
          onChange={(density) => savePartial({ density })}
        />
      </SettingPanel>

      <SettingPanel label="Accent">
        <div className="flex flex-wrap gap-2">
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
                  selected &&
                    "border-sky-500/35 bg-sky-500/10 text-sky-100",
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

      <SettingPanel
        label="Quick Chat bubble"
        detail="Controls the launcher material and attention treatment."
      >
        <ChoiceButtons
          value={setup.settings.quickChatBubbleStyle}
          options={QUICK_CHAT_BUBBLE_STYLE_OPTIONS}
          disabled={setup.saving}
          onChange={(quickChatBubbleStyle) =>
            savePartial({ quickChatBubbleStyle })
          }
        />
      </SettingPanel>

      <SettingPanel label="Preview" className="pb-0" contentClassName="max-w-xl">
        <div className="rounded-xl border border-slate-800 bg-slate-950/80 p-3 shadow-lg shadow-slate-950/20">
          <div className="flex items-center justify-between gap-3 border-b border-slate-800/80 pb-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-slate-100">
                Session shell
              </p>
              <p className="text-xs text-slate-400">
                {setup.settings.density === "compact"
                  ? "Compact workspace"
                  : "Comfortable workspace"}
              </p>
            </div>
            <span className="rounded-md bg-sky-500/15 px-2 py-1 text-xs font-medium text-sky-100">
              {setup.settings.theme}
            </span>
          </div>
          <div className="grid gap-2 pt-3">
            <div className="h-2.5 w-3/4 rounded-full bg-slate-800" />
            <div className="h-2.5 w-1/2 rounded-full bg-slate-800" />
            <div className="mt-1 flex gap-2">
              <div className="h-7 rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-medium text-white">
                Run
              </div>
              <div className="h-7 rounded-lg border border-slate-800 px-3 py-1.5 text-xs text-slate-300">
                Review
              </div>
            </div>
          </div>
        </div>
      </SettingPanel>
    </SettingsCard>
  );
};
