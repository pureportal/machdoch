"use client";

import { ExternalLink, Trash2 } from "lucide-react";
import { api } from "@machdoch/product-ui/fleet-api";
import { ConfirmButton } from "@/components/confirm-button";
import { CopyField } from "@/components/copy-field";
import { ShowMore } from "@/components/show-more";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog";
import { formatTime } from "@/lib/format";
import type { FleetInstance } from "./fleet-overview";

export function DeviceDetails({
  device,
  onClose,
  onRevoked,
  onCloseAutoFocus,
}: {
  device: FleetInstance;
  onClose: () => void;
  onRevoked: () => Promise<void>;
  onCloseAutoFocus: (event: Event) => void;
}): React.ReactElement {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        aria-describedby={undefined}
        onCloseAutoFocus={onCloseAutoFocus}
      >
        <div className="grid justify-items-start gap-2">
          <DialogTitle>{device.displayName}</DialogTitle>
          <Badge variant={device.status}>{device.status}</Badge>
        </div>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-3 text-sm">
          <dt className="text-muted-foreground">Version</dt>
          <dd>v{device.productVersion}</dd>
          <dt className="text-muted-foreground">Enrolled</dt>
          <dd>{formatTime(device.enrolledAt)}</dd>
          <dt className="text-muted-foreground">Last seen</dt>
          <dd>
            {device.lastSeenAt === null
              ? "Never connected"
              : formatTime(device.lastSeenAt)}
          </dd>
        </dl>
        <ShowMore>
          <CopyField label="Device ID" value={device.instanceId} monospace />
        </ShowMore>
        <DialogFooter>
          {device.status !== "revoked" ? (
            <ConfirmButton
              trigger={
                <Button variant="ghost" className="mr-auto text-destructive">
                  <Trash2 />
                  Revoke device
                </Button>
              }
              title={`Revoke ${device.displayName}?`}
              description="The device will disconnect and lose Fleet Manager access. Enroll it again to reconnect."
              actionLabel="Revoke device"
              onConfirm={async () => {
                await api(
                  `/api/instances/${encodeURIComponent(device.instanceId)}`,
                  { method: "DELETE" },
                );
                await onRevoked();
              }}
            />
          ) : null}
          {device.status === "online" ? (
            <Button asChild>
              <a href={`/instances/${encodeURIComponent(device.instanceId)}`}>
                <ExternalLink />
                Open device
              </a>
            </Button>
          ) : null}
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
