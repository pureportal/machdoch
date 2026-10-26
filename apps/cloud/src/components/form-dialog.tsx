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

export function FormDialog({
  open,
  onOpenChange,
  title,
  submitLabel,
  onSubmit,
  children,
  focusWhenOpenerRemoved,
  submitDisabled = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  submitLabel: string;
  onSubmit: (form: FormData) => Promise<void>;
  children: React.ReactNode;
  focusWhenOpenerRemoved?: React.RefObject<HTMLElement | null>;
  submitDisabled?: boolean;
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
          const target = returnFocus.current?.isConnected
            ? returnFocus.current
            : focusWhenOpenerRemoved?.current;
          if (target?.isConnected) {
            event.preventDefault();
            target.focus();
          }
        }}
      >
        <DialogTitle>{title}</DialogTitle>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (submitting.current || submitDisabled) return;
            const form = new FormData(event.currentTarget);
            submitting.current = true;
            setPending(true);
            setError("");
            void Promise.resolve()
              .then(() => onSubmit(form))
              .then(() => onOpenChange(false))
              .catch((reason: unknown) =>
                setError(
                  reason instanceof Error
                    ? reason.message
                    : "Changes could not be saved. Try again.",
                ),
              )
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
              <Button ref={submit} type="submit" disabled={submitDisabled}>
                {pending ? "Saving…" : submitLabel}
              </Button>
            </DialogFooter>
          </fieldset>
        </form>
      </DialogContent>
    </Dialog>
  );
}
