"use client";

import Link from "next/link";
import { GitPullRequest, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import { Field } from "@/components/field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { ReleaseHighlight } from "@/lib/cloud-release-contract";
import { createCommandSender, cloudRequest } from "./api-client";
import { MarkdownTextarea } from "./markdown-textarea";
import type { StudioContext } from "./release-studio";
import { useToast } from "./toast";

export function ReleaseOverview({ context }: { context: StudioContext }) {
  const { release, canWrite } = context;
  const toast = useToast();
  const sender = useRef(createCommandSender());
  const [draft, setDraft] = useState({
    version: release.version,
    name: release.name,
    targetDate: release.targetDate,
    summary: release.summary,
    notes: release.notes,
    highlights: release.highlights,
  });
  const [saving, setSaving] = useState(false);
  const dirty =
    JSON.stringify(draft) !==
    JSON.stringify({
      version: release.version,
      name: release.name,
      targetDate: release.targetDate,
      summary: release.summary,
      notes: release.notes,
      highlights: release.highlights,
    });
  const update = (patch: Partial<typeof draft>) =>
    setDraft((current) => ({ ...current, ...patch }));
  const setHighlight = (index: number, patch: Partial<ReleaseHighlight>) =>
    update({
      highlights: draft.highlights.map((entry, position) =>
        position === index ? { ...entry, ...patch } : entry,
      ),
    });
  async function run(action: () => Promise<unknown>, success?: string) {
    setSaving(true);
    try {
      await action();
      await context.refresh();
      if (success) toast(success);
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : "Try again.", "error");
    } finally {
      setSaving(false);
    }
  }
  const excluded = release.items
    .filter((item) => !item.included)
    .map((item) => item.issueId);
  return (
    <div className="cloud-release-overview">
      <section className="cloud-release-panel" aria-label="Release notes">
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Version" htmlFor="release-version-edit">
            <Input
              id="release-version-edit"
              value={draft.version}
              maxLength={40}
              disabled={!canWrite}
              onChange={(event) => update({ version: event.target.value })}
            />
          </Field>
          <Field label="Name" htmlFor="release-name-edit">
            <Input
              id="release-name-edit"
              value={draft.name}
              maxLength={120}
              disabled={!canWrite}
              onChange={(event) => update({ name: event.target.value })}
            />
          </Field>
          <Field label="Launch date" htmlFor="release-date-edit">
            <Input
              id="release-date-edit"
              type="date"
              value={draft.targetDate ?? ""}
              disabled={!canWrite}
              onChange={(event) =>
                update({ targetDate: event.target.value || null })
              }
            />
          </Field>
        </div>
        <Field label="Summary" htmlFor="release-summary">
          <Textarea
            id="release-summary"
            rows={2}
            maxLength={1_000}
            value={draft.summary}
            disabled={!canWrite}
            onChange={(event) => update({ summary: event.target.value })}
          />
        </Field>
        <Field label="Release notes" htmlFor="release-notes">
          <MarkdownTextarea
            id="release-notes"
            rows={12}
            maxLength={40_000}
            value={draft.notes}
            disabled={!canWrite}
            onChange={(event) => update({ notes: event.target.value })}
          />
        </Field>
        <div className="cloud-release-highlights">
          <div className="cloud-automation-template-heading">
            <h3>Highlights</h3>
            {canWrite && draft.highlights.length < 8 && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() =>
                  update({
                    highlights: [
                      ...draft.highlights,
                      { title: "", body: "", issueId: null },
                    ],
                  })
                }
              >
                <Plus />
                Add highlight
              </Button>
            )}
          </div>
          {draft.highlights.map((highlight, index) => (
            <div key={index} className="cloud-release-highlight">
              <span className="cloud-automation-step">{index + 1}</span>
              <div>
                <Input
                  aria-label={`Highlight ${index + 1}`}
                  value={highlight.title}
                  maxLength={120}
                  disabled={!canWrite}
                  onChange={(event) =>
                    setHighlight(index, { title: event.target.value })
                  }
                />
                <Textarea
                  aria-label={`Highlight ${index + 1} details`}
                  rows={2}
                  maxLength={600}
                  value={highlight.body}
                  disabled={!canWrite}
                  onChange={(event) =>
                    setHighlight(index, { body: event.target.value })
                  }
                />
              </div>
              {canWrite && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove highlight ${index + 1}`}
                  onClick={() =>
                    update({
                      highlights: draft.highlights.filter(
                        (_, position) => position !== index,
                      ),
                    })
                  }
                >
                  <Trash2 />
                </Button>
              )}
            </div>
          ))}
        </div>
        {canWrite && (
          <div className="cloud-release-actions">
            <Button
              disabled={
                !dirty ||
                saving ||
                draft.highlights.some((entry) => !entry.title.trim()) ||
                !draft.version.trim()
              }
              onClick={() =>
                void run(
                  () =>
                    sender.current(
                      `releases/${release.id}`,
                      { revision: release.revision, ...draft },
                      "PATCH",
                    ),
                  "Release saved",
                )
              }
            >
              Save
            </Button>
          </div>
        )}
      </section>
      <section className="cloud-release-panel" aria-label="Shipped work">
        <div className="cloud-automation-template-heading">
          <h3>Shipped work</h3>
          {canWrite && (
            <Button
              variant="ghost"
              size="sm"
              disabled={saving}
              onClick={() =>
                void run(() =>
                  cloudRequest(`releases/${release.id}/refresh`, {
                    method: "POST",
                  }),
                )
              }
            >
              <RefreshCw />
              Refresh
            </Button>
          )}
        </div>
        {release.items.length ? (
          <ul className="cloud-release-items">
            {release.items.map((item) => (
              <li key={item.issueId} data-included={item.included || undefined}>
                <label>
                  <input
                    type="checkbox"
                    checked={item.included}
                    disabled={!canWrite || saving}
                    onChange={() =>
                      void run(() =>
                        cloudRequest(`releases/${release.id}/items`, {
                          method: "POST",
                          body: {
                            revision: release.revision,
                            excludedIssueIds: item.included
                              ? [...excluded, item.issueId]
                              : excluded.filter((id) => id !== item.issueId),
                          },
                        }),
                      )
                    }
                  />
                  <Link href={`/cloud/issues/${item.identifier}`}>
                    {item.identifier}
                  </Link>
                  <span>{item.title}</span>
                </label>
                {item.pullRequests.map((pullRequest) => (
                  <a
                    key={pullRequest.url}
                    href={pullRequest.url}
                    target="_blank"
                    rel="noreferrer"
                    title={pullRequest.title}
                  >
                    <GitPullRequest size={13} aria-label="Pull request" />
                  </a>
                ))}
              </li>
            ))}
          </ul>
        ) : (
          <p className="cloud-automation-muted">
            No completed issues in this product's teams yet.
          </p>
        )}
      </section>
    </div>
  );
}
