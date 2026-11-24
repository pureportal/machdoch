"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import {
  maximumUpdateSummaryLength,
  projectHealthLabels,
  projectHealths,
  type CloudProjectUpdate,
  type ProjectHealth,
} from "@/lib/cloud-project-update-contract";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cloudRequest, createCommandSender } from "./api-client";
import { MarkdownTextarea } from "./markdown-textarea";
import { useToast } from "./toast";

export function ProjectUpdateDraft({ draft }: { draft: CloudProjectUpdate }) {
  const router = useRouter();
  const toast = useToast();
  const sender = useRef(createCommandSender());
  const [health, setHealth] = useState<ProjectHealth>(draft.health);
  const [summary, setSummary] = useState(draft.summary);
  const [body, setBody] = useState(draft.body);
  const [pending, setPending] = useState(false);
  function run(action: () => Promise<unknown>) {
    if (pending) return;
    setPending(true);
    void action()
      .then(() => router.refresh())
      .catch((reason: Error) => toast(reason.message, "error"))
      .finally(() => setPending(false));
  }
  return (
    <form
      className="cloud-project-update-form"
      aria-label="Draft update"
      onSubmit={(event) => {
        event.preventDefault();
        run(() =>
          sender.current(`project-updates/${draft.id}/publish`, {
            health,
            summary: summary.trim(),
            body: body.trim(),
          }),
        );
      }}
    >
      <div
        className="cloud-health-picker"
        role="radiogroup"
        aria-label="Health"
      >
        {projectHealths.map((entry) => (
          <button
            key={entry}
            type="button"
            role="radio"
            aria-checked={health === entry}
            data-health={entry}
            onClick={() => setHealth(entry)}
          >
            <span aria-hidden="true" />
            {projectHealthLabels[entry]}
          </button>
        ))}
      </div>
      <Input
        aria-label="Summary"
        value={summary}
        maxLength={maximumUpdateSummaryLength}
        onChange={(event) => setSummary(event.target.value)}
      />
      <MarkdownTextarea
        aria-label="Update"
        value={body}
        maxLength={20000}
        rows={4}
        onChange={(event) => setBody(event.target.value)}
      />
      <div className="cloud-editor-actions">
        <Button type="submit" size="sm" disabled={pending}>
          Post update
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={() =>
            run(() =>
              cloudRequest(`project-updates/${draft.id}`, { method: "DELETE" }),
            )
          }
        >
          Discard
        </Button>
      </div>
    </form>
  );
}
