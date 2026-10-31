"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Bot, CheckCheck, Inbox as InboxIcon, X } from "lucide-react";
import type {
  InboxEntry,
  InboxUpdate,
} from "@/lib/cloud-inbox-contract";
import { Button } from "@/components/ui/button";
import { cloudRequest } from "./api-client";
import { PersonAvatar } from "./person-avatar";
import { TaskState } from "./task-state";
import { Timestamp } from "./timestamp";
import { useToast } from "./toast";

export const inboxChangedEvent = "machdoch:inbox-changed";
const pollMs = 20_000;

function describe(entry: InboxEntry): string {
  const actor = entry.actor ?? "Someone";
  if (entry.kind === "assigned") return `${actor} assigned you`;
  if (entry.kind === "mentioned") return `${actor} mentioned you`;
  if (entry.kind === "commented") return `${actor} commented`;
  return `AI task ${(entry.runState ?? "finished").replaceAll("_", " ")}`;
}

function entryHref(entry: InboxEntry): string {
  return entry.kind === "task_finished" && entry.runId
    ? `/cloud/tasks/${entry.runId}`
    : `/cloud/issues/${entry.issueId}`;
}

export function Inbox({ initial }: { initial: InboxEntry[] }) {
  const toast = useToast();
  const [entries, setEntries] = useState(initial);
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
  function update(input: InboxUpdate, optimistic: (entries: InboxEntry[]) => InboxEntry[]) {
    const previous = entries;
    setEntries(optimistic(previous));
    void cloudRequest("inbox/update", { method: "POST", body: input })
      .then(() => window.dispatchEvent(new Event(inboxChangedEvent)))
      .catch((reason: Error) => {
        setEntries(previous);
        toast(reason.message, "error");
      });
  }
  const unread = entries.filter((entry) => !entry.read).length;
  return (
    <>
      <header className="cloud-page-header">
        <h1>Inbox</h1>
        {unread > 0 && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              update({ kind: "read-all" }, (current) =>
                current.map((entry) => ({ ...entry, read: true })),
              )
            }
          >
            <CheckCheck />
            Mark all read
          </Button>
        )}
      </header>
      {!entries.length ? (
        <div className="cloud-empty">
          <InboxIcon aria-hidden="true" />
          <p>You’re all caught up.</p>
        </div>
      ) : (
        <ul className="cloud-inbox" aria-label="Notifications">
          {entries.map((entry) => (
            <li key={entry.id} data-unread={!entry.read || undefined}>
              {entry.kind === "task_finished" ? (
                <span className="cloud-icon-tile cloud-inbox-icon">
                  <Bot size={14} aria-hidden="true" />
                </span>
              ) : (
                <PersonAvatar name={entry.actor ?? "?"} />
              )}
              <Link
                className="cloud-inbox-body"
                href={entryHref(entry)}
                prefetch={false}
                onClick={() => {
                  if (!entry.read)
                    update(
                      { kind: "read", ids: [entry.id], read: true },
                      (current) =>
                        current.map((item) =>
                          item.id === entry.id ? { ...item, read: true } : item,
                        ),
                    );
                }}
              >
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
                  {entry.detail ? `: ${entry.detail}` : ""}
                </span>
              </Link>
              {entry.runState && <TaskState state={entry.runState} />}
              <span className="cloud-inbox-time">
                <Timestamp value={entry.createdAt} />
              </span>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Dismiss"
                onClick={() =>
                  update({ kind: "dismiss", ids: [entry.id] }, (current) =>
                    current.filter((item) => item.id !== entry.id),
                  )
                }
              >
                <X />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
