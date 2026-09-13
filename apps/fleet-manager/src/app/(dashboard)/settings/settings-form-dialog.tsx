"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog";
import { settingsError } from "./use-settings-profiles";

export function SettingsFormDialog({
  open,
  onOpenChange,
  title,
  submitLabel,
  onSubmit,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  submitLabel: string;
  onSubmit: (form: FormData) => Promise<void>;
  children: React.ReactNode;
}): React.ReactElement {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const submitting = useRef(false);
  const returnFocus = useRef<HTMLElement | null>(null);
  const footer = useRef<HTMLDivElement>(null);
  const submit = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (pending || !error) return;
    submit.current?.focus({ preventScroll: true });
    footer.current?.scrollIntoView({ block: "nearest" });
  }, [error, pending]);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (submitting.current) return;
        setError("");
        onOpenChange(next);
      }}
    >
      <DialogContent
        className="max-w-2xl"
        aria-describedby={undefined}
        closeDisabled={pending}
        onOpenAutoFocus={() => {
          returnFocus.current =
            document.activeElement instanceof HTMLElement
              ? document.activeElement
              : null;
        }}
        onCloseAutoFocus={(event) => {
          if (returnFocus.current?.isConnected) {
            event.preventDefault();
            returnFocus.current.focus();
          }
        }}
      >
        <DialogTitle>{title}</DialogTitle>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (submitting.current) return;
            const form = new FormData(event.currentTarget);
            submitting.current = true;
            setPending(true);
            setError("");
            void Promise.resolve()
              .then(() => onSubmit(form))
              .then(() => onOpenChange(false))
              .catch((reason: unknown) => setError(settingsError(reason)))
              .finally(() => {
                submitting.current = false;
                setPending(false);
              });
          }}
        >
          <fieldset disabled={pending} className="grid min-w-0 gap-5">
            {children}
            {error ? (
              <p role="alert" className="break-words text-sm text-destructive">
                {error}
              </p>
            ) : null}
            <DialogFooter ref={footer}>
              <DialogClose asChild>
                <Button type="button" variant="outline">
                  Cancel
                </Button>
              </DialogClose>
              <Button ref={submit} type="submit">
                {pending ? "Saving…" : submitLabel}
              </Button>
            </DialogFooter>
          </fieldset>
        </form>
      </DialogContent>
    </Dialog>
  );
}
