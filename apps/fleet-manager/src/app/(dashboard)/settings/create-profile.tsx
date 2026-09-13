"use client";

import { Plus } from "lucide-react";
import { useState } from "react";
import { Field } from "@/components/field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { api, jsonBody } from "@/lib/api";
import { SettingsFormDialog } from "./settings-form-dialog";
import type { SettingsProfile } from "./types";

export function CreateProfile({
  disabled,
  onCreated,
}: {
  disabled: boolean;
  onCreated: (profile: SettingsProfile) => void;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button disabled={disabled} onClick={() => setOpen(true)}>
        <Plus />
        New profile
      </Button>
      <SettingsFormDialog
        open={open}
        onOpenChange={setOpen}
        title="New profile"
        submitLabel="Create profile"
        onSubmit={async (form) => {
          const { profile } = await api<{ profile: SettingsProfile }>(
            "/api/settings/profiles",
            {
              method: "POST",
              body: jsonBody({
                name: form.get("name"),
                description: form.get("description"),
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
      </SettingsFormDialog>
    </>
  );
}
