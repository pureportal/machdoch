"use client";

import { useState } from "react";
import type * as React from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "./ui/alert-dialog";
import { Button } from "./ui/button";

export function ConfirmButton({
  trigger,
  open: controlledOpen,
  onOpenChange,
  title,
  description,
  actionLabel,
  onConfirm,
  destructive = true,
  onCloseAutoFocus,
}: {
  trigger?: React.ReactElement;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  title: string;
  description: string;
  actionLabel: string;
  onConfirm: () => void | Promise<void>;
  destructive?: boolean;
  onCloseAutoFocus?: (event: Event) => void;
}): React.ReactElement {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = controlledOpen ?? uncontrolledOpen;
  const setOpen = onOpenChange ?? setUncontrolledOpen;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  return (
    <AlertDialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (pending) return;
        setOpen(nextOpen);
        if (!nextOpen) setError("");
      }}
    >
      {trigger && <AlertDialogTrigger asChild>{trigger}</AlertDialogTrigger>}
      <AlertDialogContent onCloseAutoFocus={onCloseAutoFocus}>
        <AlertDialogTitle>{title}</AlertDialogTitle>
        <AlertDialogDescription>{description}</AlertDialogDescription>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel asChild>
            <Button variant="outline" disabled={pending}>
              Cancel
            </Button>
          </AlertDialogCancel>
          <AlertDialogAction
            disabled={pending}
            className={
              destructive
                ? undefined
                : "bg-primary text-primary-foreground hover:bg-primary/90"
            }
            onClick={(event) => {
              event.preventDefault();
              setPending(true);
              setError("");
              void Promise.resolve()
                .then(onConfirm)
                .then(() => setOpen(false))
                .catch((reason: unknown) =>
                  setError(
                    reason instanceof Error
                      ? reason.message
                      : "Action could not be completed.",
                  ),
                )
                .finally(() => setPending(false));
            }}
          >
            {actionLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
