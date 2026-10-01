import { ExternalLink, Monitor, MoreHorizontal } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatRelativeTime, formatTime } from "@/lib/format";
import type { FleetInstance } from "./fleet-overview";

export function DeviceList({
  devices,
  onSelect,
}: {
  devices: FleetInstance[];
  onSelect: (instanceId: string, trigger: HTMLButtonElement) => void;
}): React.ReactElement {
  return (
    <div>
      <div
        className="hidden grid-cols-[minmax(0,1fr)_100px_100px_150px_124px] gap-4 border-b bg-muted/15 px-6 py-3 text-xs font-medium text-muted-foreground xl:grid"
        aria-hidden="true"
      >
        <span>Device</span>
        <span>Status</span>
        <span>Version</span>
        <span>Last seen</span>
        <span className="text-right">Actions</span>
      </div>
      <ul className="divide-y" aria-label="Devices">
        {devices.map((device) => (
          <li
            key={device.instanceId}
            className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-4 py-4 transition-colors hover:bg-muted/20 sm:px-6 xl:grid-cols-[minmax(0,1fr)_100px_100px_150px_124px] xl:items-center xl:gap-4"
          >
            <div className="col-start-1 row-start-1 flex min-w-0 items-center gap-3 xl:col-auto xl:row-auto">
              <span className="grid size-10 shrink-0 place-items-center rounded-xl border bg-muted/50 text-muted-foreground">
                <Monitor className="size-5" aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <button
                  type="button"
                  onClick={(event) =>
                    onSelect(device.instanceId, event.currentTarget)
                  }
                  className="block max-w-full cursor-pointer truncate rounded text-left text-sm font-semibold outline-none hover:text-primary focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {device.displayName}
                </button>
                <p className="mt-1 truncate font-mono text-xs text-muted-foreground">
                  {device.instanceId}
                </p>
              </div>
            </div>
            <div className="col-span-2 row-start-2 flex items-center gap-3 xl:contents">
              <div>
                <Badge variant={device.status}>{device.status}</Badge>
              </div>
              <span className="min-w-0 truncate text-xs text-muted-foreground xl:text-sm">
                v{device.productVersion}
              </span>
              <span
                className="ml-auto shrink-0 text-xs text-muted-foreground xl:ml-0"
                title={formatTime(device.lastSeenAt)}
              >
                <span className="sr-only">Last seen </span>
                {device.lastSeenAt === null
                  ? "Never connected"
                  : formatRelativeTime(device.lastSeenAt)}
              </span>
            </div>
            <div className="col-start-2 row-start-1 flex items-center justify-end gap-2 xl:col-auto xl:row-auto">
              {device.status === "online" ? (
                <Button asChild variant="outline" size="sm">
                  <a
                    href={`/instances/${encodeURIComponent(device.instanceId)}`}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={`Open ${device.displayName}`}
                  >
                    <ExternalLink aria-hidden="true" />
                    Open
                  </a>
                </Button>
              ) : null}
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Details for ${device.displayName}`}
                onClick={(event) =>
                  onSelect(device.instanceId, event.currentTarget)
                }
              >
                <MoreHorizontal />
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
