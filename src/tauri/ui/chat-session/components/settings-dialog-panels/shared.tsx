import { ArrowUpRight, Eye, EyeOff } from "lucide-react";
import { useEffect, useRef, useState, type JSX, type ReactNode } from "react";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { cn } from "../../../lib/utils";
import type { SettingsStatusMessage } from "./types";

export const SETTINGS_AUTO_SAVE_DEBOUNCE_MS = 650;
const SETTINGS_AUTO_SAVE_MAX_ATTEMPTS = 3;

export const rebaseDirtySettingsDraft = <TSettings extends object>(
  currentDraft: TSettings,
  previousSettings: TSettings,
  nextSettings: TSettings,
): TSettings => {
  const rebasedDraft = { ...nextSettings };

  for (const key of Object.keys(currentDraft) as Array<keyof TSettings>) {
    if (currentDraft[key] !== previousSettings[key]) {
      rebasedDraft[key] = currentDraft[key];
    }
  }

  return rebasedDraft;
};

export interface UseDebouncedAutoSaveParams {
  dirty: boolean;
  saving: boolean;
  signature: string;
  delayMs?: number;
  onSave: () => Promise<void> | void;
}

export const useDebouncedAutoSave = ({
  dirty,
  saving,
  signature,
  delayMs = SETTINGS_AUTO_SAVE_DEBOUNCE_MS,
  onSave,
}: UseDebouncedAutoSaveParams): void => {
  const onSaveRef = useRef(onSave);
  const lastAttemptedSignatureRef = useRef<string | null>(null);
  const attemptCountRef = useRef(0);
  const activeSignatureRef = useRef(signature);
  const latestStateRef = useRef({ dirty, saving, signature });
  const previousSavingRef = useRef(saving);
  const [retrySequence, setRetrySequence] = useState(0);

  latestStateRef.current = { dirty, saving, signature };

  useEffect(() => {
    onSaveRef.current = onSave;
  }, [onSave]);

  useEffect(() => {
    const saveFinished = previousSavingRef.current && !saving;
    previousSavingRef.current = saving;

    if (!dirty) {
      lastAttemptedSignatureRef.current = null;
      attemptCountRef.current = 0;
      activeSignatureRef.current = signature;
      return;
    }

    if (activeSignatureRef.current !== signature) {
      activeSignatureRef.current = signature;
      attemptCountRef.current = 0;
      lastAttemptedSignatureRef.current = null;
    }

    if (
      saveFinished &&
      lastAttemptedSignatureRef.current === signature
    ) {
      // A completed save that left the same draft dirty failed or was
      // superseded. Allow it to be retried instead of suppressing that
      // signature forever.
      lastAttemptedSignatureRef.current = null;
    }

    if (
      saving ||
      lastAttemptedSignatureRef.current === signature ||
      attemptCountRef.current >= SETTINGS_AUTO_SAVE_MAX_ATTEMPTS
    ) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      lastAttemptedSignatureRef.current = signature;
      attemptCountRef.current += 1;
      void Promise.resolve(onSaveRef.current()).catch((error: unknown) => {
        console.error("Failed to auto-save settings", error);

        if (lastAttemptedSignatureRef.current === signature) {
          lastAttemptedSignatureRef.current = null;
          setRetrySequence((current) => current + 1);
        }
      });
    }, delayMs * 2 ** attemptCountRef.current);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [delayMs, dirty, retrySequence, saving, signature]);

  useEffect(() => {
    return () => {
      const latest = latestStateRef.current;

      if (
        latest.dirty &&
        !latest.saving &&
        lastAttemptedSignatureRef.current !== latest.signature
      ) {
        lastAttemptedSignatureRef.current = latest.signature;
        void Promise.resolve(onSaveRef.current()).catch((error: unknown) => {
          console.error("Failed to flush settings during unmount", error);
        });
      }
    };
  }, []);
};

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
  showValidation: boolean,
): SettingsStatusMessage | null => {
  if (!showValidation || draftKey.trim().length > 0) {
    return null;
  }

  return {
    tone: "error",
    text: `Enter a valid ${providerLabel} API key.`,
  };
};

export interface SettingsAutoSaveStatusProps {
  dirty: boolean;
  dirtyText: string;
  cleanText: string;
  saving: boolean;
  savingText?: string;
}

export const SettingsAutoSaveStatus = ({
  dirty,
  dirtyText,
  cleanText,
  saving,
  savingText = "Saving changes...",
}: SettingsAutoSaveStatusProps): JSX.Element => {
  return (
    <p className="border-t border-slate-800 pt-4 text-sm leading-6 text-slate-400">
      {saving ? savingText : dirty ? dirtyText : cleanText}
    </p>
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
  keyLabel?: string;
  placeholder?: string;
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
  keyLabel,
  placeholder,
  portalAction,
  onSave,
}: SettingsCredentialFormProps): JSX.Element => {
  const [draftKey, setDraftKey] = useState(keyValue);
  const [savedKey, setSavedKey] = useState(keyValue.trim());
  const [lastExternalKey, setLastExternalKey] = useState(keyValue);
  const [keyVisible, setKeyVisible] = useState(false);
  const lastResetKeyRef = useRef(resetKey);
  const draftKeyRef = useRef(draftKey);
  const editRevisionRef = useRef(0);
  const normalizedDraftKey = draftKey.trim();
  const keyDirty = normalizedDraftKey !== savedKey;
  const validationMessage = getApiKeyValidationMessage(
    providerLabel,
    draftKey,
    keyDirty,
  );

  useEffect(() => {
    if (lastResetKeyRef.current !== resetKey) {
      lastResetKeyRef.current = resetKey;
      setDraftKey(keyValue);
      setSavedKey(keyValue.trim());
      setLastExternalKey(keyValue);
      setKeyVisible(false);
      draftKeyRef.current = keyValue;
      editRevisionRef.current += 1;
      return;
    }

    if (keyValue === lastExternalKey) {
      return;
    }

    setDraftKey((currentDraft) => {
      const nextDraft = currentDraft.trim() === savedKey ? keyValue : currentDraft;
      draftKeyRef.current = nextDraft;
      return nextDraft;
    });
    setSavedKey(keyValue.trim());
    setLastExternalKey(keyValue);
  }, [keyValue, lastExternalKey, resetKey, savedKey]);

  const updateDraftKey = (value: string): void => {
    editRevisionRef.current += 1;
    draftKeyRef.current = value;
    setDraftKey(value);
  };

  const persistDraftKey = async (): Promise<void> => {
    if (normalizedDraftKey.length === 0) {
      return;
    }

    const submittedKey = normalizedDraftKey;
    const submittedRevision = editRevisionRef.current;
    const saved = await onSave(submittedKey);

    if (saved) {
      setSavedKey(submittedKey);
      setLastExternalKey(submittedKey);

      if (
        editRevisionRef.current === submittedRevision &&
        draftKeyRef.current.trim() === submittedKey
      ) {
        draftKeyRef.current = submittedKey;
        setDraftKey(submittedKey);
      }
    }
  };

  useDebouncedAutoSave({
    dirty: keyDirty && normalizedDraftKey.length > 0 && !validationMessage,
    saving,
    signature: `${resetKey}:${normalizedDraftKey}`,
    onSave: persistDraftKey,
  });

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
                void persistDraftKey();
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

      <SettingsAutoSaveStatus
        dirty={keyDirty && !validationMessage}
        dirtyText={dirtyText}
        cleanText={cleanText}
        saving={saving}
      />

      <SettingsStatus message={validationMessage ?? message} />
    </>
  );
};
