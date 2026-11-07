import type { JSX } from "react";
import { Button } from "@machdoch/media-studio/tauri/ui/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@machdoch/media-studio/tauri/ui/components/ui/dialog.js";
import type { SmartContextPack } from "./model";

export interface ContextPackDeletion {
  pack: SmartContextPack;
  ralphFlowNames: string[] | null;
  deleting: boolean;
  error: string | null;
}

export function ContextPackDeleteDialog({
  deletion,
  onCancel,
  onConfirm,
}: {
  deletion: ContextPackDeletion;
  onCancel: () => void;
  onConfirm: () => void;
}): JSX.Element {
  const { pack, ralphFlowNames, deleting, error } = deletion;
  const usingFlowNames = ralphFlowNames ?? [];

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !deleting) onCancel();
      }}
    >
      <DialogContent
        showCloseButton={false}
        {...(usingFlowNames.length > 0 ? {} : { "aria-describedby": undefined })}
      >
        <DialogHeader>
          <DialogTitle>Delete {pack.name}?</DialogTitle>
          {usingFlowNames.length > 0 ? (
            <DialogDescription>
              Used by {usingFlowNames.join(", ")}.
            </DialogDescription>
          ) : null}
        </DialogHeader>
        {error ? (
          <p role="alert" className="text-sm text-(--destructive)">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="outline" disabled={deleting} onClick={onCancel}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={deleting || ralphFlowNames === null}
            onClick={onConfirm}
          >
            {deleting ? "Deleting..." : "Delete pack"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
