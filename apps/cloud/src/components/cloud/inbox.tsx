"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowUpRight,
  Bot,
  CheckCheck,
  Inbox as InboxIcon,
  X,
} from "lucide-react";
import { MarkdownContent } from "@machdoch/client-ui/conversation/markdown-content";
import type { CloudIssue } from "@/lib/cloud-contract";
import type { InboxEntry, InboxUpdate } from "@/lib/cloud-inbox-contract";
import { Button } from "@/components/ui/button";
import { cloudRequest } from "./api-client";
import { IssuePriority } from "./issue-priority";
import { priorityNames } from "./issue-properties";
import { PersonAvatar } from "./person-avatar";
import { RelativeTime } from "./relative-time";
import { TaskState } from "./task-state";
import { useToast } from "./toast";

export const inboxChangedEvent = "machdoch:inbox-changed";
const pollMs = 20_000;
const priorityKinds: InboxEntry["kind"][] = ["assigned", "mentioned"];
type InboxTab = "priority" | "other";

function describe(entry: InboxEntry): string {
  const actor = entry.actor ?? "Someone";
  if (entry.kind === "assigned") return `${actor} assigned you`;
  if (entry.kind === "mentioned")
    return `${actor} mentioned you: ${entry.detail}`;
  if (entry.kind === "commented") return `${actor} commented: ${entry.detail}`;
  if (entry.kind === "status_changed")
    return `${actor} changed the status to ${entry.detail}`;
  return `AI task ${(entry.runState ?? "finished").replaceAll("_", " ")}${entry.detail ? `: ${entry.detail}` : ""}`;
}

function entryHref(entry: InboxEntry): string {
  return entry.kind === "task_finished" && entry.runId
    ? `/cloud/tasks/${entry.runId}`
    : `/cloud/issues/${entry.issueId}`;
}

function IssuePreview({ entry }: { entry: InboxEntry }) {
  const [issue, setIssue] = useState<CloudIssue | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!entry.issueId) return;
    const abort = new AbortController();
    setIssue(null);
    setError("");
    void cloudRequest<CloudIssue>(`issues/${entry.issueId}`, {
      signal: abort.signal,
    })
      .then(setIssue)
      .catch((reason: Error) => {
        if (!abort.signal.aborted) setError(reason.message);
      });
    return () => abort.abort();
  }, [entry.issueId]);
  return (
    <article className="cloud-inbox-preview">
      <header>
        <span className="cloud-issue-key">
          {entry.issueIdentifier ?? "AI task"}
        </span>
        <Button asChild variant="ghost" size="sm">
          <Link href={entryHref(entry)} prefetch={false}>
            Open
            <ArrowUpRight />
          </Link>
        </Button>
      </header>
      <h2>{entry.issueTitle ?? entry.runTitle}</h2>
      <p className="cloud-inbox-preview-event">
        <PersonAvatar name={entry.actor ?? "?"} className="cloud-avatar-tiny" />
        {describe(entry)}
        <RelativeTime value={entry.createdAt} />
      </p>
      {issue && (
        <>
          <div className="cloud-inbox-preview-properties">
            <span className="cloud-state" data-state={issue.state}>
              {issue.statusName}
            </span>
            <span>
              <IssuePriority priority={issue.priority} compact />
              {priorityNames[issue.priority]}
            </span>
            {issue.estimate && <span>{issue.estimate} points</span>}
          </div>
          {issue.description && (
            <MarkdownContent
              className="cloud-inbox-preview-description"
              content={issue.description}
            />
          )}
        </>
      )}
      {entry.runState && <TaskState state={entry.runState} />}
      {error && (
        <p role="alert" className="cloud-error">
          {error}
        </p>
      )}
    </article>
  );
}

export function Inbox({ initial }: { initial: InboxEntry[] }) {
  const toast = useToast();
  const [entries, setEntries] = useState(initial);
  const [tab, setTab] = useState<InboxTab>("priority");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const latest = useRef(entries);
  latest.current = entries;
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const result = await cloudRequest<{ entries: InboxEntry[] }>("inbox", {
      signal,
    });
    setEntries(result.entries);
  }, []);
  useEffect(() => {
    const abort = new AbortController();
    const timer = setInterval(() => {
      if (!document.hidden) void refresh(abort.signal).catch(() => undefined);
    }, pollMs);
    return () => {
      abort.abort();
      clearInterval(timer);
    };
  }, [refresh]);
  const update = useCallback(
    (
      input: InboxUpdate,
      optimistic: (entries: InboxEntry[]) => InboxEntry[],
    ) => {
      const previous = latest.current;
      setEntries(optimistic(previous));
      void cloudRequest("inbox/update", { method: "POST", body: input })
        .then(() => window.dispatchEvent(new Event(inboxChangedEvent)))
        .catch((reason: Error) => {
          setEntries(previous);
          toast(reason.message, "error");
        });
    },
    [toast],
  );
  const inTab = (entry: InboxEntry) =>
    priorityKinds.includes(entry.kind) === (tab === "priority");
  const visible = entries.filter(inTab);
  const selected = visible.find((entry) => entry.id === selectedId) ?? null;
  const unreadIn = (target: InboxTab) =>
    entries.filter(
      (entry) =>
        !entry.read &&
        priorityKinds.includes(entry.kind) === (target === "priority"),
    ).length;
  const select = useCallback(
    (entry: InboxEntry) => {
      setSelectedId(entry.id);
      if (!entry.read)
        update({ kind: "read", ids: [entry.id], read: true }, (current) =>
          current.map((item) =>
            item.id === entry.id ? { ...item, read: true } : item,
          ),
        );
    },
    [update],
  );
  const dismiss = useCallback(
    (entry: InboxEntry) =>
      update({ kind: "dismiss", ids: [entry.id] }, (current) =>
        current.filter((item) => item.id !== entry.id),
      ),
    [update],
  );
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        target?.closest("input,textarea,select,[role=dialog]")
      )
        return;
      const index = visible.findIndex((entry) => entry.id === selectedId);
      if (event.key === "j" || event.key === "ArrowDown") {
        const next = visible[Math.min(visible.length - 1, index + 1)];
        if (next) {
          event.preventDefault();
          select(next);
        }
      } else if (event.key === "k" || event.key === "ArrowUp") {
        const previous = visible[Math.max(0, index - 1)];
        if (previous) {
          event.preventDefault();
          select(previous);
        }
      } else if (event.key === "e" && selected) {
        event.preventDefault();
        const next = visible[index + 1] ?? visible[index - 1];
        dismiss(selected);
        setSelectedId(next?.id ?? null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [visible, selectedId, selected, select, dismiss]);
  const unread = entries.filter((entry) => !entry.read).length;
  return (
    <div className="cloud-inbox-layout">
      <section className="cloud-inbox-pane" aria-label="Notifications">
        <header className="cloud-inbox-header">
          <h1>Inbox</h1>
          {unread > 0 && (
            <Button
              variant="ghost"
              size="icon"
              aria-label="Mark all read"
              onClick={() =>
                update({ kind: "read-all" }, (current) =>
                  current.map((entry) => ({ ...entry, read: true })),
                )
              }
            >
              <CheckCheck />
            </Button>
          )}
        </header>
        <nav className="cloud-inbox-tabs" aria-label="Inbox views">
          {(["priority", "other"] as const).map((entry) => (
            <button
              key={entry}
              type="button"
              aria-current={tab === entry ? "page" : undefined}
              onClick={() => {
                setTab(entry);
                setSelectedId(null);
              }}
            >
              {entry === "priority" ? "Priority" : "Other"}
              {unreadIn(entry) > 0 && <span>{unreadIn(entry)}</span>}
            </button>
          ))}
        </nav>
        {!visible.length ? (
          <div className="cloud-inbox-empty">
            <InboxIcon aria-hidden="true" />
            <p>You’re all caught up.</p>
          </div>
        ) : (
          <ul className="cloud-inbox-list">
            {visible.map((entry) => (
              <li
                key={entry.id}
                data-unread={!entry.read || undefined}
                aria-current={entry.id === selectedId || undefined}
              >
                <button
                  type="button"
                  className="cloud-inbox-entry"
                  onClick={() => select(entry)}
                >
                  {entry.kind === "task_finished" ? (
                    <span className="cloud-icon-tile cloud-inbox-icon">
                      <Bot size={14} aria-hidden="true" />
                    </span>
                  ) : (
                    <PersonAvatar name={entry.actor ?? "?"} />
                  )}
                  <span className="cloud-inbox-body">
                    <span className="cloud-inbox-title">
                      {entry.issueIdentifier && (
                        <span className="cloud-issue-key">
                          {entry.issueIdentifier}
                        </span>
                      )}
                      <span>{entry.issueTitle ?? entry.runTitle}</span>
                    </span>
                    <span className="cloud-inbox-detail">
                      {describe(entry)}
                    </span>
                  </span>
                  <span className="cloud-inbox-meta">
                    <RelativeTime value={entry.createdAt} compact />
                    {entry.issueState && (
                      <span
                        className="cloud-state"
                        data-state={entry.issueState}
                        aria-hidden="true"
                      />
                    )}
                  </span>
                </button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="cloud-inbox-dismiss"
                  aria-label="Dismiss"
                  onClick={() => dismiss(entry)}
                >
                  <X />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="cloud-inbox-detail-pane" aria-label="Notification">
        {selected ? (
          <IssuePreview key={selected.id} entry={selected} />
        ) : (
          <div className="cloud-inbox-placeholder">
            <InboxIcon aria-hidden="true" />
          </div>
        )}
      </section>
    </div>
  );
}
