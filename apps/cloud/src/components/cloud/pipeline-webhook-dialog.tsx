"use client";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useToast } from "./toast";

export function PipelineWebhookDialog({
  token,
  onClose,
}: {
  token: string;
  onClose: () => void;
}) {
  const toast = useToast();
  const url = `${window.location.origin}/api/v1/release-pipelines/hooks/${token}`;
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent aria-describedby="pipeline-webhook-hint">
        <DialogTitle>Webhook URL</DialogTitle>
        <p id="pipeline-webhook-hint" className="text-sm">
          Copy it now. It is shown only once.
        </p>
        <Input readOnly value={url} aria-label="Webhook URL" />
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() =>
              void navigator.clipboard
                .writeText(url)
                .then(() => toast("Copied"))
                .catch((reason: Error) => toast(reason.message, "error"))
            }
          >
            Copy
          </Button>
          <DialogClose asChild>
            <Button type="button">Done</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
