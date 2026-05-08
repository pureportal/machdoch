import type { JSX, ReactNode } from "react";
import { Button } from "../../../components/ui/button";
import { cn } from "../../../lib/utils";
import type { SettingsStatusMessage } from "./types";

export interface SettingsCardProps {
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
}

export const SettingsCard = ({
  title,
  description,
  children,
  className,
}: SettingsCardProps): JSX.Element => {
  return (
    <section className={cn("grid content-start", className)}>
      <div className="grid gap-1 border-b border-slate-800/80 pb-4">
        <h3 className="text-base font-semibold text-slate-100">{title}</h3>
        {description ? (
          <p className="text-sm leading-6 text-slate-400">{description}</p>
        ) : null}
      </div>
      <div className="grid gap-0">{children}</div>
    </section>
  );
};

export interface SettingPanelProps {
  label: string;
  detail?: string;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
}

export const SettingPanel = ({
  label,
  detail,
  children,
  className,
  contentClassName,
}: SettingPanelProps): JSX.Element => {
  return (
    <div
      data-setting-panel
      className={cn(
        "grid gap-3 border-b border-slate-800/75 py-4 last:border-b-0 md:grid-cols-[12rem_minmax(0,1fr)] md:items-center",
        className,
      )}
    >
      <div className="grid gap-1">
        <p className="text-sm font-medium text-slate-300">{label}</p>
        {detail ? (
          <p className="text-sm leading-5 text-slate-400">{detail}</p>
        ) : null}
      </div>
      <div className={cn("min-w-0", contentClassName)}>{children}</div>
    </div>
  );
};

export interface ChoiceOption<TValue extends string> {
  value: TValue;
  label: string;
  ariaLabel?: string;
  disabled?: boolean;
}

export interface ChoiceButtonsProps<TValue extends string> {
  value: TValue;
  options: ReadonlyArray<ChoiceOption<TValue>>;
  disabled?: boolean;
  onChange: (value: TValue) => void;
}

export function ChoiceButtons<TValue extends string>({
  value,
  options,
  disabled = false,
  onChange,
}: ChoiceButtonsProps<TValue>): JSX.Element {
  return (
    <div className="inline-flex max-w-full flex-nowrap overflow-x-auto rounded-md border border-slate-800 bg-slate-950/90 p-0.5 [scrollbar-width:thin]">
      {options.map((option) => {
        const selected = value === option.value;

        return (
          <Button
            key={option.value}
            type="button"
            variant="outline"
            aria-label={option.ariaLabel}
            aria-pressed={selected}
            disabled={disabled || option.disabled}
            onClick={() => onChange(option.value)}
            className={cn(
              "h-8 shrink-0 rounded-[5px] border-transparent bg-transparent px-3 text-xs text-slate-300 shadow-none hover:border-slate-700 hover:bg-slate-900 hover:text-slate-100 disabled:opacity-40",
              selected &&
                "border-sky-500/30 bg-sky-500/15 text-sky-100 hover:bg-sky-500/20",
            )}
          >
            {option.label}
          </Button>
        );
      })}
    </div>
  );
}

export const SettingsStatus = ({
  message,
}: {
  message: SettingsStatusMessage | null;
}): JSX.Element | null => {
  if (!message) {
    return null;
  }

  return (
    <p
      className={cn(
        "rounded-lg border px-3 py-2 text-sm leading-5",
        message.tone === "error"
          ? "border-rose-500/20 bg-rose-500/10 text-rose-200"
          : "border-emerald-500/20 bg-emerald-500/10 text-emerald-200",
      )}
    >
      {message.text}
    </p>
  );
};

export interface SettingsSaveBarProps {
  dirty: boolean;
  dirtyText: string;
  cleanText: string;
  saveLabel: string;
  savingLabel: string;
  saving: boolean;
  disabled?: boolean;
  onSave: () => void;
}

export const SettingsSaveBar = ({
  dirty,
  dirtyText,
  cleanText,
  saveLabel,
  savingLabel,
  saving,
  disabled,
  onSave,
}: SettingsSaveBarProps): JSX.Element => {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-800 pt-4">
      <p className="text-sm leading-6 text-slate-400">
        {dirty ? dirtyText : cleanText}
      </p>
      <Button
        type="button"
        onClick={onSave}
        disabled={saving || disabled || !dirty}
        className="h-10 rounded-lg bg-sky-600 px-4 text-sm text-white hover:bg-sky-500 disabled:opacity-40"
      >
        {saving ? savingLabel : saveLabel}
      </Button>
    </div>
  );
};
