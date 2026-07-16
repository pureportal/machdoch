import {
  Ban,
  Clock3,
  CloudCog,
  Cpu,
  FileImage,
  FileClock,
  Images,
  ListTree,
  LoaderCircle,
  MessageSquareText,
  Plus,
  RadioTower,
  RotateCw,
  ShieldAlert,
  Workflow,
} from "lucide-react";
import { useEffect, useState, type JSX } from "react";
import type {
  MediaAssetRecord,
  MediaHumanReviewDecisionRequest,
  MediaRunDetail,
  MediaRunRecord,
  MediaProviderReviewAction,
  MediaRuntimeRunRecord,
  MediaRuntimeStatus,
} from "../../../../core/media/contracts.js";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { cn } from "../../lib/utils";
import { readMediaAssetReferencePreview } from "../media-runtime";

interface MediaRunsViewProps {
  runs: readonly MediaRunRecord[];
  selectedRun: MediaRunDetail | null;
  runtimeStatus: MediaRuntimeStatus | null;
  runtimeError: string | null;
  onCreate: () => void;
  onSelect: (runId: string) => void;
  onCancel: (runId: string) => void;
  onRetry: (runId: string) => void;
  onResolveProviderReview: (
    providerJobId: string,
    action: MediaProviderReviewAction,
  ) => void;
  providerReviewPending: boolean;
  onResolveHumanReview: (request: MediaHumanReviewDecisionRequest) => void;
  humanReviewPending: boolean;
  onInspectInFlow: (run: MediaRunDetail) => void;
  onRefresh: () => void;
}

const STATUS_STYLES: Record<MediaRunRecord["status"], string> = {
  draft: "border-slate-600/50 text-slate-400",
  blocked: "border-rose-400/30 text-rose-300",
  ready: "border-emerald-400/30 text-emerald-300",
  queued: "border-amber-400/30 text-amber-300",
  running: "border-cyan-400/30 text-cyan-300",
  "needs-review": "border-violet-400/40 text-violet-200",
  "waiting-for-review": "border-fuchsia-400/40 text-fuchsia-200",
  canceling: "border-orange-400/30 text-orange-300",
  completed: "border-lime-400/30 text-lime-300",
  failed: "border-rose-400/30 text-rose-300",
  canceled: "border-slate-500/50 text-slate-400",
};

const isRuntimeRun = (run: MediaRunRecord): run is MediaRuntimeRunRecord => {
  return "executor" in run;
};

const formatCreatedAt = (createdAt: string): string => {
  const timestamp = Date.parse(createdAt);
  return Number.isNaN(timestamp)
    ? createdAt
    : new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(timestamp);
};

const formatEventTime = (createdAt: string): string => {
  const timestamp = Date.parse(createdAt);
  return Number.isNaN(timestamp)
    ? createdAt
    : new Intl.DateTimeFormat(undefined, { timeStyle: "medium" }).format(
        timestamp,
      );
};

const createReviewDecisionId = (): string => {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `media-review-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2)}`;
};

const ReviewAssetPreview = ({
  asset,
}: {
  asset: MediaAssetRecord;
}): JSX.Element => {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const assetId = asset.id;

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    setUrl(null);
    setFailed(false);
    void readMediaAssetReferencePreview(assetId, 384)
      .then((blob) => {
        if (cancelled || typeof URL.createObjectURL !== "function") return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [assetId]);

  if (url) {
    return (
      <img
        src={url}
        alt={`Candidate ${asset.outputIndex + 1}, ${asset.width} by ${asset.height}`}
        className="h-full w-full object-cover"
      />
    );
  }
  return (
    <span className="flex h-full items-center justify-center">
      {failed ? (
        <FileImage className="h-6 w-6 text-rose-300/60" />
      ) : (
        <LoaderCircle className="h-5 w-5 animate-spin text-slate-600" />
      )}
    </span>
  );
};

const RunInspector = ({
  run,
  onCancel,
  onRetry,
  onResolveProviderReview,
  providerReviewPending,
  onResolveHumanReview,
  humanReviewPending,
  onInspectInFlow,
}: {
  run: MediaRunDetail;
  onCancel: (runId: string) => void;
  onRetry: (runId: string) => void;
  onResolveProviderReview: MediaRunsViewProps["onResolveProviderReview"];
  providerReviewPending: boolean;
  onResolveHumanReview: MediaRunsViewProps["onResolveHumanReview"];
  humanReviewPending: boolean;
  onInspectInFlow: MediaRunsViewProps["onInspectInFlow"];
}): JSX.Element => {
  const pendingReview = run.humanReviews.find(
    (review) => review.status === "pending",
  );
  const [selectedAssetIds, setSelectedAssetIds] = useState<string[]>([]);
  const [comment, setComment] = useState("");
  const [decisionId, setDecisionId] = useState(createReviewDecisionId);
  const [rejectArmed, setRejectArmed] = useState(false);
  useEffect(() => {
    setSelectedAssetIds([]);
    setComment("");
    setDecisionId(createReviewDecisionId());
    setRejectArmed(false);
  }, [pendingReview?.id, run.id]);
  const canCancel =
    run.executor !== "openai-image-api" &&
    ["queued", "running", "waiting-for-review"].includes(run.status);
  const canRetry =
    run.executor === "deterministic-fixture" &&
    ["failed", "canceled"].includes(run.status) &&
    run.humanReviews.length === 0;
  const providerJob = run.providerJobs.at(-1);
  const planSnapshot = run.planSnapshot;
  const executorLabel =
    run.executor === "deterministic-fixture"
      ? "Fixture"
      : run.executor === "openai-image-api"
        ? "OpenAI image generation"
      : run.executor === "mock-remote-provider"
        ? "Remote adapter"
        : run.executor === "local-transform"
          ? "Local transform"
          : run.executor === "local-analysis"
            ? "Local analysis"
            : "Local import";
  const reviewAssets = pendingReview
    ? pendingReview.candidateAssetIds
        .map((assetId) => run.assets.find((asset) => asset.id === assetId))
        .filter((asset): asset is MediaAssetRecord => Boolean(asset))
    : [];
  const decidedReview = [...run.humanReviews].reverse().find(
    (review) => review.status === "approved" || review.status === "rejected",
  );
  const outputStat = pendingReview
    ? { label: "Candidates", value: `${pendingReview.candidateAssetIds.length} ready` }
    : decidedReview
      ? decidedReview.status === "rejected"
        ? { label: "Outcome", value: "Rejected" }
        : {
            label: "Approved",
            value: `${decidedReview.selectedAssetIds.length} selected`,
          }
      : { label: "Published", value: `${run.assets.length} / ${run.outputCount}` };
  const reviewCommentValid =
    !pendingReview?.requireComment || comment.trim().length > 0;
  const toggleReviewAsset = (assetId: string): void => {
    setRejectArmed(false);
    setSelectedAssetIds((current) => {
      if (current.includes(assetId)) {
        return current.filter((candidate) => candidate !== assetId);
      }
      if (!pendingReview || current.length >= pendingReview.maxSelections) {
        return pendingReview?.maxSelections === 1 ? [assetId] : current;
      }
      return [...current, assetId];
    });
  };
  const submitHumanReview = (action: "approve" | "reject"): void => {
    if (!pendingReview) return;
    onResolveHumanReview({
      reviewId: pendingReview.id,
      decisionId,
      action,
      selectedAssetIds: action === "approve" ? selectedAssetIds : [],
      comment,
    });
  };
  return (
    <aside
      aria-label="Run inspector"
      className="min-h-0 overflow-y-auto rounded-2xl border border-slate-800 bg-slate-900/35 p-5"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-semibold text-slate-100">
            <ListTree className="h-4 w-4 text-cyan-300" /> Execution log
          </div>
          <p className="mt-1 truncate font-mono text-[10px] text-slate-600">
            {run.id}
          </p>
        </div>
        <Badge
          variant="outline"
          className={cn("capitalize", STATUS_STYLES[run.status])}
        >
          {run.status}
        </Badge>
      </div>

      <div className="mt-5">
        <div className="flex items-center justify-between text-[11px]">
          <span className="text-slate-400">{run.currentStep}</span>
          <span className="tabular-nums text-slate-500">
            {Math.round(run.progress * 100)}%
          </span>
        </div>
        <div
          role="progressbar"
          aria-label="Run progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(run.progress * 100)}
          className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-800"
        >
          <div
            className="h-full rounded-full bg-cyan-400 transition-[width] duration-300"
            style={{ width: `${Math.round(run.progress * 100)}%` }}
          />
        </div>
      </div>

      <div className="mt-5 grid grid-cols-2 gap-2 text-[10px]">
        <div className="rounded-lg bg-slate-950/60 p-2.5">
          <span className="text-slate-600">Executor</span>
          <span className="mt-1 block text-slate-300">
            {executorLabel}
          </span>
        </div>
        <div className="rounded-lg bg-slate-950/60 p-2.5">
          <span className="text-slate-600">{outputStat.label}</span>
          <span className="mt-1 block text-slate-300">{outputStat.value}</span>
        </div>
      </div>

      {planSnapshot ? (
        <Button
          type="button"
          variant="outline"
          onClick={() => onInspectInFlow(run)}
          className="mt-3 w-full border-cyan-400/20 bg-cyan-400/5 text-cyan-100 hover:bg-cyan-400/10"
        >
          <Workflow className="h-4 w-4" /> Inspect run on Flow canvas
        </Button>
      ) : null}

      {run.failure ? (
        <section
          aria-label="Structured run failure"
          className="mt-4 rounded-xl border border-rose-500/20 bg-rose-500/8 p-3"
        >
          <div className="flex flex-wrap items-center gap-2">
            <ShieldAlert className="h-3.5 w-3.5 text-rose-200" />
            <p className="text-[11px] font-semibold text-rose-100">
              {run.failure.message}
            </p>
            <Badge
              variant="outline"
              className="border-rose-300/20 font-mono text-[8px] text-rose-200/65"
            >
              {run.failure.code}
            </Badge>
          </div>
          <p className="mt-1.5 text-[9px] leading-4 text-rose-100/60">
            {run.failure.partialOutputsExist
              ? "Published outputs were preserved."
              : "No output was published."}{" "}
            Retry policy: {run.failure.retryability.replaceAll("-", " ")}.
          </p>
          <details className="mt-2 text-[9px] text-slate-500">
            <summary className="cursor-pointer hover:text-slate-300">
              Technical diagnostic
            </summary>
            <p className="mt-1.5 break-words rounded-md bg-slate-950/45 p-2 font-mono leading-4 text-slate-400">
              {run.failure.technicalDiagnostic}
            </p>
          </details>
        </section>
      ) : run.error ? (
        <div className="mt-4 rounded-xl border border-rose-500/20 bg-rose-500/8 p-3 text-xs leading-5 text-rose-200">
          {run.error}
        </div>
      ) : null}

      {run.humanReviews.length > 0 ? (
        <section
          aria-labelledby="human-review-heading"
          className="mt-5 rounded-xl border border-fuchsia-400/20 bg-fuchsia-400/5 p-3.5"
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3
                id="human-review-heading"
                className="flex items-center gap-2 text-[11px] font-semibold text-fuchsia-100"
              >
                <Images className="h-3.5 w-3.5" /> Human review
              </h3>
              <p className="mt-1 text-[9px] leading-4 text-slate-500">
                Decisions are append-only observations. Machine scores and
                candidate bytes remain unchanged.
              </p>
            </div>
            <Badge
              variant="outline"
              className="border-fuchsia-400/25 text-[9px] text-fuchsia-200"
            >
              {pendingReview
                ? "gate " + pendingReview.sequence
                : "decision recorded"}
            </Badge>
          </div>

          {pendingReview ? (
            <div className="mt-3">
              <div className="rounded-lg border border-fuchsia-300/15 bg-slate-950/35 p-3">
                <p className="text-[10px] font-medium leading-4 text-fuchsia-50">
                  {pendingReview.instructions}
                </p>
                <p className="mt-1.5 text-[9px] text-slate-500">
                  Select 1–{pendingReview.maxSelections}.{" "}
                  {pendingReview.requireComment
                    ? "A review note is required."
                    : "A review note is optional."}
                </p>
              </div>

              <div
                className="mt-3 grid grid-cols-2 gap-2"
                aria-label="Review candidates"
              >
                {reviewAssets.map((asset) => {
                  const selected = selectedAssetIds.includes(asset.id);
                  const atLimit =
                    selectedAssetIds.length >= pendingReview.maxSelections;
                  return (
                    <button
                      key={asset.id}
                      type="button"
                      aria-pressed={selected}
                      aria-label={
                        "Candidate " +
                        (asset.outputIndex + 1) +
                        (selected ? ", selected" : ", not selected")
                      }
                      disabled={
                        humanReviewPending ||
                        (!selected && atLimit && pendingReview.maxSelections > 1)
                      }
                      onClick={() => toggleReviewAsset(asset.id)}
                      className={cn(
                        "group relative overflow-hidden rounded-lg border bg-slate-950/60 text-left outline-none transition focus-visible:ring-2 focus-visible:ring-fuchsia-300/70 disabled:cursor-not-allowed disabled:opacity-45",
                        selected
                          ? "border-fuchsia-300/70 ring-1 ring-fuchsia-300/30"
                          : "border-slate-800 hover:border-fuchsia-300/35",
                      )}
                    >
                      <span className="block aspect-square bg-slate-900">
                        <ReviewAssetPreview asset={asset} />
                      </span>
                      <span className="flex items-center justify-between gap-2 px-2 py-1.5">
                        <span className="text-[9px] font-medium text-slate-300">
                          Candidate {asset.outputIndex + 1}
                        </span>
                        <span className="font-mono text-[8px] text-slate-600">
                          {asset.width}×{asset.height}
                        </span>
                      </span>
                      <span
                        aria-hidden="true"
                        className={cn(
                          "absolute right-2 top-2 flex h-5 w-5 items-center justify-center rounded-full border text-[10px] font-bold shadow-lg backdrop-blur",
                          selected
                            ? "border-fuchsia-100/70 bg-fuchsia-300 text-slate-950"
                            : "border-white/25 bg-slate-950/60 text-transparent",
                        )}
                      >
                        ✓
                      </span>
                    </button>
                  );
                })}
              </div>

              <label className="mt-3 block">
                <span className="flex items-center gap-1.5 text-[9px] font-medium text-slate-400">
                  <MessageSquareText className="h-3 w-3" /> Review note
                  {pendingReview.requireComment ? " · required" : " · optional"}
                </span>
                <textarea
                  value={comment}
                  maxLength={2_000}
                  disabled={humanReviewPending}
                  onChange={(event) => {
                    setComment(event.target.value);
                    setRejectArmed(false);
                  }}
                  placeholder="Record the reason for this decision…"
                  className="mt-1.5 min-h-20 w-full resize-y rounded-lg border border-slate-700/80 bg-slate-950/65 px-3 py-2 text-[10px] leading-4 text-slate-200 outline-none placeholder:text-slate-700 focus:border-fuchsia-300/55 focus:ring-2 focus:ring-fuchsia-300/15 disabled:opacity-50"
                />
              </label>
              <div className="mt-3 grid grid-cols-2 gap-2">
                <Button
                  type="button"
                  disabled={
                    humanReviewPending ||
                    selectedAssetIds.length === 0 ||
                    !reviewCommentValid
                  }
                  onClick={() => submitHumanReview("approve")}
                  className="h-auto min-h-9 whitespace-normal bg-fuchsia-300 px-2 py-2 text-[10px] leading-4 text-slate-950 hover:bg-fuchsia-200"
                >
                  {humanReviewPending
                    ? "Recording…"
                    : selectedAssetIds.length > 0
                      ? "Approve " + selectedAssetIds.length
                      : "Approve selection"}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={humanReviewPending || !reviewCommentValid}
                  onClick={() => {
                    if (rejectArmed) {
                      submitHumanReview("reject");
                    } else {
                      setRejectArmed(true);
                    }
                  }}
                  className={cn(
                    "h-auto min-h-9 whitespace-normal px-2 py-2 text-[10px] leading-4",
                    rejectArmed
                      ? "border-rose-300/50 bg-rose-400/15 text-rose-100 hover:bg-rose-400/20"
                      : "border-slate-700 text-slate-400 hover:bg-slate-800",
                  )}
                >
                  {rejectArmed ? "Confirm reject all" : "Reject all candidates"}
                </Button>
              </div>
            </div>
          ) : null}

          {run.humanReviews.some(
            (review) =>
              review.status === "approved" || review.status === "rejected",
          ) ? (
            <ol className="mt-3 space-y-2 border-t border-fuchsia-300/10 pt-3">
              {run.humanReviews
                .filter(
                  (review) =>
                    review.status === "approved" ||
                    review.status === "rejected",
                )
                .map((review) => (
                  <li
                    key={review.id}
                    className="rounded-lg bg-slate-950/40 p-2.5 text-[9px]"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium capitalize text-slate-300">
                        Gate {review.sequence} · {review.status}
                      </span>
                      <span className="text-slate-600">
                        {review.selectedAssetIds.length} selected
                      </span>
                    </div>
                    {review.comment ? (
                      <p className="mt-1.5 whitespace-pre-wrap leading-4 text-slate-500">
                        {review.comment}
                      </p>
                    ) : null}
                    <p className="mt-1 font-mono text-[8px] text-slate-700">
                      {review.actor ?? "unknown actor"} · {review.decisionId}
                    </p>
                  </li>
                ))}
            </ol>
          ) : null}
        </section>
      ) : null}

      {planSnapshot ? (
        <section
          aria-labelledby="run-plan-heading"
          className="mt-5 rounded-xl border border-sky-400/15 bg-sky-400/5 p-3.5"
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3
                id="run-plan-heading"
                className="flex items-center gap-2 text-[11px] font-semibold text-sky-100"
              >
                <Workflow className="h-3.5 w-3.5" /> Expanded execution plan
              </h3>
              <p className="mt-1 text-[9px] leading-4 text-slate-500">
                Semantic intent is stored separately from runtime preparation.
              </p>
            </div>
            <Badge
              variant="outline"
              className="border-sky-400/20 text-[9px] text-sky-200"
            >
              {planSnapshot.nodes.length} nodes · {planSnapshot.steps.length} steps
            </Badge>
          </div>
          {run.executor === "deterministic-fixture" ? (
            <p
              role="note"
              className="mt-3 rounded-lg border border-amber-300/20 bg-amber-300/8 px-3 py-2 text-[9px] leading-4 text-amber-100/80"
            >
              Fixture evidence only: remote, paid, and model steps below describe the pinned plan but were not submitted or executed. The stored images came from the deterministic fixture executor.
            </p>
          ) : run.executor === "mock-remote-provider" ? (
            <p
              role="note"
              className="mt-3 rounded-lg border border-violet-300/20 bg-violet-300/8 px-3 py-2 text-[9px] leading-4 text-violet-100/80"
            >
              Provider durability simulation: this run exercises submission and reconciliation states against the built-in mock adapter; it does not contact or charge a third party.
            </p>
          ) : null}
          <ol className="mt-3 space-y-2.5" aria-label="Expanded plan nodes">
            {planSnapshot.nodes.map((node) => {
              const nodeSteps = planSnapshot.steps.filter(
                (step) => step.sourceNodeId === node.id,
              );
              return (
                <li
                  key={node.id}
                  className="rounded-lg border border-slate-800/80 bg-slate-950/45 p-2.5"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-[10px] font-semibold text-slate-200">
                        {node.label}
                      </p>
                      <p className="mt-0.5 font-mono text-[8px] text-slate-600">
                        {node.type} · {node.layer}
                      </p>
                    </div>
                    <span className="shrink-0 rounded-md bg-slate-900 px-1.5 py-1 text-[8px] text-slate-500">
                      {nodeSteps.length} step{nodeSteps.length === 1 ? "" : "s"}
                    </span>
                  </div>
                  {nodeSteps.length > 0 ? (
                    <ol className="mt-2 space-y-1.5 border-l border-sky-400/15 pl-2.5">
                      {nodeSteps.map((step) => (
                        <li key={step.id} className="text-[9px] leading-4">
                          <div className="flex items-start justify-between gap-2">
                            <span className="text-slate-400">{step.label}</span>
                            <span className="shrink-0 text-slate-600">
                              {step.target}
                            </span>
                          </div>
                          {step.sideEffect ? (
                            <span className="mt-0.5 inline-flex rounded border border-amber-300/15 px-1.5 text-[8px] text-amber-200/60">
                              {step.sideEffect.replaceAll("-", " ")}
                            </span>
                          ) : step.cacheable ? (
                            <span className="mt-0.5 inline-flex text-[8px] text-slate-700">
                              cacheable
                            </span>
                          ) : null}
                        </li>
                      ))}
                    </ol>
                  ) : (
                    <p className="mt-2 text-[8px] text-slate-700">
                      Intent-only node; no separate runtime preparation.
                    </p>
                  )}
                </li>
              );
            })}
          </ol>
          <p className="mt-3 border-t border-sky-300/10 pt-2.5 font-mono text-[8px] text-slate-700">
            {run.flowRevisionId
              ? `revision ${run.flowRevisionId} · `
              : "unrevisioned legacy run · "}
            flow {planSnapshot.flowFingerprint.slice(0, 16)}… · schema {planSnapshot.schemaVersion}
          </p>
        </section>
      ) : null}

      {providerJob ? (
        <section
          aria-labelledby="provider-decision-heading"
          className="mt-5 rounded-xl border border-violet-400/15 bg-violet-400/5 p-3.5"
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3
                id="provider-decision-heading"
                className="flex items-center gap-2 text-[11px] font-semibold text-violet-100"
              >
                <CloudCog className="h-3.5 w-3.5" /> Provider decision
              </h3>
              <p className="mt-1 font-mono text-[9px] text-slate-600">
                attempt {providerJob.attempt} · {providerJob.id}
              </p>
            </div>
            <Badge
              variant="outline"
              className="border-violet-400/25 text-[9px] text-violet-200"
            >
              {providerJob.status}
            </Badge>
          </div>

          {providerJob.reviewRequired ? (
            <div className="mt-3 rounded-lg border border-amber-300/25 bg-amber-300/8 p-3">
              <p className="flex items-center gap-2 text-[11px] font-semibold text-amber-100">
                <ShieldAlert className="h-3.5 w-3.5" /> Duplicate-charge guard
              </p>
              <p className="mt-1.5 text-[10px] leading-4 text-amber-100/70">
                {providerJob.reviewReason} No automatic submission will occur.
              </p>
              {providerJob.policy.idempotencyMode !== "none" ? (
                <Button
                  type="button"
                  disabled={providerReviewPending}
                  onClick={() =>
                    onResolveProviderReview(providerJob.id, "reconcile-only")
                  }
                  className="mt-3 h-8 w-full bg-violet-300 text-[10px] text-slate-950 hover:bg-violet-200"
                >
                  {providerReviewPending ? "Reconciling…" : "Lookup original request"}
                </Button>
              ) : (
                <p className="mt-2 text-[9px] leading-4 text-amber-100/60">
                  This endpoint has no documented request lookup. Check the provider usage
                  dashboard before closing this guard.
                </p>
              )}
              <Button
                type="button"
                variant="ghost"
                disabled={providerReviewPending}
                onClick={() =>
                  onResolveProviderReview(
                    providerJob.id,
                    "confirm-not-accepted-and-retry",
                  )
                }
                className="mt-1 h-auto w-full whitespace-normal px-2 py-2 text-[9px] leading-4 text-amber-200/70 hover:bg-amber-300/8 hover:text-amber-100"
              >
                {providerJob.policy.idempotencyMode === "none"
                  ? "I confirmed no charge — allow a new Generate"
                  : "I confirmed it was not accepted — create a new paid attempt"}
              </Button>
              {providerJob.policy.idempotencyMode === "none" ? (
                <Button
                  type="button"
                  variant="ghost"
                  disabled={providerReviewPending}
                  onClick={() =>
                    onResolveProviderReview(
                      providerJob.id,
                      "accept-duplicate-charge-risk-and-retry",
                    )
                  }
                  className="mt-1 h-auto w-full whitespace-normal border border-rose-300/15 px-2 py-2 text-[9px] leading-4 text-rose-200/70 hover:bg-rose-300/8 hover:text-rose-100"
                >
                  Accept possible duplicate charge — allow a new Generate
                </Button>
              ) : null}
            </div>
          ) : null}

          <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 text-[9px]">
            <div>
              <dt className="text-slate-600">Adapter</dt>
              <dd className="mt-0.5 text-slate-300">
                {providerJob.policy.adapterId} · v{providerJob.policy.adapterVersion}
              </dd>
            </div>
            <div>
              <dt className="text-slate-600">Endpoint / region</dt>
              <dd className="mt-0.5 text-slate-300">
                {providerJob.policy.endpointVersion} · {providerJob.policy.region}
              </dd>
            </div>
            <div>
              <dt className="text-slate-600">Maximum exposure</dt>
              <dd className="mt-0.5 text-slate-300">
                {providerJob.estimatedCostMax > 0
                  ? `${providerJob.currency} ${providerJob.estimatedCostMax.toFixed(2)}`
                  : "Provider calculator"}
              </dd>
            </div>
            <div>
              <dt className="text-slate-600">Idempotency</dt>
              <dd className="mt-0.5 text-slate-300">
                {providerJob.policy.idempotencyMode}
              </dd>
            </div>
            <div>
              <dt className="text-slate-600">Output visibility</dt>
              <dd className="mt-0.5 text-slate-300">
                {providerJob.policy.outputVisibility.replaceAll("-", " ")}
              </dd>
            </div>
            <div>
              <dt className="text-slate-600">Provider retention</dt>
              <dd className="mt-0.5 text-slate-300">
                {providerJob.policy.outputRetentionSeconds === null
                  ? "Not asserted by provider"
                  : providerJob.policy.outputRetentionSeconds > 0
                    ? `${Math.round(providerJob.policy.outputRetentionSeconds / 60)} min output`
                    : "No retained provider output"}
              </dd>
            </div>
            <div>
              <dt className="text-slate-600">Uploads</dt>
              <dd className="mt-0.5 text-slate-300">
                {providerJob.policy.uploadAssetCount} assets · {providerJob.policy.uploadBytes} B
              </dd>
            </div>
            <div>
              <dt className="text-slate-600">Last provider state</dt>
              <dd className="mt-0.5 text-slate-300">
                {providerJob.rawState ?? "not submitted"}
              </dd>
            </div>
          </dl>
          <div className="mt-3 border-t border-violet-300/10 pt-3 text-[9px] leading-4 text-slate-500">
            <p>{providerJob.policy.retryPolicy}</p>
            <p className="mt-1">{providerJob.policy.cancellationSemantics}</p>
            <p className="mt-1 font-mono text-slate-600">
              request sha256 {providerJob.requestDigest.slice(0, 16)}… · {providerJob.pollAttempts} polls
            </p>
          </div>
        </section>
      ) : null}

      <ol className="mt-5 space-y-0" aria-label="Run events">
        {run.events.map((event, index) => (
          <li key={event.id} className="relative flex gap-3 pb-4 last:pb-0">
            {index < run.events.length - 1 ? (
              <span className="absolute left-[7px] top-4 h-full w-px bg-slate-800" />
            ) : null}
            <span
              className={cn(
                "relative mt-1 h-[15px] w-[15px] shrink-0 rounded-full border-4 border-slate-900",
                event.kind === "run_failed"
                  ? "bg-rose-400"
                  : event.kind === "run_completed"
                    ? "bg-lime-400"
                    : "bg-sky-400",
              )}
            />
            <div className="min-w-0 flex-1">
              <div className="flex items-start justify-between gap-2">
                <span className="text-[11px] font-medium text-slate-300">
                  {event.kind.replaceAll("_", " ")}
                </span>
                <span className="shrink-0 text-[9px] text-slate-700">
                  {formatEventTime(event.createdAt)}
                </span>
              </div>
              <p className="mt-1 text-[10px] leading-4 text-slate-500">
                {event.message}
              </p>
            </div>
          </li>
        ))}
      </ol>

      {canCancel ? (
        <Button
          type="button"
          variant="outline"
          onClick={() => onCancel(run.id)}
          className="mt-5 w-full border-orange-400/20 bg-orange-400/5 text-orange-200 hover:bg-orange-400/10"
        >
          <Ban className="h-4 w-4" /> Cancel at safe checkpoint
        </Button>
      ) : null}
      {canRetry ? (
        <Button
          type="button"
          variant="outline"
          onClick={() => onRetry(run.id)}
          className="mt-5 w-full border-sky-400/20 bg-sky-400/5 text-sky-200 hover:bg-sky-400/10"
        >
          <RotateCw className="h-4 w-4" /> Retry and reuse published outputs
        </Button>
      ) : null}
    </aside>
  );
};

export const MediaRunsView = ({
  runs,
  selectedRun,
  runtimeError,
  onCreate,
  onSelect,
  onCancel,
  onRetry,
  onResolveProviderReview,
  providerReviewPending,
  onResolveHumanReview,
  humanReviewPending,
  onInspectInFlow,
  onRefresh,
}: MediaRunsViewProps): JSX.Element => {
  return (
    <div className="flex h-full min-h-0 flex-col bg-slate-950 px-5 py-6 sm:px-7 sm:py-7">
      <div className="mx-auto flex min-h-0 w-full max-w-6xl flex-1 flex-col">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <h1 className="flex items-center gap-2 text-sm font-semibold text-slate-100">
            <FileClock className="h-4 w-4 text-amber-300" /> Run history
          </h1>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Refresh runs"
              onClick={onRefresh}
              className="text-slate-500 hover:bg-slate-900 hover:text-slate-200"
            >
              <RotateCw className="h-4 w-4" />
            </Button>
            <Button
              onClick={onCreate}
              className="bg-sky-500 text-slate-950 hover:bg-sky-400"
            >
              <Plus className="h-4 w-4" /> New recipe
            </Button>
          </div>
        </div>

        {runtimeError ? (
          <div className="mt-4 rounded-xl border border-rose-500/20 bg-rose-500/8 px-4 py-3 text-xs text-rose-200">
            {runtimeError}
          </div>
        ) : null}

        {runs.length === 0 ? (
          <div className="mt-8 flex min-h-96 flex-1 flex-col items-center justify-center rounded-3xl border border-dashed border-slate-800 bg-slate-900/15 px-6 text-center">
            <Clock3 className="h-8 w-8 text-slate-600" />
            <h2 className="mt-4 text-base font-semibold text-slate-200">
              No runs yet
            </h2>
          </div>
        ) : (
          <div
            className={cn(
              "mt-6 grid min-h-0 flex-1 gap-4 overflow-y-auto xl:overflow-hidden",
              selectedRun && "xl:grid-cols-[minmax(0,1fr)_360px]",
            )}
          >
            <div className="min-h-0 overflow-y-auto rounded-2xl border border-slate-800">
              {runs.map((run) => {
                const runtimeRun = isRuntimeRun(run);
                const selected = selectedRun?.id === run.id;
                const content = (
                  <>
                    <div className="flex flex-wrap items-start justify-between gap-4">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <h2 className="text-sm font-semibold text-slate-100">
                            {run.flowName}
                          </h2>
                          <span
                            className={cn(
                              "inline-flex items-center gap-1.5 text-[11px] capitalize",
                              STATUS_STYLES[run.status],
                            )}
                          >
                            <span className="h-1.5 w-1.5 rounded-full bg-current" />
                            {run.status}
                          </span>
                        </div>
                        <p className="mt-2 line-clamp-2 text-xs leading-5 text-slate-400">
                          {run.prompt || "No prompt supplied"}
                        </p>
                      </div>
                      <div className="text-right text-[10px] text-slate-600">
                        {formatCreatedAt(run.createdAt)}
                      </div>
                    </div>
                    {runtimeRun ? (
                      <div className="mt-4">
                        <div className="flex items-center justify-between text-[10px] text-slate-600">
                          <span>{run.currentStep}</span>
                          <span className="tabular-nums">
                            {Math.round(run.progress * 100)}%
                          </span>
                        </div>
                        <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-slate-800">
                          <div
                            className="h-full rounded-full bg-cyan-400 transition-[width]"
                            style={{ width: `${Math.round(run.progress * 100)}%` }}
                          />
                        </div>
                      </div>
                    ) : null}
                    <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-[11px] text-slate-500">
                      <span className="flex items-center gap-1.5">
                        <Cpu className="h-3.5 w-3.5" /> {run.modelLabel}
                      </span>
                      <span className="flex items-center gap-1.5">
                        <RadioTower className="h-3.5 w-3.5" />
                        {run.target ?? "unresolved"}
                      </span>
                      <span>{run.outputCount} outputs</span>
                      {run.diagnosticCount > 0 ? (
                        <span>{run.diagnosticCount} diagnostics</span>
                      ) : null}
                    </div>
                  </>
                );

                return runtimeRun ? (
                  <button
                    key={run.id}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => onSelect(run.id)}
                    className={cn(
                      "block w-full border-b border-slate-800/80 bg-slate-900/25 p-5 text-left outline-none transition-colors last:border-b-0 hover:bg-slate-900/45 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sky-400/60",
                      selected && "bg-slate-900/65",
                    )}
                  >
                    {content}
                  </button>
                ) : (
                  <article
                    key={run.id}
                    className="border-b border-slate-800/80 bg-slate-900/25 p-5 last:border-b-0"
                  >
                    {content}
                  </article>
                );
              })}
            </div>
            {selectedRun ? (
              <RunInspector
                run={selectedRun}
                onCancel={onCancel}
                onRetry={onRetry}
                onResolveProviderReview={onResolveProviderReview}
                providerReviewPending={providerReviewPending}
                onResolveHumanReview={onResolveHumanReview}
                humanReviewPending={humanReviewPending}
                onInspectInFlow={onInspectInFlow}
              />
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
};
