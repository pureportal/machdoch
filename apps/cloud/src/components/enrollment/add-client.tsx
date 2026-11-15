"use client";

import { Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { CopyField } from "@/components/copy-field";
import { ShowMore } from "@/components/show-more";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog";
import { EnrollmentKeyForm } from "./enrollment-key-form";
import { useEnrollmentKeys } from "./use-enrollment-keys";

export function AddClient({
  cloudUrl,
  manager,
  onClose,
}: {
  cloudUrl: string;
  manager: boolean;
  onClose: () => void;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const close = () => {
    setOpen(false);
    onClose();
  };
  return (
    <>
      <Button ref={trigger} onClick={() => setOpen(true)}>
        <Plus />
        Add client
      </Button>
      {open ? (
        <Dialog
          open
          onOpenChange={(next) => {
            if (!next && !pending) close();
          }}
        >
          <DialogContent
            aria-describedby={undefined}
            closeDisabled={pending}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              trigger.current?.focus();
            }}
          >
            <DialogTitle>Add a client</DialogTitle>
            <ol className="grid list-decimal gap-2 pl-5 text-sm">
              <li>Open Machdoch on the computer.</li>
              <li>
                Open <strong>machdoch.cloud › Account</strong>, enter this
                address and select <strong>Sign in</strong>.
              </li>
            </ol>
            <CopyField label="Cloud URL" value={cloudUrl} />
            {manager ? <EnrollmentKeyOption onPending={setPending} /> : null}
            <DialogFooter>
              <Button variant="outline" disabled={pending} onClick={close}>
                Done
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </>
  );
}

function EnrollmentKeyOption({
  onPending,
}: {
  onPending: (pending: boolean) => void;
}): React.ReactElement {
  const enrollment = useEnrollmentKeys();
  useEffect(
    () => onPending(enrollment.pending),
    [enrollment.pending, onPending],
  );
  return (
    <ShowMore>
      <p className="text-sm text-muted-foreground">
        For computers that can't open a browser.
      </p>
      <EnrollmentKeyForm enrollment={enrollment} />
    </ShowMore>
  );
}
