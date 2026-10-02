import { Monitor, Wifi, WifiOff } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  summarizeFleet,
  type DeviceFilter,
  type FleetInstance,
} from "./fleet-overview";

export function FleetSummary({
  instances,
  selected,
  onSelect,
  stale,
}: {
  instances: FleetInstance[] | null;
  selected: DeviceFilter;
  onSelect: (filter: DeviceFilter) => void;
  stale: boolean;
}): React.ReactElement {
  const summary = summarizeFleet(instances ?? []);
  const cards = [
    {
      filter: "active",
      label: "Active",
      count: summary.active,
      icon: Monitor,
      color: "text-primary",
      background: "bg-primary/10",
    },
    {
      filter: "online",
      label: "Online",
      count: summary.online,
      icon: Wifi,
      color: "text-emerald-700 dark:text-emerald-300",
      background: "bg-emerald-500/10",
    },
    {
      filter: "offline",
      label: "Offline",
      count: summary.offline,
      icon: WifiOff,
      color: "text-amber-700 dark:text-amber-300",
      background: "bg-amber-500/10",
    },
  ] as const;
  const percent = summary.active
    ? Math.round((summary.online / summary.active) * 100)
    : 0;
  return (
    <div
      role="group"
      className="grid grid-cols-3 overflow-hidden rounded-2xl border bg-card p-1.5 sm:p-2"
      aria-label={stale ? "Last known fleet status" : "Fleet status"}
    >
      {cards.map(({ filter, label, count, icon: Icon, color, background }) => (
        <button
          key={filter}
          type="button"
          aria-pressed={selected === filter}
          onClick={() => onSelect(filter)}
          disabled={instances === null}
          className={cn(
            "relative min-w-0 cursor-pointer rounded-xl p-3 text-left transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default sm:p-5",
            selected === filter ? "bg-secondary/70" : "bg-card",
          )}
        >
          <div className="flex min-h-8 flex-wrap items-center justify-between gap-2">
            <span className="text-xs font-medium text-muted-foreground sm:text-sm">
              {label}
            </span>
            <span
              className={cn(
                "hidden size-8 place-items-center rounded-lg sm:grid",
                color,
                background,
              )}
            >
              <Icon className="size-4" aria-hidden="true" />
            </span>
          </div>
          <div className="mt-3 flex items-baseline gap-2">
            <span className="text-3xl font-semibold tracking-tight tabular-nums sm:text-4xl">
              {instances === null ? "—" : count}
            </span>
            {filter === "online" && instances !== null && summary.active > 0 ? (
              <span className="text-xs tabular-nums text-muted-foreground sm:text-sm">
                / {summary.active}
              </span>
            ) : null}
          </div>
          <div
            className="mt-4 h-1 overflow-hidden rounded-full bg-muted"
            aria-hidden="true"
          >
            <div
              className={cn(
                "h-full rounded-full",
                filter === "online"
                  ? "bg-emerald-500"
                  : filter === "offline"
                    ? "bg-amber-500"
                    : "bg-primary",
              )}
              style={{
                width:
                  instances === null || summary.active === 0
                    ? "0%"
                    : filter === "active"
                      ? "100%"
                      : `${filter === "online" ? percent : 100 - percent}%`,
              }}
            />
          </div>
        </button>
      ))}
    </div>
  );
}
