"use client";

import { Monitor, RefreshCw, Search, X } from "lucide-react";
import { useRef, useState } from "react";
import { EnrollDevice } from "@/components/enrollment/enroll-device";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { formatRelativeTime, formatTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { DeviceList } from "./device-list";
import { DeviceDetails } from "./device-details";
import {
  selectDevices,
  summarizeFleet,
  type DeviceFilter,
  type DeviceSort,
} from "./fleet-overview";
import { FleetSummary } from "./fleet-summary";
import { useFleetInstances } from "./use-fleet-instances";

export function InstancesView(): React.ReactElement {
  const { instances, loading, error, updatedAt, load } = useFleetInstances();
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<DeviceFilter>("active");
  const [sort, setSort] = useState<DeviceSort>("status");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedTrigger = useRef<HTMLButtonElement | null>(null);
  const refreshButton = useRef<HTMLButtonElement | null>(null);
  const selectedDevice = instances?.find(
    (device) => device.instanceId === selectedId,
  );
  const summary = summarizeFleet(instances ?? []);
  const devices = selectDevices(instances ?? [], query, status, sort);
  const resetFilters = (): void => {
    setQuery("");
    setStatus("active");
  };

  return (
    <section className="grid gap-6 sm:gap-8">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-3xl font-semibold tracking-tight">Overview</h1>
        <div className="flex items-center gap-2">
          <Button
            ref={refreshButton}
            variant="outline"
            disabled={loading}
            onClick={() => void load()}
            aria-label="Refresh devices"
          >
            <RefreshCw className={cn(loading && "motion-safe:animate-spin")} />
            <span className="hidden sm:inline">Refresh</span>
          </Button>
          <EnrollDevice onClose={() => void load()} />
        </div>
      </header>
      {error ? (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-3 rounded-xl border border-destructive/25 bg-destructive/5 p-4 text-sm"
        >
          <div className="min-w-0 flex-1">
            <p className="text-destructive">{error}</p>
            {instances !== null ? (
              <p className="mt-1 text-muted-foreground">
                Showing the last known device status.
              </p>
            ) : null}
          </div>
          <Button
            variant="outline"
            disabled={loading}
            onClick={() => void load()}
          >
            Retry
          </Button>
        </div>
      ) : null}
      <FleetSummary
        instances={instances}
        selected={status}
        onSelect={(filter) => {
          setStatus(filter);
          setQuery("");
        }}
        stale={Boolean(error)}
      />
      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-5 sm:px-6">
          <h2 className="text-base font-semibold">Devices</h2>
          {updatedAt !== null ? (
            <p
              className="text-xs text-muted-foreground"
              title={formatTime(updatedAt)}
            >
              {error ? "Last updated" : "Updated"}{" "}
              {Date.now() / 1000 - updatedAt < 60
                ? "just now"
                : formatRelativeTime(updatedAt)}
            </p>
          ) : null}
        </div>
        {instances !== null && instances.length > 0 ? (
          <div className="grid gap-3 border-b bg-muted/25 p-4 sm:px-6">
            <div className="flex flex-wrap gap-2">
              <div className="relative basis-full flex-1 sm:min-w-44 sm:basis-auto">
                <Search
                  className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted-foreground"
                  aria-hidden="true"
                />
                <Input
                  type="search"
                  aria-label="Search devices"
                  placeholder="Search devices"
                  className="pl-9 pr-9"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
                {query ? (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="absolute right-0 top-0"
                    aria-label="Clear search"
                    onClick={() => setQuery("")}
                  >
                    <X />
                  </Button>
                ) : null}
              </div>
              <Select
                aria-label="Device status"
                className="w-auto flex-1 basis-36 sm:flex-none sm:basis-auto"
                value={status}
                onChange={(event) =>
                  setStatus(event.target.value as DeviceFilter)
                }
              >
                <option value="active">Active ({summary.active})</option>
                <option value="online">Online ({summary.online})</option>
                <option value="offline">Offline ({summary.offline})</option>
                <option value="revoked">Revoked ({summary.revoked})</option>
              </Select>
              <Select
                aria-label="Sort devices"
                className="w-auto flex-1 basis-36 sm:flex-none sm:basis-auto"
                value={sort}
                onChange={(event) => setSort(event.target.value as DeviceSort)}
              >
                <option value="status">Offline first</option>
                <option value="name">Name</option>
                <option value="last-seen">Last seen</option>
                <option value="enrolled">Newest enrolled</option>
              </Select>
            </div>
          </div>
        ) : null}
        {instances === null ? (
          <div
            role="status"
            className="grid min-h-60 place-items-center p-6 text-sm text-muted-foreground"
          >
            {loading ? "Loading devices…" : "Devices could not be loaded."}
          </div>
        ) : instances.length === 0 ? (
          <div className="grid min-h-64 justify-items-center content-center gap-4 p-6 text-center">
            <span className="grid size-12 place-items-center rounded-2xl bg-primary/10 text-primary">
              <Monitor aria-hidden="true" />
            </span>
            <p className="font-medium">No devices yet</p>
            <EnrollDevice onClose={() => void load()} />
          </div>
        ) : devices.length === 0 ? (
          <div
            role="status"
            className="grid min-h-52 justify-items-center content-center gap-4 p-6 text-center"
          >
            <p className="text-sm text-muted-foreground">
              {query.trim() ? "No matching devices." : `No ${status} devices.`}
            </p>
            {query || status !== "active" ? (
              <Button variant="outline" onClick={resetFilters}>
                Clear filters
              </Button>
            ) : null}
          </div>
        ) : (
          <DeviceList
            devices={devices}
            onSelect={(instanceId, trigger) => {
              selectedTrigger.current = trigger;
              setSelectedId(instanceId);
            }}
          />
        )}
      </Card>
      {selectedDevice ? (
        <DeviceDetails
          device={selectedDevice}
          onClose={() => setSelectedId(null)}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (selectedTrigger.current?.isConnected)
              selectedTrigger.current.focus();
            else refreshButton.current?.focus();
          }}
          onRevoked={async () => {
            await load();
            setSelectedId(null);
          }}
        />
      ) : null}
    </section>
  );
}
