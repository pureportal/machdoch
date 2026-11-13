"use client";

import { useRouter } from "next/navigation";
import { useRef } from "react";
import type { SavedView, SavedViewInput } from "@/lib/cloud-view-contract";
import { Field } from "@/components/field";
import { FormDialog } from "@/components/form-dialog";
import { Input } from "@/components/ui/input";
import { createCommandSender, formText } from "./api-client";

export function SaveViewDialog({
  open,
  onOpenChange,
  filters,
  writable,
  view,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  filters: SavedViewInput["filters"];
  writable: boolean;
  view?: SavedView;
  onSaved?: (id: string) => void;
}) {
  const router = useRouter();
  const sender = useRef(createCommandSender());
  return (
    <FormDialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) sender.current = createCommandSender();
      }}
      title={view ? "Edit view" : "Save view"}
      submitLabel={view ? "Save" : "Save view"}
      onSubmit={async (form) => {
        const input: SavedViewInput = {
          name: formText(form, "name"),
          shared: formText(form, "shared") === "on",
          filters,
        };
        const saved = await sender.current<{ id: string }>(
          view ? `views/${view.id}` : "views",
          input,
          view ? "PATCH" : "POST",
        );
        onSaved?.(saved.id);
        router.refresh();
      }}
    >
      <Field label="Name" htmlFor="view-name">
        <Input
          id="view-name"
          name="name"
          maxLength={80}
          required
          autoFocus
          defaultValue={view?.name}
        />
      </Field>
      {writable && (
        <label className="cloud-checkbox-field">
          <input type="checkbox" name="shared" defaultChecked={view?.shared} />
          Share with organization
        </label>
      )}
    </FormDialog>
  );
}
