import { MediaGenerationEstimate } from "./media-generation-estimate";
import { generationJobToRunDetail } from "../media-generation-run";
import { LoaderCircle } from "lucide-react";
import type { JSX } from "react";
import type { MediaGenerationQueueJob } from "../media-generation-queue";
import { Button } from "../../components/ui/button";
import { cn } from "../../lib/utils";
import { MediaGenerationElapsed } from "./media-generation-elapsed";

export const MediaGenerationJobs = ({
  jobs,
  selectedJobId,
  onSelect,
  onOpenActivity,
  onCancel,
}: {
  jobs: readonly MediaGenerationQueueJob[];
  selectedJobId: string | null;
  onSelect: (runId: string) => void;
  onOpenActivity: (runId: string) => void;
  onCancel: (runId: string) => void;
}): JSX.Element => (
  <section
    aria-label="Generations"
    className="mb-4 max-h-64 shrink-0 space-y-2 overflow-y-auto"
  >
    {[...jobs].reverse().map((job) => {
      const active = ["queued", "running", "canceling"].includes(job.status);
      const selected = selectedJobId === job.id;
      return (
        <article
          key={job.id}
          className={cn(
            "rounded-xl border bg-slate-900/45",
            selected ? "border-sky-400/50" : "border-slate-800",
          )}
        >
          <button
            type="button"
            aria-pressed={selected}
            onClick={() => onSelect(job.id)}
            className="block w-full space-y-1 p-3 text-left"
          >
            <span className="flex items-center justify-between gap-3 text-xs">
              <span className="truncate font-semibold text-slate-100">
                {job.recipe.modelLabel} · {job.recipe.target}
              </span>
              <span className="flex shrink-0 items-center gap-1 capitalize text-slate-300">
                {active ? (
                  <LoaderCircle className="h-3 w-3 animate-spin" />
                ) : null}
                {job.status}
                {active ? ` · ${Math.round(job.progress * 100)}%` : ""}
              </span>
            </span>
            <span className="block truncate text-xs text-slate-400">
              {job.recipe.prompt}
            </span>
            <span className="block text-xs text-slate-500">
              <span>{job.currentStep}</span>
              {job.startedAt ? (
                <>
                  {" "}
                  ·{" "}
                  <MediaGenerationElapsed
                    startedAt={job.startedAt}
                    completedAt={job.completedAt}
                  />
                </>
              ) : null}
            </span>
            {active ? (
              <MediaGenerationEstimate run={generationJobToRunDetail(job)} />
            ) : null}
            {active ? (
              <span
                role="progressbar"
                aria-label={`${job.recipe.modelLabel} progress`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(job.progress * 100)}
                className="block h-1.5 overflow-hidden rounded-full bg-slate-800"
              >
                <span
                  className="block h-full rounded-full bg-sky-400"
                  style={{ width: `${Math.max(4, job.progress * 100)}%` }}
                />
              </span>
            ) : null}
          </button>
          {selected || active ? (
            <div className="flex gap-2 px-3 pb-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => onOpenActivity(job.id)}
              >
                View activity
              </Button>
              {active ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={job.status === "canceling"}
                  onClick={() => onCancel(job.id)}
                >
                  {job.status === "canceling" ? "Canceling" : "Cancel"}
                </Button>
              ) : null}
            </div>
          ) : null}
        </article>
      );
    })}
  </section>
);
