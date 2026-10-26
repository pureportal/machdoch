"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import type { CloudIssue, CloudWorkspace } from "@/lib/cloud-contract";
import {
  relationKinds,
  type CloudIssueRelation,
} from "@/lib/cloud-relation-contract";
import { Button } from "@/components/ui/button";
import { FormDialog } from "@/components/form-dialog";
import {
  CloudRequestError,
  cloudRequest,
  createCommandSender,
} from "./api-client";
import { CreateIssue } from "./issue-form";
import { LinkIssueDialog } from "./link-issue-dialog";

const names = {
  parent: "Parent",
  child: "Sub-issues",
  blocks: "Blocks",
  blocked_by: "Blocked by",
  related: "Related",
};

export function IssueRelations({
  issue,
  workspace,
  writable,
}: {
  issue: CloudIssue;
  workspace: CloudWorkspace;
  writable: boolean;
}) {
  const [relations, setRelations] = useState<CloudIssueRelation[]>([]);
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<CloudIssueRelation | null>(null);
  const [expanded, setExpanded] = useState<string[]>([]);
  const sender = useRef(createCommandSender());
  const sequence = useRef(0);
  const heading = useRef<HTMLHeadingElement>(null);
  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      const serial = ++sequence.current;
      const result = await cloudRequest<{ relations: CloudIssueRelation[] }>(
        `issues/${issue.id}/relations`,
        { signal },
      );
      if (serial === sequence.current && !signal?.aborted) {
        setRelations(result.relations);
        setError("");
      }
    },
    [issue.id],
  );
  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        if (!document.hidden) await refresh(abort.signal);
      } catch (reason) {
        if (abort.signal.aborted) return;
        if (
          reason instanceof CloudRequestError &&
          [401, 403, 404].includes(reason.status)
        ) {
          setRelations([]);
          setAdding(false);
          setRemoving(null);
        }
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
  }, [refresh]);
  return (
    <section className="cloud-card mt-6" aria-label="Issue relationships">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 ref={heading} tabIndex={-1}>
          Relationships
        </h2>
        {writable && !issue.archived && (
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => setAdding(true)}>
              Link issue
            </Button>
            <CreateIssue
              workspace={workspace}
              teamId={issue.teamId}
              projectId={issue.projectId ?? undefined}
              parent={issue}
              onCreated={refresh}
            />
          </div>
        )}
      </div>
      {relationKinds.map((kind) => {
        const group = relations.filter((relation) => relation.kind === kind);
        if (!group.length) return null;
        return (
          <div
            key={kind}
            className="mt-4"
            role="group"
            aria-label={names[kind]}
          >
            <h3 className="mb-2 text-sm text-muted-foreground">
              {names[kind]}
            </h3>
            <ul className="grid gap-1">
              {(expanded.includes(kind) ? group : group.slice(0, 10)).map(
                (relation) => (
                  <li
                    key={relation.id}
                    className="flex min-w-0 items-center gap-2 rounded-md border px-3 py-2"
                  >
                    <Link
                      className="min-w-0 flex-1 break-words hover:underline"
                      href={`/cloud/issues/${relation.issue.id}`}
                    >
                      <span className="text-muted-foreground">
                        {relation.issue.identifier}
                      </span>{" "}
                      {relation.issue.title}
                    </Link>
                    <span className="text-sm text-muted-foreground">
                      {relation.issue.archived
                        ? "Archived"
                        : relation.issue.statusName}
                    </span>
                    {writable && (
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Remove link to ${relation.issue.identifier}`}
                        onClick={() => {
                          sender.current = createCommandSender();
                          setRemoving(relation);
                        }}
                      >
                        <X />
                      </Button>
                    )}
                  </li>
                ),
              )}
            </ul>
            {group.length > 10 && (
              <Button
                variant="ghost"
                onClick={() =>
                  setExpanded(
                    expanded.includes(kind)
                      ? expanded.filter((entry) => entry !== kind)
                      : [...expanded, kind],
                  )
                }
              >
                {expanded.includes(kind)
                  ? "Show fewer"
                  : `Show all ${group.length}`}
              </Button>
            )}
          </div>
        );
      })}
      {error && (
        <p role="alert" className="cloud-error">
          {error}
        </p>
      )}
      <LinkIssueDialog
        issue={issue}
        open={adding}
        onOpenChange={setAdding}
        onSaved={refresh}
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
          await refresh();
        }}
      >
        <p>
          {removing?.issue.identifier} · {removing?.issue.title}
        </p>
      </FormDialog>
    </section>
  );
}
