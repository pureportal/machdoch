"use client";

import { useRouter } from "next/navigation";
import { useRef } from "react";
import { viewFilterKeys } from "@/lib/cloud-view-contract";
import { Field } from "@/components/field";
import { FormDialog } from "@/components/form-dialog";
import { Input } from "@/components/ui/input";
import { createCommandSender, formText } from "./api-client";

export function SaveViewDialog({
  open,
  onOpenChange,
  filters,
  writable,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  filters: Record<string, string>;
  writable: boolean;
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
      title="Save view"
      submitLabel="Save view"
      onSubmit={async (form) => {
        await sender.current("views", {
          name: formText(form, "name"),
          shared: formText(form, "shared") === "on",
          filters: Object.fromEntries(
            viewFilterKeys.flatMap((key) =>
              filters[key] === undefined ? [] : [[key, filters[key]]],
            ),
          ),
        });
        router.refresh();
      }}
    >
      <Field label="Name" htmlFor="view-name">
        <Input id="view-name" name="name" maxLength={80} required autoFocus />
      </Field>
      {writable && (
        <label className="cloud-checkbox-field">
          <input type="checkbox" name="shared" />
          Share with organization
        </label>
      )}
    </FormDialog>
  );
}
