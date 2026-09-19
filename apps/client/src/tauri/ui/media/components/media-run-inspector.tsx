import { CopyContextMenu } from "../../components/ui/copy-context-menu";
import { RotateCw, Workflow } from "lucide-react";
import type { JSX } from "react";
import type { MediaRunDetail } from "../../../../core/media/contracts.js";
import { Button } from "../../components/ui/button";
import {
  canCancelMediaRun,
  formatRunDateTime,
} from "../media-run-presentation";
import { formatMediaImageRecipeOutput } from "../media-generation-recipe";
import { MediaGenerationEstimate } from "./media-generation-estimate";
import { MediaRunState } from "./media-run-state";
import { MediaRunResults } from "./media-run-results";
import { MediaRunHumanReview } from "./media-run-human-review";
import { MediaRunExecutionDetails } from "./media-run-execution-details";
import type { MediaRunsViewProps } from "./media-runs-view";

const EXECUTOR_LABELS: Record<MediaRunDetail["executor"], string> = {
  "deterministic-fixture": "Fixture",
  "openai-image-api": "OpenAI image generation",
  "codex-cli-image": "Codex CLI image generation",
  "local-import": "Local import",
  "local-transform": "Local transform",
  "local-image-flow": "Local image generation",
  "media-workflow": "Workflow",
  "local-analysis": "Local analysis",
  "local-video": "Local video generation",
  "local-wan-video": "Local WAN video generation",
  "mock-remote-provider": "Remote adapter",
  "svg-ai-pipeline": "SVG generation",
};

export const MediaRunInspector = ({
  run,
  errorNotice,
  selectedRecipe: recipe,
  onCancel,
  onRetry,
  onResolveProviderReview,
  providerReviewPending,
  onResolveHumanReview,
  humanReviewPending,
  onInspectInFlow,
  onReuseSettings,
  onOpenAsset,
}: Pick<
  MediaRunsViewProps,
  | "errorNotice"
  | "selectedRecipe"
  | "onCancel"
  | "onRetry"
  | "onResolveProviderReview"
  | "providerReviewPending"
  | "onResolveHumanReview"
  | "humanReviewPending"
  | "onInspectInFlow"
  | "onReuseSettings"
  | "onOpenAsset"
> & { run: MediaRunDetail }): JSX.Element => {
  const canRetry =
    run.executor === "deterministic-fixture" &&
    ["failed", "canceled"].includes(run.status) &&
    run.humanReviews.length === 0;
  const active = ["queued", "running", "canceling"].includes(run.status);
  return (
    <div aria-label="Run inspector" className="min-w-0 px-5 py-5 sm:px-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className={active ? "w-full max-w-xs" : ""}>
          <MediaRunState run={run} />
          {active ? (
            <div className="mt-2">
              <MediaGenerationEstimate run={run} />
            </div>
          ) : null}
        </div>
        <time
          dateTime={run.createdAt}
          className="text-xs tabular-nums text-slate-400"
        >
          {formatRunDateTime(run.createdAt)}
        </time>
      </div>
      {run.prompt && run.prompt !== run.flowName ? (
        <CopyContextMenu values={[{ label: "Copy prompt", value: run.prompt }]}>
          <p className="mt-5 whitespace-pre-wrap break-words text-sm leading-6 text-slate-200">
            {run.prompt}
          </p>
        </CopyContextMenu>
      ) : null}
      <div className="mt-5 flex flex-wrap gap-2">
        {canCancelMediaRun(run) ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onCancel(run.id)}
          >
            Cancel run
          </Button>
        ) : null}
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onReuseSettings(run.id)}
        >
          {run.flowRevisionId &&
          ["failed", "canceled", "blocked"].includes(run.status)
            ? "Edit and rerun"
            : "Reuse settings"}
        </Button>
        {run.flowRevisionId ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onInspectInFlow(run)}
          >
            <Workflow className="size-4" />
            Inspect flow
          </Button>
        ) : null}
        {canRetry ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onRetry(run.id)}
          >
            <RotateCw className="size-4" />
            Retry and reuse published outputs
          </Button>
        ) : null}
      </div>
      {!errorNotice && run.failure ? (
        <section
          aria-label="Run failure"
          className="mt-5 rounded-lg border border-rose-400/20 bg-rose-400/5 p-3 text-sm leading-5 text-rose-200"
        >
          {run.failure.code === "QUALITY_GATE_FAILED" ? (
            <details>
              <summary className="cursor-pointer">
                Quality check details
              </summary>
              <p className="mt-2">{run.failure.message}</p>
            </details>
          ) : (
            <>
              <p>{run.failure.message}</p>
              <details className="mt-2 text-xs text-slate-400">
                <summary className="cursor-pointer">
                  Technical diagnostic
                </summary>
                <p className="mt-2 break-words font-mono">{run.failure.code}</p>
                <p className="mt-1 whitespace-pre-wrap break-words">
                  {run.failure.technicalDiagnostic}
                </p>
              </details>
            </>
          )}
        </section>
      ) : !errorNotice && run.error ? (
        <p className="mt-5 rounded-lg border border-rose-400/20 bg-rose-400/5 p-3 text-sm leading-5 text-rose-200">
          {run.error}
        </p>
      ) : null}
      <MediaRunHumanReview
        run={run}
        onResolveHumanReview={onResolveHumanReview}
        humanReviewPending={humanReviewPending}
      />
      <MediaRunExecutionDetails
        run={run}
        onResolveProviderReview={onResolveProviderReview}
        providerReviewPending={providerReviewPending}
      />
      <MediaRunResults run={run} onOpenAsset={onOpenAsset} />
      <details className="mt-5 border-t border-slate-800 pt-4">
        <summary className="cursor-pointer text-sm font-medium text-slate-200">
          Settings
        </summary>
        <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
          <div>
            <dt className="text-slate-400">Executor</dt>
            <dd className="text-slate-300">{EXECUTOR_LABELS[run.executor]}</dd>
          </div>
          {run.target ? (
            <div>
              <dt className="text-slate-400">Location</dt>
              <dd className="capitalize text-slate-300">{run.target}</dd>
            </div>
          ) : null}
          <div className="col-span-2">
            <dt className="text-slate-400">Flow</dt>
            <dd className="break-words text-slate-300">
              {recipe
                ? `${recipe.flowName} · revision ${recipe.flowRevisionNumber}`
                : run.flowName}
            </dd>
          </div>
          <div className="col-span-2">
            <dt className="text-slate-400">Model</dt>
            <dd className="break-words text-slate-300">
              {recipe?.modelLabel ?? run.modelLabel}
            </dd>
          </div>
          {recipe?.imageSettings && recipe.target !== "video" ? (
            <div className="col-span-2">
              <dt className="text-slate-400">Output</dt>
              <dd className="text-slate-300">
                {formatMediaImageRecipeOutput(
                  recipe.imageSettings,
                  recipe.outputBranches,
                )}
              </dd>
            </div>
          ) : null}
          {recipe?.videoSettings ? (
            <div className="col-span-2">
              <dt className="text-slate-400">Video</dt>
              <dd className="text-slate-300">
                WebM · {recipe.videoSettings.numFrames} frames ·{" "}
                {recipe.videoSettings.fps} fps
              </dd>
            </div>
          ) : null}
          {recipe && recipe.modelAddons.length > 0 ? (
            <div className="col-span-2">
              <dt className="text-slate-400">Add-ons</dt>
              <dd className="text-slate-300">
                {recipe.modelAddons.map((addon) => addon.addonId).join(", ")}
              </dd>
            </div>
          ) : null}
        </dl>
      </details>

      {run.events.length > 0 ? (
        <details className="mt-5 border-t border-slate-800 pt-4">
          <summary className="cursor-pointer text-sm font-medium text-slate-200">
            Events ({run.events.length})
          </summary>
          <ol className="mt-4 space-y-4" aria-label="Run events">
            {run.events.map((event) => (
              <li key={event.id} className="flex items-start gap-4 text-xs">
                <time
                  dateTime={event.createdAt}
                  className="shrink-0 tabular-nums text-slate-400"
                >
                  {new Intl.DateTimeFormat(undefined, {
                    timeStyle: "medium",
                  }).format(new Date(event.createdAt))}
                </time>
                <div className="min-w-0">
                  <p className="font-medium capitalize text-slate-300">
                    {event.kind.replaceAll("_", " ")}
                  </p>
                  <p className="mt-1 break-words leading-5 text-slate-400">
                    {event.message}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        </details>
      ) : null}
    </div>
  );
};
