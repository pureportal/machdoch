"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUpRight, BrainCircuit, X } from "lucide-react";
import {
  aiActivityFilters,
  mimoriiLogsUrl,
  type AiActivityEntry,
  type AiActivityFeed,
  type AiActivityFilter,
} from "@/lib/cloud-activity-contract";
import { Button } from "@/components/ui/button";
import { cloudRequest } from "./api-client";
import { RelativeTime } from "./relative-time";

export type AiActivityScope =
  | { kind: "run"; id: string; title: string }
  | { kind: "client"; id: string; title: string };

const filterLabels: Record<AiActivityFilter, string> = {
  all: "All",
  agent: "Agent",
  tasks: "Tasks",
  model: "Model calls",
  clients: "Clients",
};
const pollMs = 10_000;
const dayFormat = new Intl.DateTimeFormat("en", {
  weekday: "long",
  month: "long",
  day: "numeric",
  timeZone: "UTC",
});
const numberFormat = new Intl.NumberFormat("en");

function feedPath(
  filter: AiActivityFilter,
  problems: boolean,
  scope: AiActivityScope | null,
  before?: number,
): string {
  const parameters = new URLSearchParams({
    filter,
    problems: String(problems),
  });
  if (scope)
    parameters.set(scope.kind === "run" ? "runId" : "clientId", scope.id);
  if (before) parameters.set("before", String(before));
  return `ai-activity?${parameters}`;
}

function groupByDay(entries: AiActivityEntry[]) {
  const groups: { day: string; entries: AiActivityEntry[] }[] = [];
  for (const entry of entries) {
    const day = entry.occurredAt.slice(0, 10);
    const group = groups.at(-1);
    if (group?.day === day) group.entries.push(entry);
    else groups.push({ day, entries: [entry] });
  }
  return groups;
}

function usage(entry: AiActivityEntry): string[] {
  return [
    entry.client ? null : entry.actorName,
    entry.client ? entry.provider : null,
    entry.model,
    entry.tokens === null
      ? null
      : `${numberFormat.format(entry.tokens)} tokens`,
    entry.durationMs === null
      ? null
      : `${(entry.durationMs / 1000).toFixed(1)} s`,
  ].filter((value): value is string => Boolean(value));
}

function ActivityEntry({ entry }: { entry: AiActivityEntry }) {
  const meta = usage(entry);
  return (
    <li className="cloud-ai-activity-entry" data-status={entry.status}>
      <span className="cloud-ai-activity-dot" aria-hidden="true" />
      <div className="cloud-ai-activity-body">
        <p className="cloud-ai-activity-title">
          <span>{entry.title}</span>
          {entry.run && (
            <Link href={`/cloud/tasks/${entry.run.id}`}>
              {entry.issue && <span>{entry.issue.identifier}</span>}
              {entry.run.title}
            </Link>
          )}
          {entry.chatId && (
            <Link href={`/cloud/chat/${entry.chatId}`}>Conversation</Link>
          )}
          {entry.client && (
            <Link href={`/instances/${encodeURIComponent(entry.client.id)}`}>
              {entry.client.name}
            </Link>
          )}
        </p>
        {entry.detail && (
          <p className="cloud-ai-activity-detail">{entry.detail}</p>
        )}
        {meta.length > 0 && (
          <p className="cloud-ai-activity-meta">{meta.join(" · ")}</p>
        )}
      </div>
      <RelativeTime value={entry.occurredAt} />
    </li>
  );
}

export function AiActivityView({
  initial,
  scope,
  admin,
}: {
  initial: AiActivityFeed;
  scope: AiActivityScope | null;
  admin: boolean;
}) {
  const [filter, setFilter] = useState<AiActivityFilter>("all");
  const [problems, setProblems] = useState(false);
  const [latest, setLatest] = useState(initial);
  const [older, setOlder] = useState<AiActivityEntry[]>([]);
  const [before, setBefore] = useState(initial.before);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const selection = useRef({ filter, problems });
  selection.current = { filter, problems };
  const filters = aiActivityFilters.filter(
    (entry) => entry !== "clients" || (admin && scope?.kind !== "run"),
  );

  const refresh = useCallback(
    async (nextFilter: AiActivityFilter, nextProblems: boolean) => {
      const page = await cloudRequest<AiActivityFeed>(
        feedPath(nextFilter, nextProblems, scope),
      );
      const current = selection.current;
      if (current.filter !== nextFilter || current.problems !== nextProblems)
        return null;
      setLatest(page);
      setError("");
      return page;
    },
    [scope],
  );

  useEffect(() => {
    const timer = setInterval(() => {
      if (document.hidden) return;
      const current = selection.current;
      void refresh(current.filter, current.problems).catch((reason: Error) =>
        setError(reason.message),
      );
    }, pollMs);
    return () => clearInterval(timer);
  }, [refresh]);

  function choose(nextFilter: AiActivityFilter, nextProblems: boolean) {
    setFilter(nextFilter);
    setProblems(nextProblems);
    selection.current = { filter: nextFilter, problems: nextProblems };
    setOlder([]);
    setLoading(true);
    void refresh(nextFilter, nextProblems)
      .then((page) => {
        if (page) setBefore(page.before);
      })
      .catch((reason: Error) => setError(reason.message))
      .finally(() => setLoading(false));
  }

  function loadMore() {
    if (!before) return;
    setLoading(true);
    void cloudRequest<AiActivityFeed>(feedPath(filter, problems, scope, before))
      .then((page) => {
        setOlder((current) => [...current, ...page.entries]);
        setBefore(page.before);
      })
      .catch((reason: Error) => setError(reason.message))
      .finally(() => setLoading(false));
  }

  const shown = new Set(latest.entries.map((entry) => entry.id));
  const entries = [
    ...latest.entries,
    ...older.filter((entry) => !shown.has(entry.id)),
  ];
  const mimorii = latest.mimorii;
  return (
    <>
      <header className="cloud-page-header">
        <h1>AI activity</h1>
        <div className="flex flex-wrap items-center gap-2">
          {mimorii?.enabled && (
            <Button variant="outline" asChild>
              <a
                href={mimoriiLogsUrl(mimorii.url)}
                target="_blank"
                rel="noreferrer"
              >
                Open in Mimorii
                <ArrowUpRight />
              </a>
            </Button>
          )}
          {admin && !mimorii && (
            <Button variant="outline" asChild>
              <Link href="/cloud/settings?tab=mimorii">Connect Mimorii</Link>
            </Button>
          )}
        </div>
      </header>
      {mimorii?.enabled && mimorii.failing && (
        <p role="alert" className="cloud-error">
          Mimorii is not receiving AI activity.
          {admin && (
            <>
              {" "}
              <Link href="/cloud/settings?tab=mimorii">
                Review the connection
              </Link>
            </>
          )}
        </p>
      )}
      <div className="cloud-ai-activity-toolbar">
        <nav className="cloud-inbox-tabs" aria-label="Activity types">
          {filters.map((entry) => (
            <button
              key={entry}
              type="button"
              aria-current={filter === entry ? "page" : undefined}
              onClick={() => choose(entry, problems)}
            >
              {filterLabels[entry]}
            </button>
          ))}
        </nav>
        <Button
          variant="ghost"
          size="sm"
          aria-pressed={problems}
          onClick={() => choose(filter, !problems)}
        >
          Problems only
        </Button>
        {scope && (
          <Link className="cloud-ai-activity-scope" href="/cloud/activity">
            {scope.title}
            <X size={13} aria-label="Show all activity" />
          </Link>
        )}
      </div>
      {error && (
        <p role="alert" className="cloud-error">
          {error}
        </p>
      )}
      {!entries.length ? (
        <div className="cloud-empty">
          <BrainCircuit aria-hidden="true" />
          <p>
            {filter === "all" && !problems && !scope
              ? "No AI activity yet."
              : "No matching activity."}
          </p>
        </div>
      ) : (
        <div className="cloud-ai-activity" aria-busy={loading || undefined}>
          {groupByDay(entries).map((group) => (
            <section key={group.day} aria-label={group.day}>
              <h2>{dayFormat.format(new Date(`${group.day}T12:00:00Z`))}</h2>
              <ol>
                {group.entries.map((entry) => (
                  <ActivityEntry key={entry.id} entry={entry} />
                ))}
              </ol>
            </section>
          ))}
          {before && (
            <Button variant="outline" disabled={loading} onClick={loadMore}>
              Load older activity
            </Button>
          )}
        </div>
      )}
    </>
  );
}
