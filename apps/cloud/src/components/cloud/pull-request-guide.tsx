"use client";

import { pollWhileVisible } from "@machdoch/product-ui/view-visibility";
import { LoadingState } from "@machdoch/product-ui";
import { LoaderCircle, Sparkles } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  GitReviewGuide,
  GitReviewGuideState,
} from "@/lib/cloud-git-contract";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { cloudRequest, createCommandSender } from "./api-client";
import { parseAgentModelValue, useAgentModels } from "./use-agent-models";

const pollMs = 3_000;

export interface ReviewGuideHandle {
  state: GitReviewGuideState | null;
  error: string;
  replace: (guide: GitReviewGuide) => void;
}

export function useReviewGuide(
  pullRequestId: string,
  headSha: string,
): ReviewGuideHandle {
  const [state, setState] = useState<GitReviewGuideState | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(
    (signal?: AbortSignal) =>
      cloudRequest<GitReviewGuideState>(
        `pull-requests/${pullRequestId}/guide`,
        {
          signal,
        },
      )
        .then((value) => {
          if (signal?.aborted) return;
          setState(value);
          setError("");
        })
        .catch((reason: Error) => {
          if (!signal?.aborted) setError(reason.message);
        }),
    [pullRequestId],
  );
  useEffect(() => {
    const abort = new AbortController();
    void load(abort.signal);
    return () => abort.abort();
  }, [load, headSha]);
  const waiting = state?.guide?.state === "waiting";
  useEffect(() => {
    if (!waiting) return;
    return pollWhileVisible(() => load(), pollMs, { immediate: false });
  }, [waiting, load]);
  const replace = useCallback(
    (guide: GitReviewGuide) =>
      setState((current) => ({ enabled: current?.enabled ?? true, guide })),
    [],
  );
  return { state, error, replace };
}

function GuideRequest({
  pullRequestId,
  failure,
  onStarted,
}: {
  pullRequestId: string;
  failure: string | null;
  onStarted: (guide: GitReviewGuide) => void;
}) {
  const models = useAgentModels(true);
  const sender = useRef(createCommandSender());
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  if (models.loaded && !models.choices.length)
    return (
      <p className="cloud-pull-request-muted">
        {models.error || "Add an AI provider to generate a walkthrough."}
      </p>
    );
  return (
    <form
      className="cloud-review-guide-request"
      onSubmit={(event) => {
        event.preventDefault();
        const choice = parseAgentModelValue(
          String(new FormData(event.currentTarget).get("model") ?? ""),
        );
        if (!choice) return;
        setPending(true);
        setError("");
        sender
          .current<GitReviewGuide>(
            `pull-requests/${pullRequestId}/guide`,
            choice,
          )
          .then((guide) => {
            sender.current = createCommandSender();
            onStarted(guide);
          })
          .catch((reason: Error) => setError(reason.message))
          .finally(() => setPending(false));
      }}
    >
      {(error || failure) && (
        <p role="alert" className="cloud-error">
          {error || failure}
        </p>
      )}
      <Select
        aria-label="Model"
        name="model"
        key={models.preferred}
        defaultValue={models.preferred}
        disabled={!models.loaded || pending}
      >
        {models.choices.map((choice) => (
          <option key={choice.value} value={choice.value}>
            {choice.label}
          </option>
        ))}
      </Select>
      <Button type="submit" size="sm" disabled={!models.loaded || pending}>
        <Sparkles aria-hidden="true" />
        Generate walkthrough
      </Button>
    </form>
  );
}

export function PullRequestGuide({
  pullRequestId,
  handle,
}: {
  pullRequestId: string;
  handle: ReviewGuideHandle;
}) {
  const { state, error, replace } = handle;
  if (error)
    return (
      <p role="alert" className="cloud-error">
        {error}
      </p>
    );
  if (!state) return <LoadingState label="Loading walkthrough…" />;
  const guide = state.guide;
  if (guide?.state === "waiting")
    return (
      <p className="cloud-review-guide-writing" role="status">
        <LoaderCircle size={14} aria-hidden="true" />
        Writing walkthrough…
      </p>
    );
  if (guide?.state === "ready")
    return (
      <ol className="cloud-review-guide">
        {guide.sections.map((section) => (
          <li key={section.title}>
            <h3>{section.title}</h3>
            <p>{section.purpose}</p>
            <p>
              <strong>Impact</strong> {section.impact}
            </p>
            {section.files.length > 0 && (
              <ul aria-label="Files">
                {section.files.map((file) => (
                  <li key={file}>
                    <code>{file}</code>
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ol>
    );
  return (
    <GuideRequest
      pullRequestId={pullRequestId}
      failure={guide?.error ?? null}
      onStarted={replace}
    />
  );
}
