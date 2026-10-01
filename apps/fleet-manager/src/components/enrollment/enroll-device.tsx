"use client";

import { Plus } from "lucide-react";
import Link from "next/link";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog";
import { EnrollmentKeyForm } from "./enrollment-key-form";
import { useEnrollmentKeys } from "./use-enrollment-keys";

export function EnrollDevice({
  onClose,
}: {
  onClose: () => void;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement | null>(null);
  return (
    <>
      <Button ref={trigger} onClick={() => setOpen(true)}>
        <Plus />
        Enroll device
      </Button>
      {open ? (
        <EnrollmentDialog
          onClose={() => {
            setOpen(false);
            onClose();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            trigger.current?.focus();
          }}
        />
      ) : null}
    </>
  );
}

function EnrollmentDialog({
  onClose,
  onCloseAutoFocus,
}: {
  onClose: () => void;
  onCloseAutoFocus: (event: Event) => void;
}): React.ReactElement {
  const enrollment = useEnrollmentKeys();
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !enrollment.pending) onClose();
      }}
    >
      <DialogContent
        aria-describedby={undefined}
        closeDisabled={enrollment.pending}
        onCloseAutoFocus={onCloseAutoFocus}
      >
        <DialogTitle>Enroll device</DialogTitle>
        <EnrollmentKeyForm enrollment={enrollment} />
        <DialogFooter>
          <Button
            asChild
            variant="ghost"
            disabled={enrollment.pending}
            className={enrollment.pending ? "pointer-events-none" : undefined}
          >
            <Link
              href="/enrollment"
              aria-disabled={enrollment.pending}
              tabIndex={enrollment.pending ? -1 : undefined}
              onClick={(event) => {
                if (enrollment.pending) event.preventDefault();
              }}
            >
              Manage keys
            </Link>
          </Button>
          <Button
            variant="outline"
            disabled={enrollment.pending}
            onClick={onClose}
          >
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
