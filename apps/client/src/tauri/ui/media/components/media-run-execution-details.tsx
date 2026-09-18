import { CloudCog, ShieldAlert } from "lucide-react";
import type { JSX } from "react";
import type {
  MediaRunDetail,
  MediaProviderReviewAction,
} from "../../../../core/media/contracts.js";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";

export const MediaRunExecutionDetails = ({
  run,
  onResolveProviderReview,
  providerReviewPending,
}: {
  run: MediaRunDetail;
  onResolveProviderReview: (
    providerJobId: string,
    action: MediaProviderReviewAction,
  ) => void;
  providerReviewPending: boolean;
}): JSX.Element => {
  const planSnapshot = run.planSnapshot;
  const providerJob = run.providerJobs.at(-1);
  return (
    <>
      {planSnapshot ? (
        <details className="mt-5 border-t border-slate-800 pt-4">
          <summary className="cursor-pointer text-sm font-medium text-slate-200">
            Execution plan
          </summary>
          {run.executor === "deterministic-fixture" ? (
            <p
              role="note"
              className="mt-3 rounded-lg border border-amber-300/20 bg-amber-300/8 px-3 py-2 text-xs leading-4 text-amber-100/80"
            >
              Fixture evidence only: remote, paid, and model steps below
              describe the pinned plan but were not submitted or executed. The
              stored images came from the deterministic fixture executor.
            </p>
          ) : run.executor === "mock-remote-provider" ? (
            <p
              role="note"
              className="mt-3 rounded-lg border border-violet-300/20 bg-violet-300/8 px-3 py-2 text-xs leading-4 text-violet-100/80"
            >
              Provider durability simulation: this run exercises submission and
              reconciliation states against the built-in mock adapter; it does
              not contact or charge a third party.
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
                      <p className="break-words text-xs leading-4 font-semibold text-slate-200">
                        {node.label}
                      </p>
                      <p className="mt-0.5 font-mono text-xs text-slate-400">
                        {node.type} · {node.layer}
                      </p>
                    </div>
                    <span className="shrink-0 rounded-md bg-slate-900 px-1.5 py-1 text-xs text-slate-500">
                      {nodeSteps.length} step{nodeSteps.length === 1 ? "" : "s"}
                    </span>
                  </div>
                  {nodeSteps.length > 0 ? (
                    <ol className="mt-2 space-y-1.5 border-l border-sky-400/15 pl-2.5">
                      {nodeSteps.map((step) => (
                        <li key={step.id} className="text-xs leading-4">
                          <div className="flex items-start justify-between gap-2">
                            <span className="text-slate-400">{step.label}</span>
                            <span className="shrink-0 text-slate-400">
                              {step.target}
                            </span>
                          </div>
                          {step.sideEffect ? (
                            <span className="mt-0.5 inline-flex rounded border border-amber-300/15 px-1.5 text-xs text-amber-200/60">
                              {step.sideEffect.replaceAll("-", " ")}
                            </span>
                          ) : step.cacheable ? (
                            <span className="mt-0.5 inline-flex text-xs text-slate-500">
                              cacheable
                            </span>
                          ) : null}
                        </li>
                      ))}
                    </ol>
                  ) : (
                    <p className="mt-2 text-xs text-slate-500">
                      Intent-only node; no separate runtime preparation.
                    </p>
                  )}
                </li>
              );
            })}
          </ol>
          <p className="mt-3 border-t border-sky-300/10 pt-2.5 font-mono text-xs text-slate-500">
            {run.flowRevisionId
              ? `revision ${run.flowRevisionId} · `
              : "unrevisioned run · "}
            flow {planSnapshot.flowFingerprint.slice(0, 16)}… · schema{" "}
            {planSnapshot.schemaVersion}
          </p>
        </details>
      ) : null}

      {providerJob ? (
        <details
          open={providerJob.reviewRequired}
          className="mt-5 border-t border-slate-800 pt-4"
        >
          <summary className="cursor-pointer text-sm font-medium text-slate-200">
            Provider {providerJob.reviewRequired ? "review" : "details"}
          </summary>
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3
                id="provider-decision-heading"
                className="flex items-center gap-2 text-xs font-semibold text-violet-100"
              >
                <CloudCog className="h-3.5 w-3.5" /> Provider decision
              </h3>
              <p className="mt-1 font-mono text-xs text-slate-400">
                attempt {providerJob.attempt} · {providerJob.id}
              </p>
            </div>
            <Badge
              variant="outline"
              className="border-violet-400/25 text-xs text-violet-200"
            >
              {providerJob.status}
            </Badge>
          </div>

          {providerJob.reviewRequired ? (
            <div className="mt-3 rounded-lg border border-amber-300/25 bg-amber-300/8 p-3">
              <p className="flex items-center gap-2 text-xs font-semibold text-amber-100">
                <ShieldAlert className="h-3.5 w-3.5" /> Duplicate-charge guard
              </p>
              <p className="mt-1.5 text-xs leading-4 text-amber-100/70">
                {providerJob.reviewReason} No automatic submission will occur.
              </p>
              {providerJob.policy.idempotencyMode !== "none" ? (
                <Button
                  type="button"
                  disabled={providerReviewPending}
                  onClick={() =>
                    onResolveProviderReview(providerJob.id, "reconcile-only")
                  }
                  className="mt-3 h-8 w-full bg-violet-300 text-xs text-slate-950 hover:bg-violet-200"
                >
                  {providerReviewPending
                    ? "Reconciling…"
                    : "Lookup original request"}
                </Button>
              ) : (
                <p className="mt-2 text-xs leading-4 text-amber-100/60">
                  This endpoint has no documented request lookup. Check the
                  provider usage dashboard before closing this guard.
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
                className="mt-1 h-auto w-full whitespace-normal px-2 py-2 text-xs leading-4 text-amber-200/70 hover:bg-amber-300/8 hover:text-amber-100"
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
                  className="mt-1 h-auto w-full whitespace-normal border border-rose-300/15 px-2 py-2 text-xs leading-4 text-rose-200/70 hover:bg-rose-300/8 hover:text-rose-100"
                >
                  Accept possible duplicate charge — allow a new Generate
                </Button>
              ) : null}
            </div>
          ) : null}

          <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
            <div>
              <dt className="text-slate-400">Adapter</dt>
              <dd className="mt-0.5 text-slate-300">
                {providerJob.policy.adapterId} · v
                {providerJob.policy.adapterVersion}
              </dd>
            </div>
            <div>
              <dt className="text-slate-400">Endpoint / region</dt>
              <dd className="mt-0.5 text-slate-300">
                {providerJob.policy.endpointVersion} ·{" "}
                {providerJob.policy.region}
              </dd>
            </div>
            <div>
              <dt className="text-slate-400">Maximum exposure</dt>
              <dd className="mt-0.5 text-slate-300">
                {providerJob.estimatedCostMax > 0
                  ? `${providerJob.currency} ${providerJob.estimatedCostMax.toFixed(2)}`
                  : "Provider calculator"}
              </dd>
            </div>
            <div>
              <dt className="text-slate-400">Idempotency</dt>
              <dd className="mt-0.5 text-slate-300">
                {providerJob.policy.idempotencyMode}
              </dd>
            </div>
            <div>
              <dt className="text-slate-400">Output visibility</dt>
              <dd className="mt-0.5 text-slate-300">
                {providerJob.policy.outputVisibility.replaceAll("-", " ")}
              </dd>
            </div>
            <div>
              <dt className="text-slate-400">Provider retention</dt>
              <dd className="mt-0.5 text-slate-300">
                {providerJob.policy.outputRetentionSeconds === null
                  ? "Not asserted by provider"
                  : providerJob.policy.outputRetentionSeconds > 0
                    ? `${Math.round(providerJob.policy.outputRetentionSeconds / 60)} min output`
                    : "No retained provider output"}
              </dd>
            </div>
            <div>
              <dt className="text-slate-400">Uploads</dt>
              <dd className="mt-0.5 text-slate-300">
                {providerJob.policy.uploadAssetCount} assets ·{" "}
                {providerJob.policy.uploadBytes} B
              </dd>
            </div>
            <div>
              <dt className="text-slate-400">Last provider state</dt>
              <dd className="mt-0.5 text-slate-300">
                {providerJob.rawState ?? "not submitted"}
              </dd>
            </div>
          </dl>
          <div className="mt-3 border-t border-violet-300/10 pt-3 text-xs leading-4 text-slate-500">
            <p>{providerJob.policy.retryPolicy}</p>
            <p className="mt-1">{providerJob.policy.cancellationSemantics}</p>
            <p className="mt-1 font-mono text-slate-400">
              request sha256 {providerJob.requestDigest.slice(0, 16)}… ·{" "}
              {providerJob.pollAttempts} polls
            </p>
          </div>
        </details>
      ) : null}
    </>
  );
};
