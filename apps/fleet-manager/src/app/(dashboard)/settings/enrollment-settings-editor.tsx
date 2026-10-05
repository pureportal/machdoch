"use client";

import { useEffect, useMemo, useState } from "react";
import { api } from "@machdoch/product-ui/fleet-api";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { mergeSettings, type SettingsMergeChoices } from "@/lib/merge-settings";
import type { ManagedSettingsDocument, SettingsProfile } from "./types";
import { settingsError } from "./use-settings-profiles";
import { SettingsValuePreview } from "./settings-value-preview";

export function EnrollmentSettingsEditor({
  profile,
  disabled,
  onSave,
}: {
  profile: SettingsProfile;
  disabled: boolean;
  onSave: (document: ManagedSettingsDocument, summary: string) => Promise<void>;
}): React.ReactElement {
  const [devices, setDevices] = useState<
    Array<{ instanceId: string; displayName: string }>
  >([]);
  const [instanceId, setInstanceId] = useState("");
  const [source, setSource] = useState<ManagedSettingsDocument | null>(null);
  const [choices, setChoices] = useState<SettingsMergeChoices>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [reloadCount, setReloadCount] = useState(0);
  const merge = useMemo(
    () => (source ? mergeSettings(profile.document, source, choices) : null),
    [profile.document, source, choices],
  );
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    const load = async (): Promise<void> => {
      try {
        if (!instanceId) {
          const payload = await api<{ devices: typeof devices }>(
            "/api/settings/enrollment",
            { signal: controller.signal },
          );
          if (!controller.signal.aborted) setDevices(payload.devices);
        } else {
          const payload = await api<{ document: ManagedSettingsDocument }>(
            `/api/settings/instances/${encodeURIComponent(instanceId)}/enrollment`,
            { signal: controller.signal },
          );
          if (!controller.signal.aborted) setSource(payload.document);
        }
      } catch (cause) {
        if (!controller.signal.aborted) setError(settingsError(cause));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    void load();
    return () => controller.abort();
  }, [instanceId, reloadCount]);
  return (
    <div className="grid gap-4">
      <Select
        aria-label="Device settings"
        value={instanceId}
        disabled={disabled || saving || loading}
        onChange={(event) => {
          setSource(null);
          setChoices({});
          setInstanceId(event.target.value);
        }}
      >
        <option value="">Select device</option>
        {devices.map((device) => (
          <option key={device.instanceId} value={device.instanceId}>
            {device.displayName}
          </option>
        ))}
      </Select>
      {error ? (
        <div className="grid justify-items-start gap-2">
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
          <Button
            variant="outline"
            disabled={disabled || saving || loading}
            onClick={() => setReloadCount((current) => current + 1)}
          >
            Retry
          </Button>
        </div>
      ) : null}
      {loading ? <p role="status">Loading device settings…</p> : null}
      {!loading && !devices.length && !error ? (
        <p>No device settings captured.</p>
      ) : null}
      {merge?.additions.map((addition) => (
        <details
          key={addition.label}
          className="rounded border border-border p-3"
        >
          <summary>{addition.label}</summary>
          <div className="mt-2 text-sm">
            <SettingsValuePreview value={addition.value} omitName />
          </div>
        </details>
      ))}
      {merge?.conflicts.map((conflict) => (
        <fieldset
          key={conflict.key}
          disabled={disabled || saving}
          className="grid gap-2 rounded border border-border p-3"
        >
          <legend className="px-1">{conflict.label}</legend>
          {(["profile", "device"] as const).map((choice) => (
            <label key={choice} className="grid gap-1">
              <span>
                <input
                  type="radio"
                  name={conflict.key}
                  checked={choices[conflict.key] === choice}
                  onChange={() =>
                    setChoices((current) => ({
                      ...current,
                      [conflict.key]: choice,
                    }))
                  }
                />{" "}
                {choice === "profile" ? "Keep profile" : "Use device"}
              </span>
              <div className="max-h-40 overflow-auto text-sm">
                <SettingsValuePreview
                  value={
                    choice === "profile"
                      ? conflict.profileValue
                      : conflict.deviceValue
                  }
                  comparison={
                    choice === "profile"
                      ? conflict.deviceValue
                      : conflict.profileValue
                  }
                />
              </div>
            </label>
          ))}
        </fieldset>
      ))}
      {merge ? (
        <div className="grid justify-items-start gap-2">
          {!merge.additions.length && !merge.conflicts.length ? (
            <p>No settings to merge.</p>
          ) : null}
          <p className="text-sm">
            This updates every device using {profile.name}.
          </p>
          <Button
            disabled={
              disabled ||
              saving ||
              loading ||
              merge.conflicts.some((conflict) => !choices[conflict.key]) ||
              JSON.stringify(merge.document) ===
                JSON.stringify(profile.document)
            }
            onClick={() => {
              setSaving(true);
              setError("");
              void onSave(merge.document, "Merged device settings")
                .then(() => {
                  setSource(null);
                  setInstanceId("");
                  setChoices({});
                })
                .catch((cause) => setError(settingsError(cause)))
                .finally(() => setSaving(false));
            }}
          >
            Merge settings
          </Button>
        </div>
      ) : null}
    </div>
  );
}
