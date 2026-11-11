"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import type { CloudIssue } from "@/lib/cloud-contract";
import type { CloudIssueRelation } from "@/lib/cloud-relation-contract";
import { Button } from "@/components/ui/button";
import { FormDialog } from "@/components/form-dialog";
import {
  CloudRequestError,
  cloudRequest,
  createCommandSender,
} from "./api-client";
import { LinkIssueDialog } from "./link-issue-dialog";

export interface IssueRelationsState {
  relations: CloudIssueRelation[];
  error: string;
  refresh: () => Promise<void>;
}

export function useIssueRelations(issueId: string): IssueRelationsState {
  const [relations, setRelations] = useState<CloudIssueRelation[]>([]);
  const [error, setError] = useState("");
  const sequence = useRef(0);
  const load = useCallback(
    async (signal?: AbortSignal) => {
      const serial = ++sequence.current;
      const result = await cloudRequest<{ relations: CloudIssueRelation[] }>(
        `issues/${issueId}/relations`,
        { signal },
      );
      if (serial === sequence.current && !signal?.aborted) {
        setRelations(result.relations);
        setError("");
      }
    },
    [issueId],
  );
  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        if (!document.hidden) await load(abort.signal);
      } catch (reason) {
        if (abort.signal.aborted) return;
        if (
          reason instanceof CloudRequestError &&
          [401, 403, 404].includes(reason.status)
        )
          setRelations([]);
        setError((reason as Error).message);
      }
      if (!abort.signal.aborted) timer = setTimeout(() => void poll(), 5000);
    }
    void poll();
    return () => {
      abort.abort();
      clearTimeout(timer);
      sequence.current++;
    };
  }, [load]);
  return { relations, error, refresh: () => load() };
}

export function IssueSubIssues({
  issue,
  writable,
  state,
}: {
  issue: CloudIssue;
  writable: boolean;
  state: IssueRelationsState;
}) {
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const sender = useRef(createCommandSender());
  const children = state.relations.filter(
    (relation) => relation.kind === "child",
  );
  const completed = children.filter((relation) =>
    ["complete", "canceled"].includes(relation.issue.state),
  ).length;
  if (!children.length && (!writable || issue.archived)) return null;
  return (
    <section className="cloud-sub-issues" aria-labelledby="sub-issues-heading">
      {children.length > 0 && (
        <header>
          <h2 id="sub-issues-heading">Sub-issues</h2>
          <span className="cloud-sub-issues-progress">
            {completed}/{children.length}
          </span>
        </header>
      )}
      {children.length > 0 && (
        <ul>
          {children.map((relation) => (
            <li key={relation.id}>
              <span
                className="cloud-state"
                data-state={relation.issue.state}
                aria-label={relation.issue.statusName}
              />
              <Link href={`/cloud/issues/${relation.issue.id}`}>
                <span className="cloud-issue-key">
                  {relation.issue.identifier}
                </span>
                <span>{relation.issue.title}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {writable &&
        !issue.archived &&
        (adding ? (
          <form
            className="cloud-sub-issue-form"
            onSubmit={(event) => {
              event.preventDefault();
              const value = title.trim();
              if (!value || pending) return;
              setPending(true);
              setError("");
              void sender
                .current(`issues/${issue.id}/children`, {
                  parentRevision: issue.revision,
                  issue: {
                    teamId: issue.teamId,
                    title: value,
                    projectId: issue.projectId,
                    cycleId: issue.cycleId,
                  },
                })
                .then(async () => {
                  sender.current = createCommandSender();
                  setTitle("");
                  await state.refresh();
                })
                .catch((reason: Error) => setError(reason.message))
                .finally(() => setPending(false));
            }}
          >
            <input
              autoFocus
              aria-label="Sub-issue title"
              placeholder="Sub-issue title"
              value={title}
              maxLength={300}
              disabled={pending}
              onChange={(event) => setTitle(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") setAdding(false);
              }}
            />
            <Button type="submit" size="sm" disabled={pending || !title.trim()}>
              Create
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setAdding(false)}
            >
              Cancel
            </Button>
          </form>
        ) : (
          <button
            type="button"
            className="cloud-inline-add"
            onClick={() => setAdding(true)}
          >
            <Plus size={13} aria-hidden="true" />
            Add sub-issues
          </button>
        ))}
      {(error || state.error) && (
        <p role="alert" className="cloud-error">
          {error || state.error}
        </p>
      )}
    </section>
  );
}

const sidebarGroups = [
  ["parent", "Parent"],
  ["blocked_by", "Blocked by"],
  ["blocks", "Blocking"],
  ["related", "Related"],
  ["duplicate_of", "Duplicate of"],
  ["duplicated_by", "Duplicates"],
] as const;

export function IssueRelationSidebar({
  issue,
  writable,
  state,
}: {
  issue: CloudIssue;
  writable: boolean;
  state: IssueRelationsState;
}) {
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<CloudIssueRelation | null>(null);
  const sender = useRef(createCommandSender());
  const heading = useRef<HTMLHeadingElement>(null);
  const groups = sidebarGroups
    .map(([kind, label]) => ({
      kind,
      label,
      relations: state.relations.filter((relation) => relation.kind === kind),
    }))
    .filter((group) => group.relations.length);
  return (
    <section className="cloud-aside-section" aria-label="Relations">
      <header>
        <h2 ref={heading} tabIndex={-1}>
          Relations
        </h2>
        {writable && !issue.archived && (
          <button
            type="button"
            className="cloud-aside-add"
            aria-label="Link issue"
            onClick={() => setAdding(true)}
          >
            <Plus size={13} />
          </button>
        )}
      </header>
      {groups.map((group) => (
        <div
          key={group.kind}
          className="cloud-aside-relations"
          role="group"
          aria-label={group.label}
        >
          <h3>{group.label}</h3>
          <ul>
            {group.relations.map((relation) => (
              <li key={relation.id}>
                <span
                  className="cloud-state"
                  data-state={relation.issue.state}
                  aria-label={relation.issue.statusName}
                />
                <Link href={`/cloud/issues/${relation.issue.id}`}>
                  <span className="cloud-issue-key">
                    {relation.issue.identifier}
                  </span>{" "}
                  {relation.issue.title}
                </Link>
                {writable && (
                  <button
                    type="button"
                    aria-label={`Remove link to ${relation.issue.identifier}`}
                    onClick={() => {
                      sender.current = createCommandSender();
                      setRemoving(relation);
                    }}
                  >
                    <X size={12} />
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
      <LinkIssueDialog
        issue={issue}
        open={adding}
        onOpenChange={setAdding}
        onSaved={state.refresh}
      />
      <FormDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
        title="Remove link"
        submitLabel="Remove link"
        focusWhenOpenerRemoved={heading}
        onSubmit={async () => {
          if (!removing) return;
          await sender.current(
            `issues/${issue.id}/relations/${removing.id}/remove`,
            {},
          );
          await state.refresh();
        }}
      >
        <p>
          {removing?.issue.identifier} · {removing?.issue.title}
        </p>
      </FormDialog>
    </section>
  );
}
