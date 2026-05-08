import { ArrowUpRight, Eye, EyeOff } from "lucide-react";
import { useEffect, useRef, useState, type JSX, type ReactNode } from "react";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
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

export interface SettingsProviderChoiceProps<TValue extends string> {
  label: string;
  detail?: string;
  value: TValue;
  options: ReadonlyArray<ChoiceOption<TValue>>;
  disabled?: boolean;
  className?: string;
  contentClassName?: string;
  onChange: (value: TValue) => Promise<void> | void;
}

export function SettingsProviderChoice<TValue extends string>({
  label,
  detail,
  value,
  options,
  disabled,
  className,
  contentClassName,
  onChange,
}: SettingsProviderChoiceProps<TValue>): JSX.Element {
  return (
    <SettingPanel
      label={label}
      detail={detail}
      className={className}
      contentClassName={contentClassName}
    >
      <ChoiceButtons
        value={value}
        options={options}
        disabled={disabled}
        onChange={(nextValue) => {
          void onChange(nextValue);
        }}
      />
    </SettingPanel>
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

const getApiKeyValidationMessage = (
  providerLabel: string,
  draftKey: string,
  saveAttempted: boolean,
): SettingsStatusMessage | null => {
  if (!saveAttempted || draftKey.trim().length > 0) {
    return null;
  }

  return {
    tone: "error",
    text: `Enter a valid ${providerLabel} API key before saving.`,
  };
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

export interface CredentialPortalAction {
  label: string;
  title?: string;
  onClick: () => Promise<void> | void;
}

export interface SettingsCredentialFormProps {
  resetKey: string;
  providerLabel: string;
  keyValue: string;
  saving: boolean;
  message: SettingsStatusMessage | null;
  dirtyText: string;
  cleanText: string;
  saveLabel: string;
  keyLabel?: string;
  placeholder?: string;
  savingLabel?: string;
  portalAction?: CredentialPortalAction;
  onSave: (keyValue: string) => Promise<boolean> | boolean;
}

export const SettingsCredentialForm = ({
  resetKey,
  providerLabel,
  keyValue,
  saving,
  message,
  dirtyText,
  cleanText,
  saveLabel,
  keyLabel,
  placeholder,
  savingLabel = "Saving...",
  portalAction,
  onSave,
}: SettingsCredentialFormProps): JSX.Element => {
  const [draftKey, setDraftKey] = useState(keyValue);
  const [savedKey, setSavedKey] = useState(keyValue.trim());
  const [lastExternalKey, setLastExternalKey] = useState(keyValue);
  const [keyVisible, setKeyVisible] = useState(false);
  const [saveAttempted, setSaveAttempted] = useState(false);
  const lastResetKeyRef = useRef(resetKey);
  const normalizedDraftKey = draftKey.trim();
  const keyDirty = normalizedDraftKey !== savedKey;
  const validationMessage = getApiKeyValidationMessage(
    providerLabel,
    draftKey,
    saveAttempted || keyDirty,
  );

  useEffect(() => {
    if (lastResetKeyRef.current !== resetKey) {
      lastResetKeyRef.current = resetKey;
      setDraftKey(keyValue);
      setSavedKey(keyValue.trim());
      setLastExternalKey(keyValue);
      setKeyVisible(false);
      setSaveAttempted(false);
      return;
    }

    if (keyValue === lastExternalKey) {
      return;
    }

    setDraftKey((currentDraft) =>
      currentDraft.trim() === savedKey ? keyValue : currentDraft,
    );
    setSavedKey(keyValue.trim());
    setLastExternalKey(keyValue);
    setSaveAttempted(false);
  }, [keyValue, lastExternalKey, resetKey, savedKey]);

  const updateDraftKey = (value: string): void => {
    setDraftKey(value);

    if (saveAttempted && value.trim().length > 0) {
      setSaveAttempted(false);
    }
  };

  const saveDraftKey = async (): Promise<void> => {
    setSaveAttempted(true);

    if (normalizedDraftKey.length === 0) {
      return;
    }

    const saved = await onSave(normalizedDraftKey);

    if (saved) {
      setDraftKey(normalizedDraftKey);
      setSavedKey(normalizedDraftKey);
      setLastExternalKey(normalizedDraftKey);
      setSaveAttempted(false);
    }
  };

  return (
    <>
      <SettingPanel label={keyLabel ?? `${providerLabel} API key`}>
        <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
          <Input
            type={keyVisible ? "text" : "password"}
            value={draftKey}
            onChange={(event) => {
              updateDraftKey(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void saveDraftKey();
              }
            }}
            placeholder={placeholder ?? `Paste your ${providerLabel} API key`}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={validationMessage ? true : undefined}
            className="h-10 rounded-lg border-slate-800 bg-slate-950 text-slate-100 placeholder:text-slate-500"
          />
          <div className="flex items-center gap-2 md:justify-end">
            <Button
              type="button"
              variant="outline"
              size="icon"
              aria-label={`${keyVisible ? "Hide" : "Show"} ${providerLabel} API key`}
              title={`${keyVisible ? "Hide" : "Show"} ${providerLabel} API key`}
              onClick={() => setKeyVisible((visible) => !visible)}
              disabled={draftKey.trim().length === 0}
              className="h-10 w-10 rounded-lg border-slate-800 bg-slate-950 text-slate-300 hover:bg-slate-900 hover:text-slate-100 disabled:opacity-40"
            >
              {keyVisible ? (
                <EyeOff className="h-4 w-4" />
              ) : (
                <Eye className="h-4 w-4" />
              )}
            </Button>
            {portalAction ? (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={portalAction.label}
                title={portalAction.title ?? portalAction.label}
                onClick={() => {
                  void portalAction.onClick();
                }}
                className="h-10 w-10 rounded-lg border border-slate-800 bg-slate-950 text-slate-400 hover:bg-slate-900 hover:text-slate-100"
              >
                <ArrowUpRight className="h-4 w-4" />
              </Button>
            ) : null}
          </div>
        </div>
      </SettingPanel>

      <SettingsSaveBar
        dirty={keyDirty}
        dirtyText={dirtyText}
        cleanText={cleanText}
        saveLabel={saveLabel}
        savingLabel={savingLabel}
        saving={saving}
        onSave={() => {
          void saveDraftKey();
        }}
      />

      <SettingsStatus message={validationMessage ?? message} />
    </>
  );
};
