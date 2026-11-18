"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import {
  Bot,
  CircleCheck,
  CircleDot,
  CircleX,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  MessageSquare,
  MessageSquareWarning,
  Zap,
} from "lucide-react";
import type {
  DeliveryEntry,
  DeliveryTaskPurpose,
  IssueDelivery,
} from "@/lib/cloud-issue-delivery";
import { formatAge } from "@/lib/format";
import { cloudRequest } from "./api-client";
import { CloudMarkdown } from "./cloud-markdown";

const pollMs = 15_000;
const lanes = 4;

const taskLabels: Record<DeliveryTaskPurpose, string> = {
  implement: "AI task",
  check: "Sandbox check",
  fix: "AI fix",
  resolve: "Conflict resolution",
};

const taskStates: Record<string, { label: string; tone: string }> = {
  queued: { label: "queued", tone: "pending" },
  preparing: { label: "preparing", tone: "active" },
  running: { label: "running", tone: "active" },
  waiting: { label: "waiting", tone: "active" },
  validating: { label: "checking", tone: "active" },
  publishing: { label: "publishing", tone: "active" },
  cancel_requested: { label: "stopping", tone: "pending" },
  reconciling: { label: "finishing", tone: "active" },
  succeeded: { label: "done", tone: "success" },
  failed: { label: "failed", tone: "danger" },
  canceled: { label: "canceled", tone: "muted" },
  timed_out: { label: "timed out", tone: "danger" },
};

const automationTones: Record<string, string> = {
  queued: "pending",
  running: "active",
  waiting: "active",
  succeeded: "success",
  failed: "danger",
  skipped: "muted",
};

interface Row {
  icon: ReactNode;
  tone: string;
  title: ReactNode;
  body?: string;
  href?: string;
  external?: boolean;
}

function row(entry: DeliveryEntry, reference: string): Row {
  switch (entry.kind) {
    case "task": {
      const state = taskStates[entry.state] ?? {
        label: entry.state,
        tone: "muted",
      };
      return {
        icon: <Bot size={13} aria-hidden="true" />,
        tone: state.tone,
        title: (
          <>
            {taskLabels[entry.purpose]} <em>{state.label}</em>
          </>
        ),
        href: `/cloud/tasks/${entry.runId}`,
      };
    }
    case "opened":
      return {
        icon: <GitPullRequest size={13} aria-hidden="true" />,
        tone: "success",
        title: `Opened ${reference}`,
      };
    case "merged":
      return {
        icon: <GitMerge size={13} aria-hidden="true" />,
        tone: "merged",
        title: `Merged ${reference}`,
      };
    case "closed":
      return {
        icon: <GitPullRequestClosed size={13} aria-hidden="true" />,
        tone: "muted",
        title: `Closed ${reference}`,
      };
    case "review":
      return {
        icon:
          entry.decision === "approved" ? (
            <CircleCheck size={13} aria-hidden="true" />
          ) : entry.decision === "changes_requested" ? (
            <CircleX size={13} aria-hidden="true" />
          ) : (
            <MessageSquareWarning size={13} aria-hidden="true" />
          ),
        tone:
          entry.decision === "approved"
            ? "success"
            : entry.decision === "changes_requested"
              ? "warning"
              : "muted",
        title: (
          <>
            {entry.automated && (
              <Bot size={12} aria-label="AI" className="cloud-delivery-ai" />
            )}
            {entry.author}{" "}
            {entry.decision === "approved"
              ? "approved"
              : entry.decision === "changes_requested"
                ? "requested changes"
                : "reviewed"}
          </>
        ),
        body: entry.body,
        href: entry.url ?? undefined,
        external: true,
      };
    case "comment":
      return {
        icon: <MessageSquare size={13} aria-hidden="true" />,
        tone: "muted",
        title: (
          <>
            {entry.automated && (
              <Bot size={12} aria-label="AI" className="cloud-delivery-ai" />
            )}
            {entry.author} commented
          </>
        ),
        body: entry.body,
        href: entry.url ?? undefined,
        external: true,
      };
    case "automation":
      return {
        icon: <Zap size={13} aria-hidden="true" />,
        tone: automationTones[entry.state] ?? "muted",
        title: entry.name,
        body: entry.detail,
        href: `/cloud/automations?automation=${entry.automationId}`,
      };
  }
}

function Title({
  value,
  href,
  external,
}: Pick<Row, "href" | "external"> & { value: ReactNode }) {
  if (!href) return <span className="cloud-delivery-title">{value}</span>;
  return external ? (
    <a
      className="cloud-delivery-title"
      href={href}
      target="_blank"
      rel="noreferrer"
    >
      {value}
    </a>
  ) : (
    <Link className="cloud-delivery-title" href={href} prefetch={false}>
      {value}
    </Link>
  );
}

export function IssueDeliveryTimeline({ issueId }: { issueId: string }) {
  const [delivery, setDelivery] = useState<IssueDelivery | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const abort = new AbortController();
    const load = () =>
      cloudRequest<IssueDelivery>(`issues/${issueId}/delivery`, {
        signal: abort.signal,
      })
        .then((value) => {
          setDelivery(value);
          setError("");
        })
        .catch((reason: Error) => {
          if (!abort.signal.aborted) setError(reason.message);
        });
    void load();
    const timer = setInterval(() => {
      if (!document.hidden) void load();
    }, pollMs);
    return () => {
      abort.abort();
      clearInterval(timer);
    };
  }, [issueId]);
  if (!delivery?.entries.length && !error) return null;
  const lane = new Map(
    delivery?.pullRequests.map((pullRequest, index) => [
      pullRequest.id,
      { pullRequest, index: index % lanes },
    ]),
  );
  return (
    <section className="cloud-aside-section" aria-label="Delivery">
      <header>
        <h2>Delivery</h2>
      </header>
      {error && (
        <p role="alert" className="cloud-aside-changes-note">
          {error}
        </p>
      )}
      {delivery && (
        <ol className="cloud-delivery-graph">
          {delivery.entries.map((entry) => {
            const owner = entry.pullRequestId
              ? lane.get(entry.pullRequestId)
              : undefined;
            const reference = owner
              ? `#${owner.pullRequest.number}`
              : "pull request";
            const shown = row(entry, reference);
            return (
              <li key={entry.id} data-tone={shown.tone}>
                <span className="cloud-delivery-node">{shown.icon}</span>
                <div className="cloud-delivery-content">
                  <Title
                    value={shown.title}
                    href={shown.href}
                    external={shown.external}
                  />
                  {shown.body && (
                    <CloudMarkdown
                      className="cloud-delivery-body"
                      content={shown.body}
                    />
                  )}
                  <span className="cloud-delivery-meta">
                    <time
                      dateTime={entry.at}
                      title={new Date(entry.at).toLocaleString()}
                    >
                      {formatAge(entry.at)}
                    </time>
                    {owner && (
                      <Link
                        className="cloud-delivery-lane"
                        data-lane={owner.index}
                        href={`/cloud/pull-requests/${owner.pullRequest.id}`}
                        prefetch={false}
                        title={owner.pullRequest.title}
                      >
                        <CircleDot size={10} aria-hidden="true" />
                        {owner.pullRequest.repository.split("/").at(-1)}#
                        {owner.pullRequest.number}
                      </Link>
                    )}
                  </span>
                </div>
              </li>
            );
          })}
        </ol>
      )}
      {delivery?.unavailable.length ? (
        <p className="cloud-aside-changes-note">
          Reviews from {delivery.unavailable.join(", ")} could not be loaded.
        </p>
      ) : null}
    </section>
  );
}
