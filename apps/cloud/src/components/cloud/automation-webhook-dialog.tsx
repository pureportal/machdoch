"use client";

import { CopyField } from "@/components/copy-field";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";

export function AutomationWebhookDialog({
  url,
  onClose,
}: {
  url: string;
  onClose: () => void;
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent aria-describedby={undefined}>
        <DialogTitle>Webhook address</DialogTitle>
        <p className="text-sm text-muted-foreground">
          Copy it now. It is shown only once.
        </p>
        <CopyField label="POST JSON to" value={url} monospace />
      </DialogContent>
    </Dialog>
  );
}
