import { ImageUp, LoaderCircle, Upload } from "lucide-react";
import { useState } from "react";
import type {
  MediaAssetRecord,
  MediaFlow,
} from "../../../../core/media/contracts.js";
import { mediaAssetLabel } from "../../../../core/media/asset-label.js";
import {
  MEDIA_UPSCALERS,
  createMediaUpscaleFlow,
} from "../../../../core/media/upscale.js";
import { Button } from "../../components/ui/button";
import { EmptyState } from "../../components/ui/empty-state";
import { AppNotification } from "../../components/ui/notification";
import { cn } from "../../lib/utils";
import type { MediaGenerationQueueJob } from "../media-generation-queue";
import { invoke } from "../media-platform";
import { normalizeMediaError } from "../media-runtime";
import { MediaAssetBrowser } from "./media-asset-browser";
import { MediaGenerationJobs } from "./media-generation-jobs";
import {
  MediaUpscaleOptions,
  type MediaUpscaleOptionsValue,
} from "./media-upscale-options";
import { MediaUpscalePreview } from "./media-upscale-preview";
import {
  DEFAULT_UPSCALE_SETTINGS,
  estimateUpscaleMemory,
  resolveUpscaleSize,
  validateUpscaleSettings,
} from "../../../../core/media/upscale-settings.js";

export function MediaUpscaleView({
  assets,
  selectedAssetId,
  onSelectAsset,
  ready,
  memoryBytes,
  onRun,
  onOpenFlow,
  jobs,
  onCancel,
  onImport,
  onOpenActivity,
}: {
  assets: readonly MediaAssetRecord[];
  selectedAssetId: string | null;
  onSelectAsset: (id: string) => void;
  ready: boolean;
  memoryBytes: number | null;
  onRun: (flow: MediaFlow) => Promise<string>;
  onOpenFlow: (flow: MediaFlow) => void;
  jobs: readonly MediaGenerationQueueJob[];
  onCancel: (id: string) => void;
  onImport: () => Promise<MediaAssetRecord | null>;
  onOpenActivity: (id: string) => void;
}) {
  const [options, setOptions] = useState<MediaUpscaleOptionsValue>({
    modelId: MEDIA_UPSCALERS[0].id,
    customPath: "",
    ...DEFAULT_UPSCALE_SETTINGS,
  });
  const { modelId, customPath, ...settings } = options;
  const [busy, setBusy] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false);
  const source = assets.find((asset) => asset.id === selectedAssetId);
  const visualAssets = assets.filter(
    (asset) => asset.kind === "image" || asset.kind === "video",
  );
  const job = jobs.find((item) => item.id === runId);
  const pending = Boolean(
    job && ["queued", "running", "canceling"].includes(job.status),
  );
  const locked = busy || importing || pending;
  const jobError =
    job?.failure?.code === "MODEL_NOT_INSTALLED"
      ? "The model file is missing. Choose another model or browse to its file."
      : (job?.failure?.message ?? job?.error);
  const settingsError = validateUpscaleSettings(options);
  const estimate =
    source && !settingsError
      ? estimateUpscaleMemory({
          width: source.width,
          height: source.height,
          modelId,
          settings: options,
          memoryBytes,
        })
      : null;
  const outputSize = source
    ? resolveUpscaleSize(source.width, source.height, options)
    : null;
  const tooLarge = Boolean(
    estimate?.tooLarge ||
    (source?.kind === "video" &&
      outputSize &&
      outputSize.width * outputSize.height > 16_000_000),
  );
  const canPrepare = Boolean(
    source &&
    !locked &&
    !settingsError &&
    !tooLarge &&
    (modelId !== "custom" || customPath.trim()),
  );
  const resultAssets =
    job?.status === "completed"
      ? job.assets.filter(
          (asset) =>
            asset.operation?.kind === "workflow" &&
            asset.operation.details.finalOutput === true,
        )
      : [];
  const selectAsset = (id: string) => {
    onSelectAsset(id);
    setChoosing(false);
    setRunId(null);
    setError(null);
  };
  const importMedia = async () => {
    setImporting(true);
    setError(null);
    try {
      const asset = await onImport();
      if (asset) selectAsset(asset.id);
    } catch (failure) {
      setError(normalizeMediaError(failure, "import_media").message);
    } finally {
      setImporting(false);
    }
  };
  const prepare = async (advanced: boolean) => {
    if (!source || !canPrepare) return;
    setBusy(true);
    setError(null);
    try {
      const modelPath =
        modelId === "custom"
          ? customPath.trim()
          : await invoke<string>("media_install_workflow_model", {
              kind: modelId,
            });
      const flow = createMediaUpscaleFlow({
        asset: source,
        modelPath,
        settings,
        id: `upscale-${crypto.randomUUID()}`,
        createdAt: new Date().toISOString(),
      });
      if (advanced) onOpenFlow(flow);
      else setRunId(await onRun(flow));
    } catch (failure) {
      setError(normalizeMediaError(failure, "upscale").message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="@container/upscale h-full min-w-0 overflow-y-auto bg-slate-950">
      <header className="border-b border-slate-800 px-5 py-4">
        <h1 className="text-lg font-semibold text-slate-100">Upscale</h1>
      </header>
      <div className="grid min-w-0 @min-[48rem]/upscale:grid-cols-[20rem_minmax(0,1fr)]">
        <section
          aria-label="Upscale settings"
          className="min-w-0 border-b border-slate-800 @min-[48rem]/upscale:border-r @min-[48rem]/upscale:border-b-0"
        >
          <div className="space-y-6 p-5">
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-sm font-medium text-slate-200">
                  Image or video
                </h2>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={locked}
                  onClick={() => void importMedia()}
                >
                  {importing ? (
                    <LoaderCircle aria-hidden="true" className="animate-spin" />
                  ) : (
                    <Upload aria-hidden="true" />
                  )}
                  Import media
                </Button>
              </div>
              {source ? (
                <div className="flex min-w-0 items-center gap-3 rounded-xl border border-slate-800 bg-slate-900/50 p-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-slate-200">
                      {mediaAssetLabel(source)}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={locked}
                    aria-expanded={choosing}
                    aria-controls={
                      choosing ? "upscale-media-picker" : undefined
                    }
                    onClick={() => setChoosing(!choosing)}
                  >
                    {choosing ? "Close selection" : "Change media"}
                  </Button>
                </div>
              ) : null}
            </div>
            <MediaUpscaleOptions
              value={options}
              onChange={setOptions}
              source={source}
              disabled={locked}
              estimate={estimate}
              memoryBytes={memoryBytes}
              canOpenFlow={canPrepare}
              onOpenFlow={() => void prepare(true)}
              onError={setError}
            />
          </div>
          <footer className="space-y-3 border-t border-slate-800 p-5">
            {settingsError ? (
              <p role="alert" className="text-xs text-rose-300">
                {settingsError}
              </p>
            ) : null}
            {estimate?.warning ? (
              <p role="status" className="text-xs text-amber-300">
                GPU memory may be insufficient.{" "}
                {options.tileMode === "automatic"
                  ? "Close GPU applications before upscaling."
                  : "Use Automatic or smaller tiles."}
              </p>
            ) : null}
            {tooLarge ? (
              <p role="alert" className="text-xs text-rose-300">
                Output is too large. Reduce the scale or minimum size, or resize
                the source.
              </p>
            ) : null}
            {error || jobError ? (
              <AppNotification
                tone="error"
                title={error ?? jobError}
                dismissAfterMs={null}
              >
                {null}
              </AppNotification>
            ) : null}
            <Button
              className="h-12 w-full bg-sky-500 text-base font-semibold text-slate-950 hover:bg-sky-400 disabled:bg-slate-800 disabled:text-slate-500"
              disabled={!ready || !canPrepare}
              onClick={() => void prepare(false)}
            >
              {busy || pending ? (
                <LoaderCircle aria-hidden="true" className="animate-spin" />
              ) : (
                <ImageUp aria-hidden="true" />
              )}
              {busy ? "Preparing upscale…" : pending ? "Upscaling…" : "Upscale"}
            </Button>
            {!ready ? (
              <p className="text-center text-xs text-slate-500">
                Set up the media runtime to upscale.
              </p>
            ) : null}
          </footer>
        </section>
        <section
          aria-label="Upscale workspace"
          className="@container/previews min-w-0 space-y-5 p-5"
        >
          {job ? (
            <MediaGenerationJobs
              jobs={[job]}
              selectedJobId={job.id}
              onSelect={setRunId}
              onOpenActivity={onOpenActivity}
              onCancel={onCancel}
            />
          ) : null}
          {(!source || choosing) && visualAssets.length > 0 ? (
            <div id="upscale-media-picker" className="space-y-3">
              <h2 className="text-sm font-medium text-slate-200">
                Choose media
              </h2>
              <MediaAssetBrowser
                compact
                assets={visualAssets}
                metadata={{}}
                categories={[]}
                selectedIds={selectedAssetId ? [selectedAssetId] : []}
                onSelect={(asset) => selectAsset(asset.id)}
                disabledReason={() =>
                  locked ? "Wait for the upscale to finish." : undefined
                }
                label="media"
              />
            </div>
          ) : source ? (
            <div
              className={cn(
                "grid items-start gap-4",
                resultAssets.length > 0 && "@min-[38rem]/previews:grid-cols-2",
              )}
            >
              <MediaUpscalePreview asset={source} title="Source" />
              {resultAssets.map((asset) => (
                <MediaUpscalePreview
                  key={asset.id}
                  asset={asset}
                  title="Result"
                  onUpscale={() => selectAsset(asset.id)}
                />
              ))}
            </div>
          ) : (
            <EmptyState
              icon={ImageUp}
              title="Import an image or video"
              size="large"
            />
          )}
        </section>
      </div>
    </div>
  );
}
