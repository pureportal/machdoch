"use client";

import { useEffect, useRef } from "react";
import { Check, CircleDot, LoaderCircle, Terminal, X } from "lucide-react";
import type { RunTimelineEntry } from "@machdoch/fleet-protocol/cloud-execution";

const clock = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

function StatusIcon({
  entry,
  live,
}: {
  entry: RunTimelineEntry;
  live: boolean;
}) {
  if (entry.status === "failed") return <X size={13} aria-hidden="true" />;
  if (entry.status === "passed") return <Check size={13} aria-hidden="true" />;
  if (entry.status === "started" && live)
    return <LoaderCircle size={13} className="animate-spin" aria-hidden="true" />;
  if (entry.kind === "model") return <Terminal size={13} aria-hidden="true" />;
  return <CircleDot size={13} aria-hidden="true" />;
}

export function TaskTimeline({
  entries,
  live,
}: {
  entries: RunTimelineEntry[];
  live: boolean;
}) {
  const list = useRef<HTMLOListElement>(null);
  const following = useRef(true);
  useEffect(() => {
    const element = list.current;
    if (element && following.current) element.scrollTop = element.scrollHeight;
  }, [entries.length]);
  if (!entries.length) return null;
  return (
    <section className="cloud-card cloud-task-timeline">
      <h2>
        Session
        {live && <span className="cloud-task-live">Live</span>}
      </h2>
      <ol
        ref={list}
        tabIndex={0}
        aria-label="Session activity"
        onScroll={(event) => {
          const element = event.currentTarget;
          following.current =
            element.scrollHeight - element.scrollTop - element.clientHeight < 32;
        }}
      >
        {entries.map((entry, index) => (
          <li key={entry.id} data-status={entry.status} data-kind={entry.kind}>
            <span className="cloud-timeline-icon">
              <StatusIcon entry={entry} live={live && index === entries.length - 1} />
            </span>
            <div>
              <div className="cloud-timeline-heading">
                <span>{entry.title}</span>
                <time dateTime={entry.at}>{clock.format(new Date(entry.at))}</time>
              </div>
              {entry.detail && <pre>{entry.detail}</pre>}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
