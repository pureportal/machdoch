"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import {
  ArrowUpRight,
  CircleAlert,
  CircleCheck,
  GitMerge,
  LoaderCircle,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import type { RunDetail } from "@machdoch/fleet-protocol/cloud-execution";
import { taskOutcome, type OutcomeTone } from "@/lib/task-progress";
import { FormDialog } from "@/components/form-dialog";
import { Button } from "@/components/ui/button";
import { createCommandSender } from "./api-client";

const icons: Record<OutcomeTone, LucideIcon> = {
  success: CircleCheck,
  progress: LoaderCircle,
  attention: CircleAlert,
  danger: TriangleAlert,
};

export function TaskOutcome({
  run,
  canMerge,
  canPublish,
  onChanged,
}: {
  run: RunDetail;
  canMerge: boolean;
  canPublish: boolean;
  onChanged: () => Promise<void>;
}) {
  const outcome = taskOutcome(run);
  const Icon = icons[outcome.tone];
  const sender = useRef(createCommandSender());
  const [merging, setMerging] = useState(false);
  const [error, setError] = useState("");
  const delivery = run.delivery;
  return (
    <section
      className="cloud-task-outcome"
      data-tone={outcome.tone}
      aria-live="polite"
    >
      <Icon className="cloud-task-outcome-icon" size={20} aria-hidden="true" />
      <div className="cloud-task-outcome-text">
        <h2>{outcome.title}</h2>
        {outcome.detail && <p>{outcome.detail}</p>}
        {error && (
          <p role="alert" className="cloud-error">
            {error}
          </p>
        )}
      </div>
      <div className="cloud-task-outcome-actions">
        {delivery?.pullRequestId && (
          <Button variant="outline" asChild>
            <Link href={`/cloud/pull-requests/${delivery.pullRequestId}`}>
              Pull request #{delivery.pullRequestNumber}
            </Link>
          </Button>
        )}
        {delivery?.pullRequestUrl && (
          <Button variant="ghost" asChild>
            <a href={delivery.pullRequestUrl} target="_blank" rel="noreferrer">
              Open on{" "}
              {delivery.pullRequestUrl.includes("gitlab") ? "GitLab" : "GitHub"}
              <ArrowUpRight aria-hidden="true" />
            </a>
          </Button>
        )}
        {outcome.actions.includes("merge") && canMerge && (
          <Button
            onClick={() => {
              sender.current = createCommandSender();
              setMerging(true);
            }}
          >
            <GitMerge aria-hidden="true" />
            Merge
          </Button>
        )}
        {outcome.actions.includes("publish") && canPublish && (
          <Button
            onClick={() => {
              setError("");
              void sender
                .current(`runs/${run.id}/publish`, {})
                .then(onChanged)
                .catch((reason: unknown) =>
                  setError((reason as Error).message),
                );
            }}
          >
            Try again
          </Button>
        )}
      </div>
      <FormDialog
        open={merging}
        onOpenChange={setMerging}
        title="Merge this change"
        submitLabel="Merge"
        pendingLabel="Merging…"
        onSubmit={async () => {
          await sender.current(`runs/${run.id}/merge`, {});
          await onChanged();
        }}
      >
        <p>
          The pull request merges into {delivery?.baseBranch} as soon as its
          repository checks pass.
        </p>
      </FormDialog>
    </section>
  );
}
