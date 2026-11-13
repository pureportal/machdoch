"use client";

import { holderCan } from "@/lib/cloud-permissions";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { startTransition, useEffect, useState } from "react";
import { ArrowUpRight, CircleDotDashed } from "lucide-react";
import { MarkdownContent } from "@machdoch/client-ui/conversation/markdown-content";
import type { CloudWorkspace } from "@/lib/cloud-contract";
import type { TriageIssue, TriageResult } from "@/lib/cloud-triage-contract";
import { Button } from "@/components/ui/button";
import { useAgentPageEntity } from "./agent/agent-shell";
import { triageChangedEvent } from "./events";
import { issueNavigationKey } from "./issue-header";
import {
  AssigneeCell,
  EstimateCell,
  PriorityCell,
  type ApplyChange,
} from "./issue-cells";
import { PersonAvatar } from "./person-avatar";
import { RelativeTime } from "./relative-time";
import { useToast } from "./toast";
import { TriageActions } from "./triage-actions";
import { useIssueList } from "./use-issue-list";

export function Triage({
  initial,
  workspace,
  teamId,
}: {
  initial: TriageIssue[];
  workspace: CloudWorkspace;
  teamId: string | null;
}) {
  const router = useRouter();
  const toast = useToast();
  const writable = holderCan(workspace.actor, "issues.edit");
  const { issues, apply } = useIssueList(initial, workspace, teamId ?? "");
  const applyChange: ApplyChange = (targets, changes) =>
    apply(
      issues.filter((issue) =>
        targets.some((target) => target.id === issue.id),
      ),
      changes,
    );
  const [settled, setSettled] = useState<ReadonlySet<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const visible = issues.filter(
    (issue) => issue.state === "triage" && !settled.has(issue.id),
  );
  const selected =
    visible.find((issue) => issue.id === selectedId) ?? visible[0] ?? null;
  const team = workspace.teams.find((entry) => entry.id === teamId);
  useAgentPageEntity(
    selected
      ? {
          kind: "issue",
          id: selected.id,
          label: selected.identifier,
          title: selected.title,
        }
      : null,
  );
  const decided = (result: TriageResult, message: string) => {
    const index = visible.findIndex((issue) => issue.id === result.id);
    const next = visible[index + 1] ?? visible[index - 1];
    setSettled((current) => new Set(current).add(result.id));
    setSelectedId(next?.id ?? null);
    toast(message);
    window.dispatchEvent(new Event(triageChangedEvent));
    startTransition(() => router.refresh());
  };
  const order = visible.map((issue) => issue.id).join(",");
  useEffect(() => {
    sessionStorage.setItem(
      issueNavigationKey,
      JSON.stringify({
        ids: order ? order.split(",") : [],
        href: `${location.pathname}${location.search}`,
      }),
    );
  }, [order]);
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
      const index = visible.findIndex((issue) => issue.id === selected?.id);
      const step =
        event.key === "j" || event.key === "ArrowDown"
          ? 1
          : event.key === "k" || event.key === "ArrowUp"
            ? -1
            : 0;
      const next = step ? visible[index + step] : undefined;
      if (!next) return;
      event.preventDefault();
      setSelectedId(next.id);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [visible, selected]);
  return (
    <div className="cloud-inbox-layout">
      <section className="cloud-inbox-pane" aria-label="Issues in triage">
        <header className="cloud-inbox-header cloud-triage-header">
          <h1>Triage</h1>
          {team && <span>{team.name}</span>}
          <span className="cloud-triage-count">{visible.length}</span>
        </header>
        {!visible.length ? (
          <div className="cloud-inbox-empty">
            <CircleDotDashed aria-hidden="true" />
            <p>Nothing to triage.</p>
          </div>
        ) : (
          <ul className="cloud-inbox-list">
            {visible.map((issue) => (
              <li
                key={issue.id}
                aria-current={issue.id === selected?.id || undefined}
              >
                <button
                  type="button"
                  className="cloud-inbox-entry"
                  onClick={() => setSelectedId(issue.id)}
                >
                  <PersonAvatar name={issue.creator ?? "?"} />
                  <span className="cloud-inbox-body">
                    <span className="cloud-inbox-title">
                      <span className="cloud-issue-key">
                        {issue.identifier}
                      </span>
                      <span>{issue.title}</span>
                    </span>
                    <span className="cloud-inbox-detail">
                      {issue.creator ?? "Unknown"}
                    </span>
                  </span>
                  <span className="cloud-inbox-meta">
                    <RelativeTime value={issue.createdAt} compact />
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="cloud-inbox-detail-pane" aria-label="Issue">
        {selected ? (
          <article className="cloud-inbox-preview">
            <header>
              <span className="cloud-issue-key">{selected.identifier}</span>
              <Button asChild variant="ghost" size="sm">
                <Link href={`/cloud/issues/${selected.id}`} prefetch={false}>
                  Open
                  <ArrowUpRight />
                </Link>
              </Button>
            </header>
            <h2>{selected.title}</h2>
            <p className="cloud-inbox-preview-event">
              <PersonAvatar
                name={selected.creator ?? "?"}
                className="cloud-avatar-tiny"
              />
              {selected.creator ?? "Unknown"} reported this
              <RelativeTime value={selected.createdAt} />
            </p>
            {writable && (
              <TriageActions
                key={selected.id}
                issue={selected}
                workspace={workspace}
                onDecided={decided}
              />
            )}
            <div className="cloud-triage-properties">
              <PriorityCell
                issue={selected}
                writable={writable}
                apply={applyChange}
              />
              <AssigneeCell
                issue={selected}
                workspace={workspace}
                writable={writable}
                apply={applyChange}
              />
              <EstimateCell
                issue={selected}
                workspace={workspace}
                writable={writable}
                apply={applyChange}
              />
              {selected.labels.map((label) => (
                <span
                  key={label.id}
                  className="cloud-issue-label"
                  data-label-color={label.color}
                >
                  {label.name}
                </span>
              ))}
            </div>
            {selected.description && (
              <MarkdownContent
                className="cloud-inbox-preview-description"
                content={selected.description}
              />
            )}
          </article>
        ) : (
          <div className="cloud-inbox-placeholder">
            <CircleDotDashed aria-hidden="true" />
          </div>
        )}
      </section>
    </div>
  );
}
