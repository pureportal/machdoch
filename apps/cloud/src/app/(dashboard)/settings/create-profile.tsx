"use client";

import { Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { Field } from "@/components/field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { api, jsonBody } from "@machdoch/product-ui/fleet-api";
import { FormDialog } from "@/components/form-dialog";
import { formatTime } from "@/lib/format";
import type { EnrollmentDevice, SettingsProfile } from "./types";

export function CreateProfile({
  disabled,
  onCreated,
}: {
  disabled: boolean;
  onCreated: (profile: SettingsProfile) => void;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [devices, setDevices] = useState<EnrollmentDevice[] | null>(null);
  const [devicesError, setDevicesError] = useState(false);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setDevicesError(false);
    void api<{ devices: EnrollmentDevice[] }>("/api/settings/enrollment", {
      signal: controller.signal,
    })
      .then((payload) => {
        if (!controller.signal.aborted) setDevices(payload.devices);
      })
      .catch(() => {
        // An empty profile can still be created.
        if (controller.signal.aborted) return;
        setDevices([]);
        setDevicesError(true);
      });
    return () => controller.abort();
  }, [open]);
  return (
    <>
      <Button disabled={disabled} onClick={() => setOpen(true)}>
        <Plus />
        New profile
      </Button>
      <FormDialog
        open={open}
        onOpenChange={setOpen}
        title="New profile"
        submitLabel="Create profile"
        onSubmit={async (form) => {
          const source = String(form.get("source") ?? "");
          const { profile } = await api<{ profile: SettingsProfile }>(
            "/api/settings/profiles",
            {
              method: "POST",
              body: jsonBody({
                name: form.get("name"),
                description: form.get("description"),
                ...(source ? { sourceInstanceId: source } : {}),
              }),
            },
          );
          onCreated(profile);
        }}
      >
        <Field label="Name" htmlFor="profile-name">
          <Input id="profile-name" name="name" required maxLength={200} />
        </Field>
        <Field label="Description" htmlFor="profile-description">
          <Textarea id="profile-description" name="description" />
        </Field>
        <Field
          label="Start from"
          htmlFor="profile-source"
          hint={
            devicesError
              ? "Device settings could not be loaded. You can still start with an empty profile."
              : devices?.length === 0
                ? "No device has uploaded its settings yet, so the profile starts empty."
                : "Copies the settings a device uploaded. Its values start as defaults that users can change."
          }
        >
          <Select
            id="profile-source"
            name="source"
            defaultValue=""
            disabled={devices === null}
          >
            <option value="">
              {devices === null ? "Loading devices…" : "Empty profile"}
            </option>
            {(devices ?? []).map((device) => (
              <option key={device.instanceId} value={device.instanceId}>
                {device.displayName} · {formatTime(device.capturedAt)}
              </option>
            ))}
          </Select>
        </Field>
      </FormDialog>
    </>
  );
}
