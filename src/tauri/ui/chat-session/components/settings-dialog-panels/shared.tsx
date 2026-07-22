import {
  AlertTriangle,
  ArrowUpRight,
  Eye,
  EyeOff,
  RefreshCw,
} from "lucide-react";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type JSX,
  type ReactNode,
  type RefObject,
} from "react";
import { Button } from "../../../components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../../components/ui/dialog";
import { Input } from "../../../components/ui/input";
import { cn } from "../../../lib/utils";
import {
  doctorProviderSync,
  getProviderSyncStatus,
  planProviderSync,
  refreshProviderSync,
  setProviderSyncEnabled,
  type ProviderSyncStatus,
} from "../../../runtime";
import { useSettingsNavigationGuard } from "./navigation-guard";
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
  suppressUnmountFlushRef?: RefObject<boolean>;
}

export const useDebouncedAutoSave = ({
  dirty,
  saving,
  signature,
  delayMs = SETTINGS_AUTO_SAVE_DEBOUNCE_MS,
  onSave,
  suppressUnmountFlushRef,
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

    if (saveFinished && lastAttemptedSignatureRef.current === signature) {
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

    const timeoutId = window.setTimeout(
      () => {
        lastAttemptedSignatureRef.current = signature;
        attemptCountRef.current += 1;
        void Promise.resolve(onSaveRef.current()).catch((error: unknown) => {
          console.error("Failed to auto-save settings", error);

          if (lastAttemptedSignatureRef.current === signature) {
            lastAttemptedSignatureRef.current = null;
            setRetrySequence((current) => current + 1);
          }
        });
      },
      delayMs * 2 ** attemptCountRef.current,
    );

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
        !suppressUnmountFlushRef?.current &&
        lastAttemptedSignatureRef.current !== latest.signature
      ) {
        lastAttemptedSignatureRef.current = latest.signature;
        void Promise.resolve(onSaveRef.current()).catch((error: unknown) => {
          console.error("Failed to flush settings during unmount", error);
        });
      }
    };
  }, [suppressUnmountFlushRef]);
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
  const titleId = useId();

  return (
    <section
      aria-labelledby={titleId}
      className={cn(
        "grid content-start rounded-xl border border-slate-800/80 bg-slate-950/40 shadow-sm shadow-black/10",
        className,
      )}
    >
      <div className="grid gap-1 border-b border-slate-800/80 bg-slate-900/40 px-4 py-3.5 sm:px-5">
        <h3 id={titleId} className="text-sm font-semibold text-slate-100">
          {title}
        </h3>
        {description ? (
          <p className="text-sm leading-5 text-slate-400">{description}</p>
        ) : null}
      </div>
      <div className="grid gap-3 px-4 pb-4 sm:px-5 sm:pb-5">{children}</div>
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
        "grid min-w-0 gap-3 border-b border-slate-800/75 py-4 last:border-b-0 md:grid-cols-[12rem_minmax(0,1fr)] md:items-center",
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
  title?: string;
  disabled?: boolean;
}

export interface ChoiceButtonsProps<TValue extends string> {
  value: TValue;
  options: ReadonlyArray<ChoiceOption<TValue>>;
  label?: string;
  disabled?: boolean;
  onChange: (value: TValue) => void;
}

export function ChoiceButtons<TValue extends string>({
  value,
  options,
  label,
  disabled = false,
  onChange,
}: ChoiceButtonsProps<TValue>): JSX.Element {
  return (
    <div
      role="group"
      aria-label={label}
      className="inline-flex max-w-full flex-wrap rounded-lg border border-slate-800 bg-slate-950/90 p-0.5"
    >
      {options.map((option) => {
        const selected = value === option.value;

        return (
          <Button
            key={option.value}
            type="button"
            variant="outline"
            aria-label={option.ariaLabel}
            title={option.title}
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
        label={label}
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
      role={message.tone === "error" ? "alert" : "status"}
      aria-live={message.tone === "error" ? "assertive" : "polite"}
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

export interface ProviderSyncControlProps {
  workspaceRoot: string | null;
  showDiagnostics?: boolean;
  className?: string;
}

export const ProviderSyncControl = ({
  workspaceRoot,
  showDiagnostics = false,
  className,
}: ProviderSyncControlProps): JSX.Element => {
  const warningId = useId();
  const [status, setStatus] = useState<ProviderSyncStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [message, setMessage] = useState<SettingsStatusMessage | null>(null);

  useEffect(() => {
    let active = true;
    setStatus(null);
    setMessage(null);
    void getProviderSyncStatus(workspaceRoot)
      .then((nextStatus) => {
        if (active) setStatus(nextStatus);
      })
      .catch((error: unknown) => {
        if (active) {
          setMessage({
            tone: "error",
            text: error instanceof Error ? error.message : String(error),
          });
        }
      });
    return () => {
      active = false;
    };
  }, [workspaceRoot]);

  const updateEnabled = async (enabled: boolean): Promise<void> => {
    setBusy(true);
    setMessage(null);
    try {
      const nextStatus = await setProviderSyncEnabled(workspaceRoot, enabled);
      setStatus(nextStatus);
      setMessage({
        tone: "success",
        text: enabled
          ? "Provider sync enabled. Machdoch now manages provider CLI instructions and MCP."
          : "Provider sync disabled. Machdoch-owned provider projections were removed.",
      });
    } catch (error) {
      setMessage({
        tone: "error",
        text: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(false);
    }
  };

  const runDiagnosticAction = async (
    action: "refresh" | "plan" | "doctor",
  ): Promise<void> => {
    setBusy(true);
    setMessage(null);
    try {
      if (action === "refresh") {
        const nextStatus = await refreshProviderSync(workspaceRoot);
        setStatus(nextStatus);
        setMessage({
          tone: "success",
          text: "Provider projections reconciled.",
        });
      } else if (action === "plan") {
        const plan = await planProviderSync(workspaceRoot);
        const providers = Array.isArray(plan.providers)
          ? plan.providers.length
          : 0;
        setMessage({
          tone: "success",
          text: `Plan is current for ${providers} provider surface${providers === 1 ? "" : "s"}.`,
        });
      } else {
        const doctor = await doctorProviderSync(workspaceRoot);
        setMessage({
          tone: doctor.healthy === true ? "success" : "error",
          text:
            doctor.healthy === true
              ? "Provider enrollment doctor reports complete coverage."
              : "Provider enrollment doctor found degraded or pending coverage.",
        });
      }
      setStatus(await getProviderSyncStatus(workspaceRoot));
    } catch (error) {
      setMessage({
        tone: "error",
        text: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(false);
    }
  };

  const enabled = status?.enabled === true;
  const unavailable = !workspaceRoot?.trim();

  return (
    <div
      className={cn(
        "grid gap-3 rounded-lg border border-slate-800 bg-slate-950/60 p-3",
        className,
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="grid min-w-0 gap-1">
          <p className="text-sm font-semibold text-slate-100">
            Sync Machdoch to provider CLIs
          </p>
          <p className="text-xs leading-5 text-slate-400">
            Keep Machdoch instructions and MCP servers available to Codex,
            Claude, and Copilot CLI.
          </p>
        </div>
        <Button
          type="button"
          role="switch"
          aria-label="Sync Machdoch to provider CLIs"
          aria-checked={enabled}
          aria-describedby={!enabled ? warningId : undefined}
          disabled={busy || status === null || unavailable}
          onClick={() => {
            if (enabled) {
              void updateEnabled(false);
            } else {
              setConfirmOpen(true);
            }
          }}
          className={cn(
            "h-9 min-w-24 rounded-full px-4 text-xs font-semibold",
            enabled
              ? "bg-emerald-400 text-slate-950 hover:bg-emerald-300"
              : "bg-slate-800 text-slate-200 hover:bg-slate-700",
          )}
        >
          {busy ? "Updating…" : enabled ? "Enabled" : "Disabled"}
        </Button>
      </div>

      {!enabled ? (
        <p
          id={warningId}
          className="flex items-start gap-2 text-xs leading-5 text-amber-200/80"
        >
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          Enabling removes existing provider-native instruction, MCP, and
          customization files or entries before syncing Machdoch settings.
        </p>
      ) : null}

      <p className="text-xs text-slate-500">
        {unavailable
          ? "Choose a workspace before enabling provider sync."
          : status === null
            ? "Loading provider sync status…"
            : `Sync ${enabled ? "enabled" : "disabled"}${status.daemon.running ? ` · daemon ${status.daemon.pid ?? "running"}` : " · daemon stopped"}`}
      </p>

      {showDiagnostics ? (
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={busy || unavailable || !enabled}
            onClick={() => void runDiagnosticAction("refresh")}
            className="h-8 rounded-lg border-slate-700 bg-slate-900 px-3 text-xs"
          >
            <RefreshCw className="h-3.5 w-3.5" /> Refresh
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={busy || unavailable}
            onClick={() => void runDiagnosticAction("plan")}
            className="h-8 rounded-lg border-slate-700 bg-slate-900 px-3 text-xs"
          >
            Plan
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={busy || unavailable}
            onClick={() => void runDiagnosticAction("doctor")}
            className="h-8 rounded-lg border-slate-700 bg-slate-900 px-3 text-xs"
          >
            Doctor
          </Button>
        </div>
      ) : null}

      {showDiagnostics && status?.targets.length ? (
        <div className="grid gap-1 text-xs text-slate-400 sm:grid-cols-2">
          {status.targets.map((target) => (
            <span key={`${target.provider}-${target.scope}`}>
              {target.provider} · {target.scope}: {target.state}
            </span>
          ))}
        </div>
      ) : null}
      <SettingsStatus message={message} />

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent
          role="alertdialog"
          aria-describedby={`${warningId}-dialog-description`}
          className="border-slate-800 bg-slate-950 text-slate-100 sm:max-w-md"
        >
          <DialogHeader>
            <DialogTitle>Replace provider-native configuration?</DialogTitle>
            <DialogDescription id={`${warningId}-dialog-description`}>
              Machdoch will back up and remove existing Codex, Claude, and
              Copilot instruction, MCP, and customization files or entries, then
              sync its own settings.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={busy}>
                Cancel
              </Button>
            </DialogClose>
            <Button
              type="button"
              disabled={busy}
              onClick={() => {
                setConfirmOpen(false);
                void updateEnabled(true);
              }}
              className="bg-amber-400 text-slate-950 hover:bg-amber-300"
            >
              Remove and enable
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
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
  onSaveNow?: () => Promise<void> | void;
  saveLabel?: string;
}

export const SettingsAutoSaveStatus = ({
  dirty,
  dirtyText,
  cleanText,
  saving,
  savingText = "Saving changes…",
  onSaveNow,
  saveLabel = "Save now",
}: SettingsAutoSaveStatusProps): JSX.Element => {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-800 pt-4">
      <p
        role="status"
        aria-live="polite"
        className="text-sm leading-6 text-slate-400"
      >
        {saving ? savingText : dirty ? dirtyText : cleanText}
      </p>
      {dirty && onSaveNow ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={saving}
          onClick={() => {
            void onSaveNow();
          }}
          className="border-slate-700 bg-slate-900 text-slate-200 hover:bg-slate-800 hover:text-white"
        >
          {saveLabel}
        </Button>
      ) : null}
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
  loading?: boolean;
  saving: boolean;
  message: SettingsStatusMessage | null;
  dirtyText: string;
  cleanText: string;
  keyLabel?: string;
  placeholder?: string;
  portalAction?: CredentialPortalAction;
  onDirtyChange?: (dirty: boolean) => void;
  onSave: (keyValue: string) => Promise<boolean> | boolean;
}

export const SettingsCredentialForm = ({
  resetKey,
  providerLabel,
  keyValue,
  loading = false,
  saving,
  message,
  dirtyText,
  cleanText,
  keyLabel,
  placeholder,
  portalAction,
  onDirtyChange,
  onSave,
}: SettingsCredentialFormProps): JSX.Element => {
  const [draftKey, setDraftKey] = useState(keyValue);
  const [savedKey, setSavedKey] = useState(keyValue.trim());
  const [lastExternalKey, setLastExternalKey] = useState(keyValue);
  const [keyVisible, setKeyVisible] = useState(false);
  const lastResetKeyRef = useRef(resetKey);
  const draftKeyRef = useRef(draftKey);
  const editRevisionRef = useRef(0);
  const suppressUnmountFlushRef = useRef(false);
  const normalizedDraftKey = draftKey.trim();
  const keyDirty = normalizedDraftKey !== savedKey;
  const validationMessage = getApiKeyValidationMessage(
    providerLabel,
    draftKey,
    keyDirty,
  );

  useSettingsNavigationGuard({
    dirty: keyDirty || saving,
    title: saving
      ? `Saving ${providerLabel} API key`
      : `Unsaved ${providerLabel} API key`,
    description: saving
      ? "Wait for the current credential save to finish before leaving this section."
      : "The edited credential has not been saved. Discard it to leave this section.",
    canDiscard: !saving,
    onDiscard: () => {
      suppressUnmountFlushRef.current = true;
      editRevisionRef.current += 1;
      draftKeyRef.current = savedKey;
      setDraftKey(savedKey);
      setKeyVisible(false);
    },
  });

  useEffect(() => {
    onDirtyChange?.(keyDirty);
  }, [keyDirty, onDirtyChange]);

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
      const nextDraft =
        currentDraft.trim() === savedKey ? keyValue : currentDraft;
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
    if (loading || normalizedDraftKey.length === 0) {
      return;
    }

    const submittedKey = normalizedDraftKey;
    const submittedRevision = editRevisionRef.current;
    const saved = await onSave(submittedKey);

    if (saved) {
      setSavedKey(submittedKey);

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
    saving: saving || loading,
    signature: `${resetKey}:${normalizedDraftKey}`,
    onSave: persistDraftKey,
    suppressUnmountFlushRef,
  });

  return (
    <>
      <SettingPanel label={keyLabel ?? `${providerLabel} API key`}>
        <div className="grid gap-2">
          <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
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
              aria-label={keyLabel ?? `${providerLabel} API key`}
              aria-invalid={validationMessage ? true : undefined}
              className="h-10 rounded-lg border-slate-800 bg-slate-950 text-slate-100 placeholder:text-slate-500"
            />
            <div className="flex items-center gap-2 sm:justify-end">
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

          {keyDirty ? (
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={saving || loading}
                onClick={() => {
                  editRevisionRef.current += 1;
                  draftKeyRef.current = savedKey;
                  setDraftKey(savedKey);
                  setKeyVisible(false);
                }}
                className="text-slate-400 hover:bg-slate-900 hover:text-slate-100"
              >
                Restore saved key
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={saving || loading || normalizedDraftKey.length === 0}
                onClick={() => {
                  void persistDraftKey();
                }}
                className="bg-sky-500 text-slate-950 hover:bg-sky-400"
              >
                Save key
              </Button>
            </div>
          ) : null}
        </div>
      </SettingPanel>

      <SettingsAutoSaveStatus
        dirty={keyDirty}
        dirtyText={
          validationMessage ? "Fix the API key before saving" : dirtyText
        }
        cleanText={cleanText}
        saving={saving || loading}
        savingText={loading ? "Loading saved key…" : undefined}
      />

      <SettingsStatus message={validationMessage ?? message} />
    </>
  );
};
