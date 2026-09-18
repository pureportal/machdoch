import { ChevronRight, FileImage, FileText, Workflow } from "lucide-react";
import { useId, type JSX } from "react";
import type {
  MediaAssetRecord,
  MediaRunRecord,
} from "../../../../core/media/contracts.js";
import { countMediaRunOutputs } from "../../../../core/media/run-library.js";
import { cn } from "../../lib/utils";
import {
  formatRunDateTime,
  isRuntimeRun,
  selectRunPreview,
} from "../media-run-presentation";
import { MediaAssetPreview } from "./media-visual-preview";
import { MEDIA_RUN_STATES, MediaRunState } from "./media-run-state";

export const MediaRunRow = ({
  run,
  assets,
  selected,
  onSelect,
}: {
  run: MediaRunRecord;
  assets: readonly MediaAssetRecord[];
  selected: boolean;
  onSelect: (runId: string) => void;
}): JSX.Element => {
  const promptId = useId();
  const runtime = isRuntimeRun(run);
  const preview = selectRunPreview(run, assets);
  const outputCount = runtime
    ? countMediaRunOutputs({ executor: run.executor, assets })
    : 0;
  const TaskIcon = assets.some((asset) => asset.kind === "report")
    ? FileText
    : runtime && run.executor === "media-workflow"
      ? Workflow
      : FileImage;
  const content = (
    <>
      <span className="col-span-2 flex min-w-0 items-center gap-3 @min-[680px]:col-span-1 @min-[680px]:gap-4">
        <span
          aria-hidden="true"
          className={cn(
            "flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-lg @min-[680px]:size-16",
            preview
              ? "bg-slate-900 ring-1 ring-inset ring-slate-800"
              : "text-slate-500",
          )}
        >
          {preview ? (
            <MediaAssetPreview
              asset={preview}
              maxEdge={192}
              fit="cover"
              className="h-full w-full"
            />
          ) : (
            <TaskIcon className="size-6" />
          )}
        </span>
        <span className="block min-w-0 flex-1">
          <span
            className="block truncate text-sm font-semibold text-slate-100"
            title={run.flowName}
          >
            {run.flowName}
          </span>
          {run.prompt && run.prompt !== run.flowName ? (
            <span
              id={promptId}
              className="mt-1 block truncate text-sm text-slate-300"
            >
              {run.prompt}
            </span>
          ) : null}
          <span className="mt-1.5 flex min-w-0 items-center gap-2 text-xs text-slate-400">
            {run.modelLabel ? (
              <span className="truncate" title={run.modelLabel}>
                {run.modelLabel}
              </span>
            ) : null}
            {run.target ? (
              <span className="shrink-0 border-l border-slate-700 pl-2 capitalize">
                {run.target}
              </span>
            ) : null}
            {outputCount > 0 ? (
              <span className="shrink-0 border-l border-slate-700 pl-2">
                {outputCount} {outputCount === 1 ? "output" : "outputs"}
              </span>
            ) : null}
          </span>
        </span>
      </span>
      <span className="col-start-1 ml-[68px] min-w-0 @min-[680px]:col-start-auto @min-[680px]:ml-0">
        <MediaRunState run={run} />
      </span>
      <time
        dateTime={run.createdAt}
        title={formatRunDateTime(run.createdAt)}
        className="self-start whitespace-nowrap text-right text-xs tabular-nums text-slate-400 @min-[680px]:self-center"
      >
        {new Intl.DateTimeFormat(undefined, { timeStyle: "short" }).format(
          new Date(run.createdAt),
        )}
      </time>
      {runtime ? (
        <ChevronRight
          aria-hidden="true"
          className="hidden size-4 text-slate-500 group-hover:text-slate-200 @min-[680px]:block"
        />
      ) : null}
    </>
  );
  const className =
    "group grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-3 border-b border-slate-800/70 px-2 py-4 text-left last:border-b-0 @min-[680px]:grid-cols-[minmax(0,1fr)_156px_80px_16px] @min-[680px]:px-3";
  return runtime ? (
    <button
      type="button"
      data-run-id={run.id}
      aria-haspopup="dialog"
      aria-describedby={
        run.prompt && run.prompt !== run.flowName ? promptId : undefined
      }
      aria-label={`Open ${run.flowName}, ${MEDIA_RUN_STATES[run.status].label}, ${formatRunDateTime(run.createdAt)}`}
      onClick={() => onSelect(run.id)}
      className={cn(
        className,
        "cursor-pointer outline-none transition-colors hover:bg-slate-900/60 focus-visible:bg-slate-900 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sky-400",
        selected && "bg-slate-900/60",
      )}
    >
      {content}
    </button>
  ) : (
    <article data-run-id={run.id} className={className}>
      {content}
    </article>
  );
};
