"use client";
import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import type { ScheduleOccurrence } from "@/lib/cloud-schedule-contract";
import { Button } from "@/components/ui/button";
import { cloudRequest } from "./api-client";

export function ScheduleHistory({ id }: { id: string }) {
  const [open, setOpen] = useState(false),
    [loading, setLoading] = useState(false),
    [error, setError] = useState("");
  const [items, setItems] = useState<ScheduleOccurrence[]>([]),
    [more, setMore] = useState(false);
  const region = useId(),
    controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  function load(append = false) {
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    setLoading(true);
    setError("");
    const last = append ? items.at(-1) : null;
    const cursor = last
      ? `?beforeAt=${last.at}&beforeRevision=${last.revision}`
      : "";
    void cloudRequest<ScheduleOccurrence[]>(
      `schedules/${id}/history${cursor}`,
      { signal: abort.signal },
    )
      .then((rows) => {
        if (abort.signal.aborted) return;
        setItems((previous) => (append ? [...previous, ...rows] : rows));
        setMore(rows.length === 100);
      })
      .catch((reason: Error) => {
        if (!abort.signal.aborted) setError(reason.message);
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
  }
  return (
    <>
      <Button
        variant="ghost"
        aria-expanded={open}
        aria-controls={region}
        onClick={() => {
          if (open) {
            controller.current?.abort();
            setOpen(false);
          } else {
            setOpen(true);
            load();
          }
        }}
      >
        History
      </Button>
      {open && (
        <div
          id={region}
          aria-label="Schedule history"
          aria-busy={loading}
          className="grid gap-2 border-t pt-3"
        >
          {!items.length && !loading && !error && <p>No occurrences yet.</p>}
          {items.map((item) => (
            <div
              key={`${item.revision}/${item.at}`}
              className="grid gap-1 text-sm"
            >
              <div className="flex flex-wrap justify-between gap-2">
                <time dateTime={new Date(item.at).toISOString()}>
                  {new Date(item.at)
                    .toISOString()
                    .replace("T", " ")
                    .replace(".000Z", " UTC")}
                </time>
                {item.runId ? (
                  <Link
                    className="underline"
                    href={`/cloud/tasks/${item.runId}`}
                  >
                    {item.runState?.replaceAll("_", " ") ?? "AI task"}
                  </Link>
                ) : item.issueId ? (
                  <Link
                    className="underline"
                    href={`/cloud/issues/${item.issueId}`}
                  >
                    {item.identifier}
                  </Link>
                ) : (
                  <span>{item.reason ?? "Missed dates skipped"}</span>
                )}
              </div>
              {item.runId && (
                <p className="text-muted-foreground">
                  {item.usedTokens.toLocaleString()} tokens used
                  {item.reservedTokens > 0
                    ? ` · ${item.reservedTokens.toLocaleString()} reserved${["succeeded", "failed", "canceled", "timed_out"].includes(item.runState ?? "") ? " (usage unconfirmed)" : ""}`
                    : ""}
                </p>
              )}
            </div>
          ))}
          {error && <p role="alert">{error}</p>}
          {loading ? (
            <p role="status">Loading…</p>
          ) : (
            (more || error) && (
              <Button variant="outline" onClick={() => load(items.length > 0)}>
                {items.length ? "Load earlier" : "Retry history"}
              </Button>
            )
          )}
        </div>
      )}
    </>
  );
}
