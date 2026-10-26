"use client";

import { useEffect, useRef, useState } from "react";
import type { CloudIssue } from "@/lib/cloud-contract";
import { Field } from "@/components/field";
import { FormDialog } from "@/components/form-dialog";
import { Select } from "@/components/ui/select";
import {
  CloudRequestError,
  cloudRequest,
  createCommandSender,
  formText,
} from "./api-client";
import { RelationPicker } from "./relation-picker";

export function LinkIssueDialog({
  issue,
  open,
  onOpenChange,
  onSaved,
}: {
  issue: CloudIssue;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => Promise<void>;
}) {
  const [selected, setSelected] = useState<CloudIssue | null>(null);
  const [review, setReview] = useState<[CloudIssue, CloudIssue] | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const sender = useRef(createCommandSender());
  useEffect(() => {
    if (!open) {
      setSelected(null);
      setReview(null);
      setReviewed(false);
      sender.current = createCommandSender();
    }
  }, [open]);
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Link issue"
      submitLabel="Add link"
      submitDisabled={!selected || (!!review && !reviewed)}
      onSubmit={async (form) => {
        if (!selected) return;
        const source = review?.[0] ?? issue;
        const target = review?.[1] ?? selected;
        try {
          await sender.current(`issues/${issue.id}/relations`, {
            kind: formText(form, "kind"),
            targetId: target.id,
            sourceRevision: source.revision,
            targetRevision: target.revision,
          });
        } catch (reason) {
          if (
            reason instanceof CloudRequestError &&
            reason.code === "revision_conflict"
          ) {
            const latest = await Promise.all([
              cloudRequest<CloudIssue>(`issues/${issue.id}`),
              cloudRequest<CloudIssue>(`issues/${target.id}`),
            ]);
            setReview(latest);
            setReviewed(false);
            throw new Error(
              "An issue changed. Review the latest versions before adding the link.",
            );
          }
          throw reason;
        }
        await onSaved();
      }}
    >
      <Field label="Relationship" htmlFor="issue-relation-kind">
        <Select id="issue-relation-kind" name="kind" defaultValue="related">
          <option value="related">Related to</option>
          <option value="parent">Parent</option>
          <option value="child">Sub-issue</option>
          <option value="blocks">Blocks</option>
          <option value="blocked_by">Blocked by</option>
        </Select>
      </Field>
      {open && (
        <RelationPicker
          issueId={issue.id}
          selected={selected}
          onSelect={(next) => {
            setSelected(next);
            setReview(null);
            setReviewed(false);
          }}
        />
      )}
      {review && (
        <section
          aria-label="Latest issue versions"
          className="grid gap-3 rounded-md border p-3"
        >
          {review.map((current) => (
            <details key={current.id} open>
              <summary className="break-words">
                {current.identifier} · {current.title}
              </summary>
              <p className="text-sm text-muted-foreground">
                {current.archived ? "Archived" : current.statusName}
              </p>
              {current.description && (
                <p className="whitespace-pre-wrap break-words">
                  {current.description}
                </p>
              )}
              {current.acceptanceCriteria && (
                <div>
                  <h3>Acceptance criteria</h3>
                  <p className="whitespace-pre-wrap break-words">
                    {current.acceptanceCriteria}
                  </p>
                </div>
              )}
            </details>
          ))}
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={reviewed}
              onChange={(event) => setReviewed(event.target.checked)}
            />
            Use these versions
          </label>
        </section>
      )}
    </FormDialog>
  );
}
