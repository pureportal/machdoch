import { useSyncExternalStore, type JSX } from "react";
import { Download, LoaderCircle } from "lucide-react";
import type { MediaModelDescriptor } from "../../../../core/media/contracts.js";
import { isMediaModelReady } from "../../../../core/media/model-readiness.js";
import { isMediaMeshModel } from "../../../../core/media/mesh-flow.js";
import { isMediaSplatModel } from "../../../../core/media/splat-flow.js";
import { cn } from "../../lib/utils";
import {
  isMediaModelInstallJobActive,
  mediaDownloadMonitor,
} from "../media-download-monitor";

export const listMedia3dModels = (
  models: readonly MediaModelDescriptor[],
): MediaModelDescriptor[] =>
  models.filter((model) => isMediaSplatModel(model) || isMediaMeshModel(model));

export const Media3dModelPicker = ({
  models,
  selectedModelId,
  onSelect,
}: {
  models: readonly MediaModelDescriptor[];
  selectedModelId: string | null;
  onSelect: (model: MediaModelDescriptor) => void;
}): JSX.Element | null => {
  const { installJobs } = useSyncExternalStore(
    mediaDownloadMonitor.subscribe,
    mediaDownloadMonitor.getSnapshot,
  );
  const choices = listMedia3dModels(models);
  if (choices.length === 0) return null;
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-medium text-slate-200">Model</h2>
      <div role="radiogroup" aria-label="3D model" className="grid gap-2 sm:grid-cols-3">
        {choices.map((model) => {
          const ready = isMediaModelReady(model);
          const installing = installJobs.some(
            (job) => job.modelId === model.id && isMediaModelInstallJobActive(job),
          );
          const selected = model.id === selectedModelId;
          return (
            <button
              key={model.id}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => onSelect(model)}
              className={cn(
                "flex min-w-0 flex-col items-start gap-1 rounded-xl border px-3 py-2.5 text-left transition-colors",
                selected
                  ? "border-violet-400/70 bg-violet-500/10 text-white"
                  : "border-slate-800 bg-slate-900/60 text-slate-300 hover:border-slate-600 hover:text-slate-100",
              )}
            >
              <span className="w-full text-sm font-medium leading-snug break-words">{model.displayName}</span>
              {ready ? null : (
                <span className="flex items-center gap-1 text-xs text-slate-400">
                  {installing ? (
                    <LoaderCircle className="size-3 animate-spin" />
                  ) : (
                    <Download className="size-3" />
                  )}
                  {model.expectedDownloadGb ? `${model.expectedDownloadGb.toFixed(1)} GB` : "Download"}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </section>
  );
};
