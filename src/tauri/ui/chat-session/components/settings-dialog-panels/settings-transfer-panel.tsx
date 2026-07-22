import { open, save } from "@tauri-apps/plugin-dialog";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Check,
  CheckCircle2,
  ChevronDown,
  Copy,
  LoaderCircle,
  Network,
  RefreshCw,
  ShieldCheck,
  Wifi,
  X,
  XCircle,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
} from "react";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { Textarea } from "../../../components/ui/textarea";
import { cn } from "../../../lib/utils";
import {
  approveSettingsTransfer,
  cancelEncryptedSettingsFileImport,
  commitEncryptedSettingsFileImport,
  confirmSettingsTransferPairing,
  connectDiscoveredSettingsTransfer,
  connectManualSettingsTransfer,
  exportEncryptedSettingsFile,
  getSettingsTransferCatalog,
  inspectEncryptedSettingsFile,
  isActiveTransferPhase,
  startSettingsReceive,
  startSettingsTransfer,
  stopSettingsTransfer,
  subscribeToSettingsTransfer,
  type CategoryEffect,
  type EncryptedSettingsFileExportResult,
  type EncryptedSettingsFileImportResult,
  type EncryptedSettingsFileImportReview,
  type SettingsCategoryId,
  type SettingsTransferCategory,
  type SettingsTransferMode,
  type SettingsTransferStatus,
} from "../../../settings-transfer";
import { useSettingsNavigationGuard } from "./navigation-guard";
import { SettingsCard } from "./shared";

type EncryptedFileMode = "fileExport" | "fileImport";
type ConfigurationMode = "landing" | SettingsTransferMode | EncryptedFileMode;
const MAX_MANUAL_CODE_LENGTH = 2_200;
const FILE_PASSPHRASE_MAX_BYTES = 1_024;

const isSelectableCategory = (category: SettingsTransferCategory): boolean =>
  category.availability !== "unavailable" &&
  category.availability !== "unsupported";

const utf8ByteLength = (value: string): number => {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    bytes +=
      codePoint <= 0x7f
        ? 1
        : codePoint <= 0x7ff
          ? 2
          : codePoint <= 0xffff
            ? 3
            : 4;
  }
  return bytes;
};

const createFileInspectionId = (): string => {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
};

const formatCount = (count: number): string =>
  `${count.toLocaleString()} ${count === 1 ? "item" : "items"}`;

const effectPresentation: Record<
  CategoryEffect,
  { label: string; className: string }
> = {
  replace: {
    label: "Replace",
    className: "border-sky-500/30 bg-sky-500/10 text-sky-200",
  },
  clear: {
    label: "Clear",
    className: "border-rose-500/30 bg-rose-500/10 text-rose-200",
  },
  preserveNotSelected: {
    label: "Unchanged — not selected",
    className: "border-slate-700 bg-slate-900/70 text-slate-300",
  },
  preserveNotOffered: {
    label: "Unchanged — not included",
    className: "border-slate-700 bg-slate-900/70 text-slate-300",
  },
  preserveUnavailable: {
    label: "Unchanged — unavailable",
    className: "border-amber-500/30 bg-amber-500/10 text-amber-200",
  },
  preserveIncompatible: {
    label: "Unchanged — incompatible",
    className: "border-amber-500/30 bg-amber-500/10 text-amber-200",
  },
};

const toErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const getTransferPhaseLabel = (
  phase: SettingsTransferStatus["phase"],
): string => {
  switch (phase) {
    case "inspecting":
      return "Preparing settings…";
    case "connecting":
      return "Connecting…";
    case "transferring":
      return "Transferring settings…";
    case "validating":
      return "Checking settings…";
    case "committing":
      return "Applying settings…";
    case "rollingBack":
      return "Restoring previous settings…";
    default:
      return "Working…";
  }
};

const fileImportFailureMessage = (error: unknown): string => {
  const message = toErrorMessage(error);
  if (message.includes("COMMIT_AND_ROLLBACK_FAILED")) {
    return "The import failed and Machdoch could not verify that every original setting was restored. Restart Machdoch now so startup recovery can finish before using or changing settings.";
  }
  if (
    message.includes("COMMIT_ROLLED_BACK_CLEANUP_PENDING") ||
    message.includes("PREPARED_TRANSACTION_CLEANUP_PENDING") ||
    message.includes("still requires recovery") ||
    message.includes("import task stopped unexpectedly")
  ) {
    return "The import was not accepted, but its private recovery cleanup is still pending. Restart Machdoch before retrying the import.";
  }
  if (message.includes("RECEIVER_SETTINGS_CHANGED")) {
    return "Settings changed after the review. Inspect the encrypted file again before retrying.";
  }
  return `${message} Inspect the file again before retrying.`;
};

const CategorySelection = ({
  categories,
  selected,
  disabled,
  onToggle,
}: {
  categories: SettingsTransferCategory[];
  selected: ReadonlySet<SettingsCategoryId>;
  disabled: boolean;
  onToggle: (id: SettingsCategoryId) => void;
}): JSX.Element => (
  <div className="grid gap-2">
    {categories.map((category) => {
      const unavailable = ["unavailable", "unsupported"].includes(
        category.availability,
      );
      const checked = selected.has(category.id);

      return (
        <label
          key={category.id}
          className={cn(
            "grid cursor-pointer grid-cols-[auto_minmax(0,1fr)] gap-3 rounded-xl border border-slate-800 bg-slate-950/60 px-4 py-3 transition-colors hover:border-slate-700",
            checked && "border-sky-500/30 bg-sky-500/5",
            (disabled || unavailable) && "cursor-not-allowed opacity-65",
          )}
        >
          <input
            type="checkbox"
            checked={checked}
            disabled={disabled || unavailable}
            onChange={() => onToggle(category.id)}
            className="mt-1 size-4 accent-sky-500"
          />
          <span className="grid min-w-0 gap-1">
            <span className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium text-slate-100">
                {category.label}
              </span>
              {category.sensitive ? (
                <span className="rounded-full border border-amber-500/25 bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium tracking-wide text-amber-200 uppercase">
                  Sensitive
                </span>
              ) : null}
              <span className="text-xs text-slate-500">
                {formatCount(category.itemCount)}
              </span>
            </span>
            {category.reason ? (
              <span className="text-xs leading-5 text-rose-300">
                Unavailable: {category.reason}
              </span>
            ) : null}
          </span>
        </label>
      );
    })}
  </div>
);

const InterfaceSelection = ({
  status,
  selected,
  disabled,
  onToggle,
}: {
  status: SettingsTransferStatus;
  selected: ReadonlySet<string>;
  disabled: boolean;
  onToggle: (id: string) => void;
}): JSX.Element => (
  <details className="group rounded-xl border border-slate-800 bg-slate-950/55">
    <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm text-slate-300">
      <span className="flex items-center gap-2">
        <Network className="size-4 text-sky-300" />
        Network interfaces ({selected.size} selected)
      </span>
      <ChevronDown className="size-4 transition-transform group-open:rotate-180" />
    </summary>
    <div className="grid gap-2 border-t border-slate-800 px-4 py-3">
      {status.networkInterfaces.map((networkInterface) => (
        <label
          key={networkInterface.id}
          className="grid cursor-pointer grid-cols-[auto_minmax(0,1fr)] gap-3 rounded-lg border border-slate-800/80 bg-slate-950 px-3 py-2"
        >
          <input
            type="checkbox"
            checked={selected.has(networkInterface.id)}
            disabled={disabled}
            onChange={() => onToggle(networkInterface.id)}
            className="mt-1 size-4 accent-sky-500"
          />
          <span className="grid min-w-0 gap-0.5">
            <span className="flex flex-wrap items-center gap-2 text-sm text-slate-200">
              {networkInterface.name}
              {networkInterface.recommended ? (
                <span className="text-[10px] font-medium text-emerald-300 uppercase">
                  Recommended
                </span>
              ) : null}
            </span>
            <span className="break-all text-xs text-slate-500">
              {networkInterface.addresses.join(" · ")}
            </span>
            {networkInterface.reason ? (
              <span className="text-xs text-amber-300/85">
                {networkInterface.reason}
              </span>
            ) : null}
          </span>
        </label>
      ))}
      {status.networkInterfaces.length === 0 ? (
        <p className="text-xs text-rose-300">
          No usable directly connected interface was found.
        </p>
      ) : null}
    </div>
  </details>
);

const ReviewCategories = ({
  categories,
}: {
  categories: SettingsTransferCategory[];
}): JSX.Element => (
  <div className="grid gap-2" aria-label="Category replacement preview">
    {categories.map((category) => {
      const effect = category.effect
        ? effectPresentation[category.effect]
        : null;
      return (
        <div
          key={category.id}
          className="grid gap-2 rounded-xl border border-slate-800 bg-slate-950/60 px-4 py-3"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm font-medium text-slate-100">
              {category.label}
            </span>
            {effect ? (
              <span
                className={cn(
                  "rounded-full border px-2.5 py-1 text-[11px] font-medium",
                  effect.className,
                )}
              >
                {effect.label}
              </span>
            ) : null}
          </div>
          {category.reason ? (
            <p className="text-xs leading-5 text-amber-300/90">
              {category.reason}
            </p>
          ) : null}
        </div>
      );
    })}
  </div>
);

const PairingCategorySummary = ({
  status,
}: {
  status: SettingsTransferStatus;
}): JSX.Element => {
  const labels = new Map(
    status.categories.map((category) => [category.id, category.label]),
  );

  return (
    <div
      className="grid w-full max-w-lg gap-2 rounded-xl border border-slate-800 bg-slate-950/60 px-4 py-3 text-left"
      aria-label="Settings in this transfer"
    >
      <p className="text-xs font-medium text-slate-300">
        Settings in this transfer ({status.effectiveCategories.length})
      </p>
      {status.effectiveCategories.length > 0 ? (
        <ul className="flex flex-wrap gap-2 text-xs text-slate-400">
          {status.effectiveCategories.map((id) => (
            <li key={id} className="rounded-full bg-slate-900 px-2.5 py-1">
              {labels.get(id) ?? id}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-slate-500">No matching settings</p>
      )}
    </div>
  );
};

type EncryptedFileResult =
  | { mode: "fileExport"; value: EncryptedSettingsFileExportResult }
  | { mode: "fileImport"; value: EncryptedSettingsFileImportResult };

const EncryptedSettingsFilePanel = ({
  mode,
  catalog,
  onBack,
  onDone,
  onBusyChange,
}: {
  mode: EncryptedFileMode;
  catalog: SettingsTransferStatus;
  onBack: () => void;
  onDone: () => Promise<void>;
  onBusyChange: (busy: boolean) => void;
}): JSX.Element => {
  const [selectedCategories, setSelectedCategories] = useState<
    Set<SettingsCategoryId>
  >(
    () =>
      new Set(
        catalog.categories
          .filter(
            (category) => category.selected && isSelectableCategory(category),
          )
          .map((category) => category.id),
      ),
  );
  const [filePath, setFilePath] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [passphraseConfirmation, setPassphraseConfirmation] = useState("");
  const [review, setReview] =
    useState<EncryptedSettingsFileImportReview | null>(null);
  const [result, setResult] = useState<EncryptedFileResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const mounted = useRef(true);
  const operationInFlight = useRef(false);
  const inspectionOperationId = useRef<string | null>(null);

  useEffect(() => {
    onBusyChange(busy);

    return () => {
      onBusyChange(false);
    };
  }, [busy, onBusyChange]);

  useEffect(() => {
    const selectable = new Set(
      catalog.categories
        .filter(isSelectableCategory)
        .map((category) => category.id),
    );
    setSelectedCategories((current) => {
      const next = new Set([...current].filter((id) => selectable.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [catalog.categories]);

  const cancelCurrentInspection = useCallback(async (): Promise<void> => {
    const operationId = inspectionOperationId.current;
    if (!operationId) return;
    await cancelEncryptedSettingsFileImport(operationId);
    if (inspectionOperationId.current === operationId) {
      inspectionOperationId.current = null;
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      void cancelCurrentInspection().catch(() => undefined);
    };
  }, [cancelCurrentInspection]);

  useEffect(() => {
    if (!review?.token || !review.reviewExpiresAt || busy) return;
    const token = review.token;
    const timer = window.setTimeout(
      () => {
        if (!mounted.current) return;
        void (async () => {
          if (!beginOperation()) return;
          try {
            await cancelCurrentInspection().catch(() => undefined);
          } finally {
            if (mounted.current) {
              setReview((current) =>
                current?.token === token ? null : current,
              );
              setLocalError(
                "The encrypted settings file review expired. Inspect the file again.",
              );
            }
            finishOperation();
          }
        })();
      },
      Math.max(0, review.reviewExpiresAt - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [busy, review]);

  const selectedCategoryList = useMemo(
    () => [...selectedCategories].sort(),
    [selectedCategories],
  );

  const toggleCategory = (id: SettingsCategoryId): void => {
    setSelectedCategories((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const beginOperation = (): boolean => {
    if (operationInFlight.current) return false;
    operationInFlight.current = true;
    setBusy(true);
    setLocalError(null);
    return true;
  };

  const finishOperation = (): void => {
    operationInFlight.current = false;
    if (mounted.current) setBusy(false);
  };

  const chooseFile = async (): Promise<void> => {
    if (!beginOperation()) return;
    try {
      const selected =
        mode === "fileExport"
          ? await save({
              title: "Export Encrypted Machdoch Settings",
              defaultPath: `machdoch-settings-${new Date().toISOString().slice(0, 10)}.machdoch-settings`,
              filters: [
                {
                  name: "Machdoch encrypted settings",
                  extensions: ["machdoch-settings"],
                },
              ],
            })
          : await open({
              title: "Import Encrypted Machdoch Settings",
              directory: false,
              multiple: false,
              filters: [
                {
                  name: "Machdoch encrypted settings",
                  extensions: ["machdoch-settings"],
                },
              ],
            });
      if (mounted.current && typeof selected === "string")
        setFilePath(selected);
    } catch (error) {
      if (mounted.current) setLocalError(toErrorMessage(error));
    } finally {
      finishOperation();
    }
  };

  const exportFile = async (): Promise<void> => {
    if (passphrase !== passphraseConfirmation) {
      setLocalError("The passphrases do not match.");
      return;
    }
    if (!beginOperation()) return;
    const submittedPassphrase = passphrase;
    setPassphrase("");
    setPassphraseConfirmation("");
    try {
      const value = await exportEncryptedSettingsFile({
        categories: selectedCategoryList,
        destinationPath: filePath,
        passphrase: submittedPassphrase,
      });
      if (mounted.current) setResult({ mode: "fileExport", value });
    } catch (error) {
      if (mounted.current) setLocalError(toErrorMessage(error));
    } finally {
      finishOperation();
    }
  };

  const inspectFile = async (): Promise<void> => {
    if (!beginOperation()) return;
    const submittedPassphrase = passphrase;
    setPassphrase("");
    let operationId: string | null = null;
    let retainedReview = false;
    try {
      operationId = createFileInspectionId();
      inspectionOperationId.current = operationId;
      const value = await inspectEncryptedSettingsFile({
        operationId,
        categories: selectedCategoryList,
        sourcePath: filePath,
        passphrase: submittedPassphrase,
      });
      if (mounted.current) {
        retainedReview = value.token !== null;
        if (!retainedReview && inspectionOperationId.current === operationId) {
          inspectionOperationId.current = null;
        }
        setReview(value);
      }
    } catch (error) {
      if (mounted.current) {
        setReview(null);
        setLocalError(toErrorMessage(error));
      }
    } finally {
      if (!retainedReview && operationId) {
        await cancelEncryptedSettingsFileImport(operationId).catch(
          () => undefined,
        );
        if (inspectionOperationId.current === operationId) {
          inspectionOperationId.current = null;
        }
      }
      finishOperation();
    }
  };

  const commitImport = async (): Promise<void> => {
    if (!review?.token) return;
    if (!beginOperation()) return;
    const token = review.token;
    try {
      const value = await commitEncryptedSettingsFileImport(token);
      if (mounted.current) {
        setResult({ mode: "fileImport", value });
        setReview(null);
      }
    } catch (error) {
      if (mounted.current) {
        setReview(null);
        setLocalError(fileImportFailureMessage(error));
      }
    } finally {
      await cancelCurrentInspection().catch(() => undefined);
      finishOperation();
    }
  };

  const finish = async (): Promise<void> => {
    if (!beginOperation()) return;
    try {
      if (mounted.current) await onDone();
    } catch (error) {
      if (mounted.current) setLocalError(toErrorMessage(error));
    } finally {
      finishOperation();
    }
  };

  const back = async (): Promise<void> => {
    if (!beginOperation()) return;
    try {
      await cancelCurrentInspection();
      if (mounted.current) onBack();
    } catch (error) {
      if (mounted.current) setLocalError(toErrorMessage(error));
    } finally {
      finishOperation();
    }
  };

  const chooseAnotherFile = async (): Promise<void> => {
    if (!beginOperation()) return;
    try {
      await cancelCurrentInspection();
      if (mounted.current) {
        setReview(null);
        setFilePath("");
        setLocalError(null);
      }
    } catch (error) {
      if (mounted.current) setLocalError(toErrorMessage(error));
    } finally {
      finishOperation();
    }
  };

  if (result) {
    const imported = result.mode === "fileImport";
    return (
      <SettingsCard
        title={
          imported
            ? "Encrypted settings imported"
            : "Encrypted settings exported"
        }
      >
        <div className="grid justify-items-center gap-4 py-8 text-center">
          <span className="flex size-14 items-center justify-center rounded-full border border-emerald-500/30 bg-emerald-500/10 text-emerald-300">
            <CheckCircle2 className="size-7" />
          </span>
          <div className="grid max-w-xl gap-2">
            <p className="text-sm leading-6 text-slate-400">
              {imported
                ? `${result.value.categories.length} categories imported.`
                : `${result.value.categories.length} categories exported (${formatCount(result.value.itemCount)}).`}
            </p>
            {imported && result.value.recoveryCleanupPending ? (
              <p className="text-xs leading-5 text-amber-300">
                Restart Machdoch to finish cleanup.
              </p>
            ) : null}
          </div>
          <Button
            type="button"
            disabled={busy}
            onClick={() => void finish()}
            className="bg-slate-100 text-slate-950 hover:bg-white"
          >
            {busy ? (
              <LoaderCircle className="size-4 animate-spin" />
            ) : (
              <Check className="size-4" />
            )}
            {busy ? "Refreshing settings…" : "Done"}
          </Button>
          {localError ? (
            <p role="alert" className="text-sm text-rose-300">
              {localError}
            </p>
          ) : null}
        </div>
      </SettingsCard>
    );
  }

  if (review) {
    return (
      <SettingsCard
        title="Review encrypted file"
        description="Review what will change before replacing settings."
      >
        <div className="grid gap-4 py-5">
          {review.reviewExpiresAt ? (
            <p className="text-xs text-slate-500">
              Review expires at{" "}
              {new Date(review.reviewExpiresAt).toLocaleTimeString()}.
            </p>
          ) : null}
          <ReviewCategories categories={review.categories} />
          {review.token ? (
            <div className="rounded-xl border border-amber-500/25 bg-amber-500/5 px-4 py-3 text-xs leading-5 text-amber-100/85">
              Selected categories replace existing settings; they are not
              merged.
            </div>
          ) : (
            <p className="text-sm text-amber-300">
              None of the selected categories are in this file.
            </p>
          )}
          {localError ? (
            <p role="alert" className="text-sm text-rose-300">
              {localError}
            </p>
          ) : null}
          <div className="flex flex-wrap justify-between gap-3 border-t border-slate-800 pt-4">
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => void back()}
              className="text-slate-400 hover:bg-slate-900 hover:text-slate-100"
            >
              Cancel
            </Button>
            {review.token ? (
              <Button
                type="button"
                disabled={busy}
                onClick={() => void commitImport()}
                className="bg-rose-500 text-white hover:bg-rose-400"
              >
                {busy ? <LoaderCircle className="size-4 animate-spin" /> : null}
                {busy ? "Importing settings…" : "Replace selected settings"}
              </Button>
            ) : (
              <Button
                type="button"
                disabled={busy}
                onClick={() => void chooseAnotherFile()}
                variant="outline"
              >
                Choose another file
              </Button>
            )}
          </div>
        </div>
      </SettingsCard>
    );
  }

  const exporting = mode === "fileExport";
  const passphraseIsLongEnough = [...passphrase].length >= 12;
  const passphraseFits =
    utf8ByteLength(passphrase) <= FILE_PASSPHRASE_MAX_BYTES;
  return (
    <SettingsCard
      title={exporting ? "Export Encrypted File" : "Import Encrypted File"}
      description={
        exporting
          ? "Choose settings, a file location, and a passphrase."
          : "Choose settings to replace, then select the encrypted file."
      }
    >
      <div className="grid gap-5 py-5">
        <CategorySelection
          categories={catalog.categories}
          selected={selectedCategories}
          disabled={busy}
          onToggle={toggleCategory}
        />
        <div className="grid gap-2">
          <span className="text-sm font-medium text-slate-300">
            {exporting
              ? "Encrypted file destination"
              : "Encrypted settings file"}
          </span>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              readOnly
              value={filePath}
              aria-label={
                exporting
                  ? "Encrypted file destination"
                  : "Encrypted settings file"
              }
              placeholder={
                exporting
                  ? "Choose where to save the file"
                  : "Choose a .machdoch-settings file"
              }
              className="min-w-0 flex-1 border-slate-800 bg-slate-950 text-slate-300"
            />
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => void chooseFile()}
              className="border-slate-700 bg-slate-900 text-slate-200 hover:bg-slate-800"
            >
              {exporting ? "Choose destination" : "Choose file"}
            </Button>
          </div>
        </div>
        <div className="grid gap-2">
          <label
            htmlFor="encrypted-settings-passphrase"
            className="text-sm font-medium text-slate-300"
          >
            File passphrase
          </label>
          <Input
            id="encrypted-settings-passphrase"
            type="password"
            value={passphrase}
            maxLength={1024}
            disabled={busy}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setPassphrase(event.target.value)}
            className="border-slate-800 bg-slate-950 text-slate-100"
          />
          {exporting ? (
            <>
              <label
                htmlFor="encrypted-settings-passphrase-confirmation"
                className="text-sm font-medium text-slate-300"
              >
                Confirm passphrase
              </label>
              <Input
                id="encrypted-settings-passphrase-confirmation"
                type="password"
                value={passphraseConfirmation}
                maxLength={1024}
                disabled={busy}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) =>
                  setPassphraseConfirmation(event.target.value)
                }
                className="border-slate-800 bg-slate-950 text-slate-100"
              />
              <p className="text-xs leading-5 text-slate-500">
                Use at least 12 characters and at most 1,024 UTF-8 bytes. A lost
                passphrase cannot be recovered.
              </p>
            </>
          ) : null}
        </div>
        {localError ? (
          <p role="alert" className="text-sm text-rose-300">
            {localError}
          </p>
        ) : null}
        <div className="flex flex-wrap justify-between gap-3 border-t border-slate-800 pt-4">
          <Button
            type="button"
            variant="ghost"
            disabled={busy}
            onClick={() => void back()}
            className="text-slate-400 hover:bg-slate-900 hover:text-slate-100"
          >
            Back
          </Button>
          <Button
            type="button"
            disabled={
              busy ||
              selectedCategories.size === 0 ||
              filePath.length === 0 ||
              passphrase.length === 0 ||
              !passphraseFits ||
              (exporting &&
                (!passphraseIsLongEnough ||
                  passphrase !== passphraseConfirmation))
            }
            onClick={() => void (exporting ? exportFile() : inspectFile())}
            className="bg-sky-500 text-slate-950 hover:bg-sky-400"
          >
            {busy ? <LoaderCircle className="size-4 animate-spin" /> : null}
            {busy
              ? exporting
                ? "Encrypting and writing…"
                : "Authenticating and validating…"
              : exporting
                ? "Export encrypted file"
                : "Review encrypted file"}
          </Button>
        </div>
      </div>
    </SettingsCard>
  );
};

export const SettingsTransferPanel = (): JSX.Element => {
  const [status, setStatus] = useState<SettingsTransferStatus | null>(null);
  const [configurationMode, setConfigurationMode] =
    useState<ConfigurationMode>("landing");
  const [selectedCategories, setSelectedCategories] = useState<
    Set<SettingsCategoryId>
  >(new Set());
  const [selectedInterfaces, setSelectedInterfaces] = useState<Set<string>>(
    new Set(),
  );
  const [displayName, setDisplayName] = useState("This PC");
  const [manualCode, setManualCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [fileOperationBusy, setFileOperationBusy] = useState(false);
  const [pendingPhaseAction, setPendingPhaseAction] = useState<
    "pairing" | "review" | null
  >(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(Date.now());
  const copiedResetTimer = useRef<number | null>(null);
  const statusEventSequence = useRef(0);
  const operationInFlight = useRef(false);

  const applyCatalog = useCallback((catalog: SettingsTransferStatus): void => {
    setStatus(catalog);
    setSelectedCategories(
      new Set(
        catalog.categories
          .filter((category) => category.selected)
          .map((category) => category.id),
      ),
    );
    setSelectedInterfaces(
      new Set(
        catalog.networkInterfaces
          .filter((networkInterface) => networkInterface.selected)
          .map((networkInterface) => networkInterface.id),
      ),
    );
  }, []);

  useEffect(() => {
    let disposed = false;
    let unsubscribe: (() => void) | undefined;

    void subscribeToSettingsTransfer((nextStatus) => {
      if (disposed) return;
      statusEventSequence.current += 1;
      if (nextStatus.phase === "idle" && nextStatus.mode === null) {
        applyCatalog(nextStatus);
      } else {
        setStatus(nextStatus);
      }
    })
      .then((cleanup) => {
        if (disposed) cleanup();
        else unsubscribe = cleanup;
      })
      .catch((error: unknown) => {
        if (!disposed) setLocalError(toErrorMessage(error));
      });

    const sequenceBeforeCatalog = statusEventSequence.current;
    void getSettingsTransferCatalog()
      .then((catalog) => {
        // An event emitted while catalog inspection was running is newer than
        // this response. The idle catalog event applies its own selections;
        // an active event must not be overwritten by a stale idle response.
        if (
          !disposed &&
          statusEventSequence.current === sequenceBeforeCatalog
        ) {
          applyCatalog(catalog);
        }
      })
      .catch((error: unknown) => {
        if (!disposed) setLocalError(toErrorMessage(error));
      });

    return () => {
      disposed = true;
      if (copiedResetTimer.current !== null) {
        window.clearTimeout(copiedResetTimer.current);
      }
      unsubscribe?.();
      void stopSettingsTransfer().catch(() => undefined);
    };
  }, [applyCatalog]);

  useEffect(() => {
    if (!status?.expiresAt || !isActiveTransferPhase(status.phase)) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [status?.expiresAt, status?.phase]);

  useEffect(() => {
    if (pendingPhaseAction && status?.phase !== pendingPhaseAction) {
      setPendingPhaseAction(null);
    }
  }, [pendingPhaseAction, status?.phase]);

  const selectedCategoryList = useMemo(
    () => [...selectedCategories].sort(),
    [selectedCategories],
  );
  const selectedInterfaceList = useMemo(
    () => [...selectedInterfaces].sort(),
    [selectedInterfaces],
  );
  const active = status ? isActiveTransferPhase(status.phase) : false;
  const activeMode =
    status?.mode ??
    (configurationMode === "landing" ? null : configurationMode);
  const commitCritical =
    status?.phase === "committing" || status?.phase === "rollingBack";
  const remainingSeconds = status?.expiresAt
    ? Math.max(0, Math.ceil((status.expiresAt - now) / 1_000))
    : null;
  const progress = status?.totalBytes
    ? Math.min(100, (status.transferredBytes / status.totalBytes) * 100)
    : 0;

  useSettingsNavigationGuard({
    dirty: active || configurationMode !== "landing",
    title: commitCritical
      ? "Settings are being applied"
      : active
        ? "Stop settings transfer?"
        : "Discard transfer setup?",
    description: commitCritical
      ? "This step cannot be interrupted. Wait for it to finish before leaving this section."
      : busy || fileOperationBusy
        ? "Wait for the current transfer operation to finish before leaving this section."
        : active
          ? "Leaving now stops the active transfer and clears its temporary pairing state."
          : "The current transfer or encrypted-file setup will be discarded.",
    confirmLabel: active ? "Stop and leave" : "Discard setup",
    canDiscard: !commitCritical && !busy && !fileOperationBusy,
    onDiscard: async () => {
      if (active) {
        await stopSettingsTransfer();
      }

      setConfigurationMode("landing");
      setLocalError(null);
    },
  });

  const toggleCategory = (id: SettingsCategoryId): void => {
    setSelectedCategories((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleInterface = (id: string): void => {
    setSelectedInterfaces((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const run = async (operation: () => Promise<unknown>): Promise<boolean> => {
    if (operationInFlight.current) return false;
    operationInFlight.current = true;
    setBusy(true);
    setLocalError(null);
    try {
      await operation();
      return true;
    } catch (error) {
      setLocalError(toErrorMessage(error));
      return false;
    } finally {
      operationInFlight.current = false;
      setBusy(false);
    }
  };

  const submitPhaseAction = (
    phase: "pairing" | "review",
    operation: () => Promise<unknown>,
  ): void => {
    if (pendingPhaseAction === phase) return;
    setPendingPhaseAction(phase);
    void run(operation).then((submitted) => {
      if (!submitted) setPendingPhaseAction(null);
    });
  };

  const copyManualCode = async (): Promise<void> => {
    if (!status?.manualCode || !navigator.clipboard?.writeText) {
      setLocalError("Clipboard access is unavailable on this device.");
      return;
    }
    setLocalError(null);
    try {
      await navigator.clipboard.writeText(status.manualCode);
      setCopied(true);
      if (copiedResetTimer.current !== null) {
        window.clearTimeout(copiedResetTimer.current);
      }
      copiedResetTimer.current = window.setTimeout(() => {
        copiedResetTimer.current = null;
        setCopied(false);
      }, 1_500);
    } catch (error) {
      setCopied(false);
      setLocalError(toErrorMessage(error));
    }
  };

  const start = (mode: SettingsTransferMode): void => {
    void run(async () => {
      const sequenceBeforeStart = statusEventSequence.current;
      const request = {
        categories: selectedCategoryList,
        displayName,
        interfaceIds: selectedInterfaceList,
      };
      const nextStatus =
        mode === "send"
          ? await startSettingsTransfer(request)
          : await startSettingsReceive(request);
      if (statusEventSequence.current === sequenceBeforeStart) {
        setStatus(nextStatus);
      }
    });
  };

  const cancel = (): void => {
    void run(async () => {
      const sequenceBeforeStop = statusEventSequence.current;
      const nextStatus = await stopSettingsTransfer();
      if (statusEventSequence.current === sequenceBeforeStop) {
        setStatus(nextStatus);
      }
    });
  };

  const reset = (): void => {
    void run(async () => {
      const sequenceBeforeCatalog = statusEventSequence.current;
      const catalog = await getSettingsTransferCatalog();
      if (statusEventSequence.current === sequenceBeforeCatalog) {
        applyCatalog(catalog);
      }
      setConfigurationMode("landing");
      setManualCode("");
      setCopied(false);
    });
  };

  if (!status) {
    return (
      <SettingsCard title="Transfer" description="Loading settings…">
        <div className="flex items-center gap-2 py-6 text-sm text-slate-400">
          <LoaderCircle className="size-4 animate-spin" /> Preparing settings
        </div>
        {localError ? (
          <p className="text-sm text-rose-300">{localError}</p>
        ) : null}
      </SettingsCard>
    );
  }

  if (!active && status.phase === "idle" && configurationMode === "landing") {
    return (
      <SettingsCard
        title="Transfer"
        description="Move selected settings to another PC over your local network or with an encrypted file. Nothing is uploaded."
      >
        <div className="grid gap-3 py-5 md:grid-cols-2">
          <button
            type="button"
            aria-label="Transfer Settings"
            onClick={() => setConfigurationMode("send")}
            className="group flex items-center gap-3 rounded-2xl border border-slate-800 bg-slate-950/70 p-4 text-left transition hover:border-sky-500/35 hover:bg-sky-500/5"
          >
            <span className="flex size-10 items-center justify-center rounded-xl border border-sky-500/25 bg-sky-500/10 text-sky-300">
              <ArrowUpFromLine className="size-5" />
            </span>
            <span className="font-semibold text-slate-100">
              Transfer Settings
            </span>
          </button>
          <button
            type="button"
            aria-label="Receive Settings"
            onClick={() => setConfigurationMode("receive")}
            className="group flex items-center gap-3 rounded-2xl border border-slate-800 bg-slate-950/70 p-4 text-left transition hover:border-emerald-500/35 hover:bg-emerald-500/5"
          >
            <span className="flex size-10 items-center justify-center rounded-xl border border-emerald-500/25 bg-emerald-500/10 text-emerald-300">
              <ArrowDownToLine className="size-5" />
            </span>
            <span className="font-semibold text-slate-100">
              Receive Settings
            </span>
          </button>
          <button
            type="button"
            aria-label="Export Encrypted File"
            onClick={() => setConfigurationMode("fileExport")}
            className="group flex items-center gap-3 rounded-2xl border border-slate-800 bg-slate-950/70 p-4 text-left transition hover:border-violet-500/35 hover:bg-violet-500/5"
          >
            <span className="flex size-10 items-center justify-center rounded-xl border border-violet-500/25 bg-violet-500/10 text-violet-300">
              <ArrowUpFromLine className="size-5" />
            </span>
            <span className="font-semibold text-slate-100">
              Export Encrypted File
            </span>
          </button>
          <button
            type="button"
            aria-label="Import Encrypted File"
            onClick={() => setConfigurationMode("fileImport")}
            className="group flex items-center gap-3 rounded-2xl border border-slate-800 bg-slate-950/70 p-4 text-left transition hover:border-amber-500/35 hover:bg-amber-500/5"
          >
            <span className="flex size-10 items-center justify-center rounded-xl border border-amber-500/25 bg-amber-500/10 text-amber-300">
              <ArrowDownToLine className="size-5" />
            </span>
            <span className="font-semibold text-slate-100">
              Import Encrypted File
            </span>
          </button>
        </div>
        {localError ? (
          <p role="alert" className="text-sm text-rose-300">
            {localError}
          </p>
        ) : null}
      </SettingsCard>
    );
  }

  if (
    !active &&
    status.phase === "idle" &&
    (configurationMode === "fileExport" || configurationMode === "fileImport")
  ) {
    return (
      <EncryptedSettingsFilePanel
        mode={configurationMode}
        catalog={status}
        onBack={() => setConfigurationMode("landing")}
        onBusyChange={setFileOperationBusy}
        onDone={async () => {
          try {
            const sequenceBeforeCatalog = statusEventSequence.current;
            const catalog = await getSettingsTransferCatalog();
            if (statusEventSequence.current === sequenceBeforeCatalog) {
              applyCatalog(catalog);
            }
            setLocalError(null);
          } catch (error) {
            setLocalError(
              `The file operation completed, but the settings catalog could not be refreshed: ${toErrorMessage(error)}`,
            );
          } finally {
            setConfigurationMode("landing");
          }
        }}
      />
    );
  }

  if (
    !active &&
    status.phase === "idle" &&
    (configurationMode === "send" || configurationMode === "receive")
  ) {
    return (
      <SettingsCard
        title={
          configurationMode === "send"
            ? "Transfer Settings"
            : "Receive Settings"
        }
        description={
          configurationMode === "send"
            ? "Choose the settings this PC can send. Empty categories clear matching settings after both PCs approve."
            : "Choose the settings this PC can receive. You’ll review changes before anything is replaced."
        }
      >
        <div className="grid gap-5 py-5">
          <div className="grid gap-2">
            <label
              htmlFor="settings-transfer-device-name"
              className="text-sm font-medium text-slate-300"
            >
              Device name
            </label>
            <Input
              id="settings-transfer-device-name"
              value={displayName}
              maxLength={64}
              onChange={(event) => setDisplayName(event.target.value)}
              className="border-slate-800 bg-slate-950 text-slate-100"
            />
          </div>
          <CategorySelection
            categories={status.categories}
            selected={selectedCategories}
            disabled={busy}
            onToggle={toggleCategory}
          />
          <InterfaceSelection
            status={status}
            selected={selectedInterfaces}
            disabled={busy}
            onToggle={toggleInterface}
          />
          {localError ? (
            <p role="alert" className="text-sm text-rose-300">
              {localError}
            </p>
          ) : null}
          <div className="flex flex-wrap justify-between gap-3 border-t border-slate-800 pt-4">
            <Button
              type="button"
              variant="ghost"
              onClick={() => setConfigurationMode("landing")}
              disabled={busy}
              className="text-slate-400 hover:bg-slate-900 hover:text-slate-100"
            >
              Back
            </Button>
            <Button
              type="button"
              onClick={() => start(configurationMode)}
              disabled={
                busy ||
                selectedCategories.size === 0 ||
                selectedInterfaces.size === 0 ||
                displayName.trim().length === 0
              }
              className="bg-sky-500 text-slate-950 hover:bg-sky-400"
            >
              {busy ? <LoaderCircle className="size-4 animate-spin" /> : null}
              {configurationMode === "send" ? "Make available" : "Find senders"}
            </Button>
          </div>
        </div>
      </SettingsCard>
    );
  }

  if (["completed", "cancelled", "failed"].includes(status.phase)) {
    const succeeded = status.phase === "completed";
    const cancelled = status.phase === "cancelled";
    const ResultIcon = succeeded ? CheckCircle2 : cancelled ? X : XCircle;
    const title = succeeded
      ? "Transfer complete"
      : cancelled
        ? "Transfer cancelled"
        : "Transfer stopped";
    return (
      <SettingsCard title={title}>
        <div className="grid justify-items-center gap-4 py-8 text-center">
          <span
            className={cn(
              "flex size-14 items-center justify-center rounded-full border",
              succeeded
                ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                : cancelled
                  ? "border-slate-700 bg-slate-900 text-slate-300"
                  : "border-rose-500/30 bg-rose-500/10 text-rose-300",
            )}
          >
            <ResultIcon className="size-7" />
          </span>
          <div className="grid max-w-xl gap-2">
            <p className="text-sm leading-6 text-slate-400">
              {status.message ?? "The session ended."}
            </p>
            {status.completedLocally ? (
              <p className="text-xs font-medium text-emerald-300">
                Settings were applied and verified on this PC.
              </p>
            ) : null}
          </div>
          <Button
            type="button"
            onClick={reset}
            disabled={busy}
            className="bg-slate-100 text-slate-950 hover:bg-white"
          >
            <RefreshCw className="size-4" /> New session
          </Button>
        </div>
      </SettingsCard>
    );
  }

  return (
    <SettingsCard
      title={activeMode === "send" ? "Transfer Settings" : "Receive Settings"}
    >
      <div className="grid gap-5 py-5">
        {status.phase === "advertising" ? (
          <div className="grid gap-4">
            <div className="grid justify-items-center gap-2 rounded-2xl border border-sky-500/25 bg-sky-500/5 px-5 py-6 text-center">
              <Wifi className="size-6 text-sky-300" />
              <p className="text-xs font-medium tracking-[0.16em] text-slate-500 uppercase">
                Live session
              </p>
              <p className="text-2xl font-semibold tracking-tight text-slate-50">
                {status.sessionLabel}
              </p>
              {remainingSeconds !== null ? (
                <p className="font-mono text-sm text-slate-400">
                  {Math.floor(remainingSeconds / 60)}:
                  {String(remainingSeconds % 60).padStart(2, "0")} remaining
                </p>
              ) : null}
            </div>
            <details className="group rounded-xl border border-slate-800 bg-slate-950/55">
              <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-sm text-slate-300">
                <span>QR or manual code</span>
                <ChevronDown className="size-4 transition-transform group-open:rotate-180" />
              </summary>
              <div className="grid gap-4 border-t border-slate-800 p-4 md:grid-cols-[auto_minmax(0,1fr)]">
                {status.qrSvg ? (
                  <div
                    aria-label="Manual connection QR code"
                    className="w-fit overflow-hidden rounded-lg bg-white p-2 [&_svg]:size-40"
                    dangerouslySetInnerHTML={{ __html: status.qrSvg }}
                  />
                ) : null}
                <div className="grid min-w-0 content-start gap-2">
                  <Textarea
                    readOnly
                    value={status.manualCode ?? ""}
                    aria-label="Manual connection code"
                    className="min-h-28 break-all border-slate-800 bg-slate-950 font-mono text-[10px] text-slate-400"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    disabled={!status.manualCode}
                    onClick={() => void copyManualCode()}
                    className="w-fit border-slate-700 bg-slate-900 text-slate-200 hover:bg-slate-800"
                  >
                    {copied ? (
                      <Check className="size-4" />
                    ) : (
                      <Copy className="size-4" />
                    )}
                    {copied ? "Copied" : "Copy code"}
                  </Button>
                </div>
              </div>
            </details>
          </div>
        ) : null}

        {status.phase === "discovering" ? (
          <div className="grid gap-4">
            <div
              className="grid gap-2"
              aria-label="Available transfer sessions"
            >
              {status.discoveredSessions.map((session) => (
                <button
                  type="button"
                  key={session.id}
                  disabled={busy}
                  onClick={() =>
                    void run(() =>
                      connectDiscoveredSettingsTransfer(session.id),
                    )
                  }
                  className="flex items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-950/70 px-4 py-3 text-left transition hover:border-emerald-500/35 hover:bg-emerald-500/5 disabled:opacity-50"
                >
                  <span className="flex items-center gap-3">
                    <Wifi className="size-4 text-emerald-300" />
                    <span className="text-sm font-medium text-slate-100">
                      {session.label}
                    </span>
                  </span>
                  <span className="text-xs font-medium text-emerald-300">
                    Connect
                  </span>
                </button>
              ))}
              {status.discoveredSessions.length === 0 ? (
                <div className="flex items-center gap-3 rounded-xl border border-dashed border-slate-800 px-4 py-5 text-sm text-slate-500">
                  <LoaderCircle className="size-4 animate-spin" /> Waiting for a
                  sender on the selected interfaces
                </div>
              ) : null}
            </div>
            <details className="group rounded-xl border border-slate-800 bg-slate-950/55">
              <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-sm text-slate-300">
                <span>Can’t find the other PC?</span>
                <ChevronDown className="size-4 transition-transform group-open:rotate-180" />
              </summary>
              <div className="grid gap-3 border-t border-slate-800 p-4">
                <p className="text-xs leading-5 text-slate-400">
                  Make sure both PCs are awake on the same network and Machdoch
                  is allowed through the firewall.
                </p>
                <Textarea
                  value={manualCode}
                  onChange={(event) => setManualCode(event.target.value)}
                  maxLength={MAX_MANUAL_CODE_LENGTH}
                  placeholder="Paste machdoch-xfer:v1:…"
                  aria-label="Paste manual connection code"
                  className="min-h-24 border-slate-800 bg-slate-950 font-mono text-xs text-slate-300"
                />
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy || manualCode.trim().length === 0}
                  onClick={() =>
                    void run(() =>
                      connectManualSettingsTransfer(manualCode.trim()),
                    )
                  }
                  className="w-fit border-slate-700 bg-slate-900 text-slate-200 hover:bg-slate-800"
                >
                  Connect with manual code
                </Button>
              </div>
            </details>
          </div>
        ) : null}

        {status.phase === "pairing" && status.pairingCode ? (
          <div className="grid justify-items-center gap-5 rounded-2xl border border-emerald-500/25 bg-emerald-500/5 px-5 py-7 text-center">
            <ShieldCheck className="size-7 text-emerald-300" />
            <div>
              <p className="text-xs font-medium tracking-[0.16em] text-slate-500 uppercase">
                Secure comparison code
              </p>
              <p className="mt-3 font-mono text-4xl font-semibold tracking-[0.22em] text-white sm:text-5xl">
                {status.pairingCode.slice(0, 3)} {status.pairingCode.slice(3)}
              </p>
            </div>
            <PairingCategorySummary status={status} />
            <p className="max-w-lg text-sm leading-6 text-slate-400">
              Compare this code with {status.peerName ?? "the other PC"}.
              Continue only if all six digits match.
            </p>
            <Button
              type="button"
              disabled={busy || pendingPhaseAction === "pairing"}
              onClick={() =>
                submitPhaseAction("pairing", confirmSettingsTransferPairing)
              }
              className="bg-emerald-400 text-emerald-950 hover:bg-emerald-300"
            >
              {pendingPhaseAction === "pairing" ? (
                <LoaderCircle className="size-4 animate-spin" />
              ) : (
                <Check className="size-4" />
              )}
              {pendingPhaseAction === "pairing"
                ? "Confirmed locally — waiting for other PC"
                : "Codes match"}
            </Button>
          </div>
        ) : null}

        {status.phase === "review" ? (
          <div className="grid gap-4">
            <div className="rounded-xl border border-amber-500/25 bg-amber-500/5 px-4 py-3 text-xs leading-5 text-amber-100/85">
              Selected categories replace existing settings; they are not
              merged.
            </div>
            <ReviewCategories categories={status.categories} />
            {status.categories.some(
              (category) =>
                category.effect === "replace" || category.effect === "clear",
            ) ? (
              <Button
                type="button"
                disabled={busy || pendingPhaseAction === "review"}
                onClick={() =>
                  submitPhaseAction("review", approveSettingsTransfer)
                }
                className={cn(
                  "justify-self-end",
                  activeMode === "receive"
                    ? "bg-rose-500 text-white hover:bg-rose-400"
                    : "bg-sky-500 text-slate-950 hover:bg-sky-400",
                )}
              >
                {pendingPhaseAction === "review"
                  ? "Approved locally — waiting for other PC"
                  : activeMode === "receive"
                    ? "Replace selected settings"
                    : "Transfer these categories"}
              </Button>
            ) : null}
          </div>
        ) : null}

        {[
          "inspecting",
          "connecting",
          "transferring",
          "validating",
          "committing",
          "rollingBack",
        ].includes(status.phase) ? (
          <div className="grid justify-items-center gap-4 rounded-2xl border border-slate-800 bg-slate-950/60 px-5 py-8 text-center">
            <LoaderCircle className="size-7 animate-spin text-sky-300" />
            <p
              role="status"
              aria-live="polite"
              className="text-sm leading-6 text-slate-300"
            >
              {getTransferPhaseLabel(status.phase)}
            </p>
            {status.phase === "transferring" && status.totalBytes > 0 ? (
              <div className="grid w-full max-w-lg gap-2">
                <div
                  className="h-2 overflow-hidden rounded-full bg-slate-800"
                  role="progressbar"
                  aria-label="Overall settings transfer progress"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(progress)}
                  aria-valuetext={`${Math.round(progress)}% complete`}
                >
                  <div
                    aria-hidden="true"
                    className="h-full rounded-full bg-sky-400 transition-[width]"
                    style={{ width: `${progress}%` }}
                  />
                </div>
                <p className="text-xs text-slate-500">
                  {Math.round(progress)}%
                </p>
              </div>
            ) : null}
            {commitCritical ? (
              <p className="max-w-lg text-xs leading-5 text-amber-300/85">
                This step cannot be cancelled.
              </p>
            ) : null}
          </div>
        ) : null}

        {localError ? (
          <p role="alert" className="text-sm text-rose-300">
            {localError}
          </p>
        ) : null}

        {!commitCritical ? (
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={cancel}
            className="justify-self-start border-slate-700 bg-slate-950 text-slate-300 hover:border-rose-500/40 hover:bg-rose-500/10 hover:text-rose-200"
          >
            <X className="size-4" /> Cancel
          </Button>
        ) : null}
      </div>
    </SettingsCard>
  );
};
