"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { api } from "@machdoch/product-ui/fleet-api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { formatTime } from "@/lib/format";
import {
  mergeSettings,
  type SettingsMergeChoices,
  type SettingsMergeConflict,
  type SettingsMergeResolution,
} from "@/lib/merge-settings";
import { mcpServerProblem } from "@/lib/settings-items";
import { profilePolicy } from "./profile-drafts";
import type {
  EnrollmentDevice,
  ManagedSettingsDocument,
  SettingsProfile,
} from "./types";
import { settingsError } from "./use-settings-profiles";
import {
  fieldLabel,
  labelledFields,
  SettingsChanges,
  SettingsValuePreview,
  UnchangedFields,
} from "./settings-value-preview";

interface MergeChoices {
  /** Choices only apply to the revision they were made for. */
  revision: number;
  choices: SettingsMergeChoices;
  editErrors: Record<string, string>;
}

const noChoices: SettingsMergeChoices = {};
const noEditErrors: Record<string, string> = {};

/** A refreshed upload has a new capture time and is fetched again. */
const snapshotKey = (device: EnrollmentDevice) =>
  `${device.instanceId}@${device.capturedAt}`;

export function EnrollmentSettingsEditor({
  profile,
  disabled,
  onSave,
}: {
  profile: SettingsProfile;
  disabled: boolean;
  onSave: (document: ManagedSettingsDocument, summary: string) => Promise<void>;
}): React.ReactElement {
  const [devices, setDevices] = useState<EnrollmentDevice[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [documents, setDocuments] = useState<
    Record<string, ManagedSettingsDocument>
  >({});
  const [merging, setMerging] = useState<MergeChoices>({
    revision: profile.revision,
    choices: noChoices,
    editErrors: noEditErrors,
  });
  const [loadingDevices, setLoadingDevices] = useState(true);
  const [devicesError, setDevicesError] = useState("");
  const [devicesAttempt, setDevicesAttempt] = useState(0);
  // Failed snapshot reads by snapshot key; they are not retried on their own.
  const [documentErrors, setDocumentErrors] = useState<Record<string, string>>(
    {},
  );
  const [saveError, setSaveError] = useState("");
  const [saving, setSaving] = useState(false);
  const current = merging.revision === profile.revision;
  const choices = current ? merging.choices : noChoices;
  const editErrors = current ? merging.editErrors : noEditErrors;
  const choicesReset =
    !current && Object.keys(merging.choices).length > 0 && !saving;
  const selectedDevices = useMemo(
    () =>
      selected.flatMap((instanceId) =>
        devices.filter((device) => device.instanceId === instanceId),
      ),
    [devices, selected],
  );
  const pending = useMemo(
    () =>
      selectedDevices.filter(
        (device) =>
          !documents[snapshotKey(device)] &&
          !documentErrors[snapshotKey(device)],
      ),
    [documentErrors, documents, selectedDevices],
  );
  const failed = selectedDevices.flatMap((device) => {
    const message = documentErrors[snapshotKey(device)];
    return message ? [`${device.displayName}: ${message}`] : [];
  });
  const sources = useMemo(
    () =>
      selectedDevices.flatMap((device) => {
        const document = documents[snapshotKey(device)];
        return document ? [{ name: device.displayName, document }] : [];
      }),
    [documents, selectedDevices],
  );
  // Merging only some of the selected devices would look complete but is not.
  const merge = useMemo(
    () =>
      sources.length && sources.length === selectedDevices.length
        ? mergeSettings(profile.document, sources, choices)
        : null,
    [profile.document, sources, selectedDevices.length, choices],
  );
  useEffect(() => {
    const controller = new AbortController();
    setLoadingDevices(true);
    setDevicesError("");
    void (async () => {
      try {
        const payload = await api<{ devices: EnrollmentDevice[] }>(
          "/api/settings/enrollment",
          { signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        setDevices(payload.devices);
        // Devices whose snapshot is gone can no longer be merged.
        setSelected((current) =>
          current.filter((id) =>
            payload.devices.some((device) => device.instanceId === id),
          ),
        );
      } catch (cause) {
        if (!controller.signal.aborted) setDevicesError(settingsError(cause));
      } finally {
        if (!controller.signal.aborted) setLoadingDevices(false);
      }
    })();
    return () => controller.abort();
  }, [devicesAttempt]);
  useEffect(() => {
    if (!pending.length) return;
    const controller = new AbortController();
    void Promise.allSettled(
      pending.map(async (device) => {
        const payload = await api<{ document: ManagedSettingsDocument }>(
          `/api/settings/instances/${encodeURIComponent(device.instanceId)}/enrollment`,
          { signal: controller.signal },
        );
        return [snapshotKey(device), payload.document] as const;
      }),
    ).then((results) => {
      if (controller.signal.aborted) return;
      const loaded = results.flatMap((result) =>
        result.status === "fulfilled" ? [result.value] : [],
      );
      const failures = results.flatMap((result, index) =>
        result.status === "rejected"
          ? [[snapshotKey(pending[index]!), settingsError(result.reason)]]
          : [],
      );
      if (loaded.length)
        setDocuments((current) => ({
          ...current,
          ...Object.fromEntries(loaded),
        }));
      if (failures.length)
        setDocumentErrors((current) => ({
          ...current,
          ...Object.fromEntries(failures),
        }));
    });
    return () => controller.abort();
  }, [pending]);
  const busy = disabled || saving;
  const loadingDocuments = pending.length > 0;
  const update = (change: (state: MergeChoices) => Partial<MergeChoices>) =>
    setMerging((previous) => {
      const base =
        previous.revision === profile.revision
          ? previous
          : {
              revision: profile.revision,
              choices: noChoices,
              editErrors: noEditErrors,
            };
      return { ...base, ...change(base) };
    });
  const choose = (key: string, resolution: SettingsMergeResolution) =>
    update((state) => ({
      choices: { ...state.choices, [key]: resolution },
    }));
  const chooseAll = (resolution: "profile" | "device") =>
    update(() => ({
      choices: Object.fromEntries(
        merge!.conflicts.map((conflict) => [conflict.key, resolution]),
      ),
    }));
  const unresolved =
    merge?.conflicts.filter((conflict) => !conflict.resolved) ?? [];
  // Errors of an edit only block while that edit is the chosen resolution.
  const invalidEdits = Object.keys(editErrors).filter(
    (key) => typeof choices[key] === "object",
  );
  const changed =
    merge &&
    JSON.stringify(merge.document) !== JSON.stringify(profile.document);
  return (
    <div className="grid min-w-0 gap-4">
      <div className="grid gap-1">
        <h3 className="font-medium">Device settings</h3>
        <p className="text-sm text-muted-foreground">
          Merge settings uploaded by one or more devices into this profile.
          Identical items from several devices are merged automatically, and
          values added from devices become defaults that users can change.
        </p>
      </div>
      <fieldset
        disabled={busy}
        className="grid min-w-0 gap-2 rounded-lg border border-border p-3"
      >
        <legend className="px-1 text-sm font-medium">Devices to merge</legend>
        {devices.map((device) => (
          <label
            key={device.instanceId}
            className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-sm"
          >
            <input
              type="checkbox"
              className="size-4 accent-primary"
              checked={selected.includes(device.instanceId)}
              onChange={(event) => {
                // Variants and their order change with the selection.
                update(() => ({
                  choices: noChoices,
                  editErrors: noEditErrors,
                }));
                setSaveError("");
                setSelected((current) =>
                  event.target.checked
                    ? [...current, device.instanceId]
                    : current.filter((id) => id !== device.instanceId),
                );
              }}
            />
            <span className="min-w-0 break-words font-medium [overflow-wrap:anywhere]">
              {device.displayName}
            </span>
            <span className="text-xs text-muted-foreground">
              Snapshot {formatTime(device.capturedAt)}
              {device.refreshRequestedAt !== null
                ? " · Fresh snapshot requested"
                : ""}
            </span>
          </label>
        ))}
        {loadingDevices ? (
          <p role="status" className="text-sm text-muted-foreground">
            Loading devices…
          </p>
        ) : !devices.length && !devicesError ? (
          <p className="text-sm text-muted-foreground">
            No device has uploaded its settings yet. Devices upload them when
            they connect; under Instances you can request a fresh snapshot.
          </p>
        ) : null}
      </fieldset>
      <LoadError
        message={devicesError}
        disabled={loadingDevices}
        onRetry={() => setDevicesAttempt((value) => value + 1)}
      />
      <LoadError
        message={failed.join(" ")}
        disabled={busy}
        onRetry={() => setDocumentErrors({})}
      />
      {loadingDocuments ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading device settings…
        </p>
      ) : null}
      {choicesReset ? (
        <p role="status" className="text-sm text-muted-foreground">
          The profile changed, so your conflict choices were reset.
        </p>
      ) : null}
      {merge?.additions.length ? (
        <div className="grid gap-2">
          <h4 className="text-sm font-medium">
            New from devices ({merge.additions.length})
          </h4>
          {merge.additions.map((addition) => (
            <details
              key={addition.key}
              className="min-w-0 rounded border border-border p-3"
            >
              <summary className="cursor-pointer break-words text-sm [overflow-wrap:anywhere]">
                {addition.label}
                <span className="text-muted-foreground">
                  {" "}
                  · {addition.sources.join(", ")}
                </span>
              </summary>
              <div className="mt-2 text-sm">
                <SettingsValuePreview value={addition.value} omitName />
              </div>
            </details>
          ))}
        </div>
      ) : null}
      {merge?.conflicts.length ? (
        <div className="grid gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h4 className="text-sm font-medium">
              Conflicts ({merge.conflicts.length})
            </h4>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => chooseAll("profile")}
              >
                Keep all profile values
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => chooseAll("device")}
              >
                Take all device values
              </Button>
            </div>
          </div>
          {merge.conflicts.map((conflict) => (
            <ConflictChoice
              key={conflict.key}
              conflict={conflict}
              deviceCount={sources.length}
              disabled={busy}
              resolution={choices[conflict.key]}
              editError={editErrors[conflict.key] ?? null}
              onChoose={(resolution) => choose(conflict.key, resolution)}
              onEditError={(message) =>
                update((state) => {
                  const next = { ...state.editErrors };
                  if (message) next[conflict.key] = message;
                  else delete next[conflict.key];
                  return { editErrors: next };
                })
              }
            />
          ))}
        </div>
      ) : null}
      {merge ? (
        <div className="grid justify-items-start gap-2">
          {!merge.additions.length && !merge.conflicts.length ? (
            <p className="text-sm">
              Nothing to merge. The profile already contains these settings.
            </p>
          ) : (
            <>
              {unresolved.length ? (
                <p className="text-sm text-muted-foreground">
                  Choose how to resolve {unresolved.length} conflict
                  {unresolved.length > 1 ? "s" : ""}.
                </p>
              ) : null}
              {invalidEdits.length ? (
                <p className="text-sm text-muted-foreground">
                  Fix the edited version{invalidEdits.length > 1 ? "s" : ""}{" "}
                  before merging.
                </p>
              ) : null}
              <p className="break-words text-sm [overflow-wrap:anywhere]">
                This updates every device using {profile.name}.
              </p>
            </>
          )}
          {saveError ? (
            <p role="alert" className="break-words text-sm text-destructive">
              {saveError}
            </p>
          ) : null}
          <Button
            disabled={
              busy ||
              loadingDocuments ||
              unresolved.length > 0 ||
              invalidEdits.length > 0 ||
              !changed
            }
            onClick={() => {
              setSaving(true);
              setSaveError("");
              const document = structuredClone(merge.document);
              // Values added from devices become defaults, not enforcements.
              if (!profile.document.policy)
                document.policy = { enforced: profilePolicy(profile) };
              void onSave(document, "Merged device settings")
                .then(() => {
                  setSelected([]);
                  update(() => ({
                    choices: noChoices,
                    editErrors: noEditErrors,
                  }));
                })
                .catch((cause) => setSaveError(settingsError(cause)))
                .finally(() => setSaving(false));
            }}
          >
            {saving ? "Merging…" : "Merge settings"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function LoadError({
  message,
  disabled,
  onRetry,
}: {
  message: string;
  disabled: boolean;
  onRetry: () => void;
}): React.ReactElement | null {
  if (!message) return null;
  return (
    <div className="grid justify-items-start gap-2">
      <p role="alert" className="break-words text-sm text-destructive">
        {message}
      </p>
      <Button variant="outline" disabled={disabled} onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}

function formatFieldValue(value: unknown): string {
  if (value === null || value === undefined) return "Not set";
  if (typeof value === "boolean") return value ? "On" : "Off";
  if (typeof value === "object") {
    const { provider, model } = value as {
      provider: string | null;
      model: string | null;
    };
    return `${provider ?? "Not set"} · ${model ?? "provider default"}`;
  }
  return String(value);
}

function ConflictChoice({
  conflict,
  deviceCount,
  disabled,
  resolution,
  editError,
  onChoose,
  onEditError,
}: {
  conflict: SettingsMergeConflict;
  deviceCount: number;
  disabled: boolean;
  resolution: SettingsMergeResolution | undefined;
  editError: string | null;
  onChoose: (resolution: SettingsMergeResolution) => void;
  onEditError: (message: string | null) => void;
}): React.ReactElement {
  const id = useId();
  const item = conflict.kind !== "field";
  const inProfile = conflict.profileValue !== null;
  // Device versions are shown as changes against the profile, or against the
  // first device when the profile has no such value yet.
  const base = inProfile ? conflict.profileValue : conflict.variants[0]?.value;
  const baseName = inProfile
    ? "the profile"
    : conflict.variants[0]!.sources.join(", ");
  const editing = typeof resolution === "object";
  const options: Array<{
    value: SettingsMergeResolution;
    label: string;
    preview?: unknown;
  }> = [
    {
      value: "profile",
      label: inProfile ? "Keep profile" : "Skip",
      ...(inProfile ? { preview: conflict.profileValue } : {}),
    },
    ...conflict.variants.map((variant, index) => ({
      value: (index === 0
        ? "device"
        : `device:${index}`) as SettingsMergeResolution,
      label:
        deviceCount === 1 && conflict.variants.length === 1
          ? "Take device"
          : `Take ${variant.sources.join(", ")}`,
      preview: variant.value,
    })),
    ...(item ? [{ value: "both" as const, label: "Keep both" }] : []),
  ];
  const isChecked = (value: SettingsMergeResolution) =>
    !editing &&
    (resolution === value || (value === "device" && resolution === "device:0"));
  // Setting values such as provider and model are compared as a whole.
  const unchanged = item
    ? labelledFields(base).filter(
        (field) => !conflict.differences.includes(field),
      )
    : [];
  return (
    <fieldset
      disabled={disabled}
      className="grid min-w-0 gap-3 rounded border border-border p-3"
    >
      <legend className="break-words px-1 text-sm font-medium [overflow-wrap:anywhere]">
        {conflict.label}
      </legend>
      {conflict.differences.length ? (
        <p className="text-xs text-muted-foreground">
          Differs in:{" "}
          {conflict.differences.map((field) => fieldLabel(field)).join(", ")}
        </p>
      ) : null}
      <UnchangedFields value={base} fields={unchanged} />
      {options.map((option, index) => (
        <div key={String(option.value)} className="grid min-w-0 gap-1">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
            <label className="flex w-fit items-center gap-2 text-sm">
              <input
                type="radio"
                name={conflict.key}
                className="size-4 accent-primary"
                checked={isChecked(option.value)}
                aria-describedby={
                  !item && option.preview !== undefined
                    ? `${id}-${index}`
                    : undefined
                }
                onChange={() => {
                  onEditError(null);
                  onChoose(option.value);
                }}
              />
              {option.label}
            </label>
            {!item && option.preview !== undefined ? (
              <span
                id={`${id}-${index}`}
                className="min-w-0 break-words font-mono text-sm [overflow-wrap:anywhere]"
              >
                {formatFieldValue(option.preview)}
              </span>
            ) : null}
          </div>
          {item && option.preview !== undefined ? (
            <div className="ml-6 grid max-h-72 min-w-0 gap-1 overflow-auto text-sm">
              {option.preview === base ? (
                <SettingsValuePreview
                  value={base}
                  fields={
                    conflict.differences.length
                      ? conflict.differences
                      : undefined
                  }
                />
              ) : (
                <>
                  <p className="text-xs text-muted-foreground">
                    Compared with {baseName}
                  </p>
                  <SettingsChanges value={option.preview} base={base} />
                </>
              )}
            </div>
          ) : option.value === "both" ? (
            <p className="ml-6 text-xs text-muted-foreground">
              {inProfile
                ? `Adds the device version${conflict.variants.length > 1 ? "s" : ""} next to the profile version under a new name.`
                : "Adds every device version, renaming all but the first."}
            </p>
          ) : null}
        </div>
      ))}
      {item ? (
        <div className="grid min-w-0 gap-2">
          <label className="flex w-fit items-center gap-2 text-sm">
            <input
              type="radio"
              name={conflict.key}
              className="size-4 accent-primary"
              checked={editing}
              onChange={() =>
                // Start from the version that is currently chosen.
                onChoose({
                  edit: structuredClone(
                    options.find(
                      (option) =>
                        option.preview !== undefined && isChecked(option.value),
                    )?.preview ?? conflict.variants[0]?.value,
                  ),
                })
              }
            />
            Edit
          </label>
          {editing ? (
            <ItemEditor
              kind={conflict.kind}
              label={conflict.label}
              value={(resolution as { edit: unknown }).edit}
              error={editError}
              onChange={(value) => onChoose({ edit: value })}
              onError={onEditError}
            />
          ) : null}
        </div>
      ) : null}
    </fieldset>
  );
}

function editProblem(
  kind: SettingsMergeConflict["kind"],
  item: Record<string, unknown>,
): string | null {
  const text = (field: string) => String(item[field] ?? "").trim();
  if (kind === "prompt") return text("content") ? null : "Enter the prompt.";
  if (!text("name")) return "Enter a name.";
  if (kind === "instruction" && !text("body")) return "Enter the instruction.";
  if (kind === "contextPack" && !text("instructions") && !text("prompt"))
    return "Enter instructions or a prompt.";
  return null;
}

function ItemEditor({
  kind,
  label,
  value,
  error,
  onChange,
  onError,
}: {
  kind: SettingsMergeConflict["kind"];
  label: string;
  value: unknown;
  error: string | null;
  onChange: (value: unknown) => void;
  onError: (message: string | null) => void;
}): React.ReactElement {
  const id = useId();
  const item = (value ?? {}) as Record<string, unknown>;
  const [json, setJson] = useState(() => JSON.stringify(value, null, 2));
  const change = (field: string, text: string) => {
    const next = { ...item, [field]: text };
    onChange(next);
    onError(editProblem(kind, next));
  };
  const text = (field: string, title: string, rows = 8) => (
    <label className="grid min-w-0 gap-1 text-sm">
      <span className="font-medium">{title}</span>
      <Textarea
        className="font-mono"
        rows={rows}
        value={String(item[field] ?? "")}
        aria-label={`${title} for ${label}`}
        aria-describedby={error ? `${id}-error` : undefined}
        onChange={(event) => change(field, event.target.value)}
      />
    </label>
  );
  const message = error ? (
    <p id={`${id}-error`} role="alert" className="text-sm text-destructive">
      {error}
    </p>
  ) : null;
  if (kind === "mcpServer")
    return (
      <div className="grid min-w-0 gap-2">
        <label className="grid min-w-0 gap-1 text-sm">
          <span className="font-medium">Server JSON</span>
          <Textarea
            className="font-mono"
            rows={10}
            value={json}
            aria-label={`Server JSON for ${label}`}
            aria-describedby={error ? `${id}-error` : undefined}
            onChange={(event) => {
              setJson(event.target.value);
              let parsed: unknown;
              try {
                parsed = JSON.parse(event.target.value);
              } catch {
                onError("The server JSON is invalid.");
                return;
              }
              onChange(parsed);
              onError(mcpServerProblem(parsed));
            }}
          />
        </label>
        {message}
      </div>
    );
  return (
    <div className="grid min-w-0 gap-3 rounded-md bg-muted/40 p-3">
      {kind === "prompt" ? (
        text("content", "Prompt", 10)
      ) : (
        <>
          <label className="grid min-w-0 gap-1 text-sm">
            <span className="font-medium">Name</span>
            <Input
              value={String(item.name ?? "")}
              aria-label={`Name for ${label}`}
              aria-describedby={error ? `${id}-error` : undefined}
              onChange={(event) => change("name", event.target.value)}
            />
          </label>
          {kind === "instruction" ? (
            text("body", "Instruction", 10)
          ) : (
            <>
              {text("instructions", "Instructions")}
              {text("prompt", "Prompt")}
            </>
          )}
        </>
      )}
      {message}
    </div>
  );
}
