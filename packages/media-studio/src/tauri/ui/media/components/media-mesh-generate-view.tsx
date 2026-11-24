import { useState, type JSX, type ReactNode } from "react";
import { ImagePlus, Images, X } from "lucide-react";
import {
  MEDIA_MESH_VIEWS,
  type MediaAssetCategory,
  type MediaAssetRecord,
  type MediaCompiledPlan,
  type MediaGenerationAssetMetadata,
  type MediaMeshRecipeSettings,
  type MediaMeshView,
  type MediaModelDescriptor,
} from "../../../../core/media/contracts.js";
import {
  MEDIA_MESH_VIEW_LABELS,
  mediaMeshModelProfile,
} from "../../../../core/media/mesh-flow.js";
import { MESH_GENERATION_FIELDS } from "../../../../core/media/mesh-nodes.js";
import { LOCAL_BIREFNET_MODEL_ID } from "../../../../core/media/model-install.js";
import { isMediaModelReady } from "../../../../core/media/model-readiness.js";
import { workerFailureSummary } from "../../../../core/media/worker-failure.js";
import type { MediaGenerationQueueJob } from "../media-generation-queue";
import {
  SubmitShortcut,
} from "../../components/ui/submit-shortcut";
import { Button } from "../../components/ui/button";
import { ControlTooltip } from "../../components/ui/tooltip";
import { cn } from "../../lib/utils";
import { Media3dGenerateButton } from "./media-3d-generate-button";
import { Media3dModelPicker } from "./media-3d-model-picker";
import { Media3dViewer } from "./media-3d-viewer";
import { MediaAssetBrowser } from "./media-asset-browser";
import { MediaGenerationJobs } from "./media-generation-jobs";
import { MediaModelInstallButton } from "./media-model-install-button";
import { MediaParameterFields } from "./media-parameter-controls";
import { MediaSaveAssetButton } from "./media-save-asset-button";
import { MediaAssetPreview } from "./media-visual-preview";

const PARAMETER_FIELDS = MESH_GENERATION_FIELDS.filter((field) => field.id !== "modelId");

const iconButtonClass =
  "inline-flex size-8 items-center justify-center rounded-md bg-slate-950/85 text-slate-200 hover:bg-slate-800 disabled:opacity-40";

const ViewSlot = ({
  view,
  asset,
  importDisabled,
  browsing,
  canBrowse,
  onImport,
  onBrowse,
  onRemove,
}: {
  view: MediaMeshView;
  asset: MediaAssetRecord | null;
  importDisabled: boolean;
  browsing: boolean;
  canBrowse: boolean;
  onImport: () => void;
  onBrowse: () => void;
  onRemove: () => void;
}): JSX.Element => {
  const label = MEDIA_MESH_VIEW_LABELS[view];
  return (
    <div
      data-mesh-view={view}
      className={cn(
        "group relative aspect-square overflow-hidden rounded-xl border bg-slate-950",
        browsing ? "border-violet-400" : asset ? "border-slate-700" : "border-dashed border-slate-700",
      )}
    >
      {asset ? (
        <MediaAssetPreview asset={asset} fit="contain" maxEdge={512} className="h-full w-full bg-transparent" />
      ) : (
        <button
          type="button"
          aria-label={`Add ${label.toLowerCase()} view`}
          disabled={importDisabled}
          onClick={onImport}
          className="flex h-full w-full flex-col items-center justify-center gap-2 text-slate-400 hover:text-violet-200 disabled:opacity-40"
        >
          <ImagePlus className="h-5 w-5" />
        </button>
      )}
      <span className="pointer-events-none absolute top-2 left-2 rounded-md bg-slate-950/85 px-2 py-0.5 text-xs font-medium text-slate-200">
        {label}
      </span>
      <div
        className={cn(
          "absolute top-2 right-2 flex gap-1",
          asset && "opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100",
        )}
      >
        {canBrowse ? (
          <ControlTooltip content="Choose from Assets">
            <button
              type="button"
              aria-label={`Choose ${label.toLowerCase()} view from Assets`}
              aria-pressed={browsing}
              onClick={onBrowse}
              className={iconButtonClass}
            >
              <Images className="h-4 w-4" />
            </button>
          </ControlTooltip>
        ) : null}
        {asset ? (
          <>
            <ControlTooltip content="Replace image">
              <button
                type="button"
                aria-label={`Replace ${label.toLowerCase()} view`}
                disabled={importDisabled}
                onClick={onImport}
                className={iconButtonClass}
              >
                <ImagePlus className="h-4 w-4" />
              </button>
            </ControlTooltip>
            <ControlTooltip content="Remove image">
              <button
                type="button"
                aria-label={`Remove ${label.toLowerCase()} view`}
                onClick={onRemove}
                className={iconButtonClass}
              >
                <X className="h-4 w-4" />
              </button>
            </ControlTooltip>
          </>
        ) : null}
      </div>
    </div>
  );
};

const MeshJobPreview = ({
  job,
  frontAsset,
  onOpenResult,
}: {
  job: MediaGenerationQueueJob;
  frontAsset: MediaAssetRecord | null;
  onOpenResult: (asset: MediaAssetRecord) => void;
}): JSX.Element | null => {
  const result = job.assets.find((asset) => asset.kind === "mesh");
  if (result)
    return (
      <article className="space-y-3">
        <Media3dViewer asset={result} className="aspect-square max-h-[min(70dvh,720px)] w-full" />
        <div className="flex flex-wrap gap-2">
          <MediaSaveAssetButton asset={result} />
          <Button variant="outline" size="sm" onClick={() => onOpenResult(result)}>
            Open in Library
          </Button>
        </div>
      </article>
    );
  const active = ["queued", "running", "canceling"].includes(job.status);
  if (!active && !job.error) return null;
  return (
    <article className="relative aspect-square max-h-[min(70dvh,720px)] w-full overflow-hidden rounded-lg border border-slate-800 bg-slate-950">
      {frontAsset ? (
        <MediaAssetPreview
          asset={frontAsset}
          fit="contain"
          className={cn("h-full w-full bg-transparent transition-opacity", active ? "opacity-40" : "opacity-20")}
        />
      ) : null}
      {active ? (
        <div aria-hidden className="pointer-events-none absolute inset-0 animate-pulse bg-gradient-to-b from-transparent via-violet-500/10 to-transparent" />
      ) : null}
      <div className="absolute inset-x-6 bottom-6 space-y-2">
        {active ? (
          <>
            <p role="status" className="flex justify-between text-sm text-slate-200">
              <span>{job.currentStep}</span>
              <span className="tabular-nums text-slate-400">{Math.round(job.progress * 100)}%</span>
            </p>
            <span className="block h-1.5 overflow-hidden rounded-full bg-slate-800">
              <span
                className="block h-full rounded-full bg-violet-400 transition-[width] duration-500"
                style={{ width: `${Math.max(3, job.progress * 100)}%` }}
              />
            </span>
          </>
        ) : (
          <p role="alert" className="text-sm text-rose-300">
            {job.error ? workerFailureSummary(job.error) : null}
          </p>
        )}
      </div>
    </article>
  );
};

export const MediaMeshGenerateView = ({
  header,
  settings,
  onSettingsChange,
  generationSupported,
  generationBlockedReason,
  models,
  selectedModel,
  onSelectModel,
  onModelInstalled,
  plan,
  imageAssets,
  assetMetadata,
  categories,
  imageImportSupported,
  imageImportPending,
  generationJob,
  generationJobs,
  generationPending,
  onAddImage,
  onSelectGenerationJob,
  onCancelGeneration,
  onOpenActivity,
  onOpenResult,
  onGenerate,
}: {
  header: ReactNode;
  settings: MediaMeshRecipeSettings;
  onSettingsChange: (settings: MediaMeshRecipeSettings) => void;
  generationSupported: boolean;
  generationBlockedReason: string | null;
  models: readonly MediaModelDescriptor[];
  selectedModel: MediaModelDescriptor | null;
  onSelectModel: (model: MediaModelDescriptor) => void;
  onModelInstalled: () => Promise<void>;
  plan: MediaCompiledPlan;
  imageAssets: readonly MediaAssetRecord[];
  assetMetadata: Readonly<Record<string, MediaGenerationAssetMetadata>>;
  categories: readonly MediaAssetCategory[];
  imageImportSupported: boolean;
  imageImportPending: boolean;
  generationJob: MediaGenerationQueueJob | null;
  generationJobs: readonly MediaGenerationQueueJob[];
  generationPending: boolean;
  onAddImage: (view: MediaMeshView) => void;
  onSelectGenerationJob: (runId: string) => void;
  onCancelGeneration: (runId: string) => void;
  onOpenActivity: (runId: string) => void;
  onOpenResult: (asset: MediaAssetRecord) => void;
  onGenerate: () => void;
}): JSX.Element => {
  const [browsingView, setBrowsingView] = useState<MediaMeshView | null>(null);
  const profile = mediaMeshModelProfile(selectedModel);
  const assetFor = (assetId: string | undefined): MediaAssetRecord | null =>
    assetId ? (imageAssets.find((asset) => asset.id === assetId) ?? null) : null;
  const jobFront = assetFor(generationJob?.recipe.meshSettings?.viewAssetIds.front);
  const cutoutModel = models.find((model) => model.id === LOCAL_BIREFNET_MODEL_ID);
  const cutoutMissing =
    settings.removeBackground && cutoutModel !== undefined && !isMediaModelReady(cutoutModel);
  const blockingDiagnostic = plan.diagnostics.find((entry) => entry.severity === "error");
  const blocked =
    blockingDiagnostic?.code === "MODEL_NOT_READY"
      ? null
      : (blockingDiagnostic?.message ?? generationBlockedReason);
  const setView = (view: MediaMeshView, assetId: string | null): void => {
    const viewAssetIds = { ...settings.viewAssetIds };
    if (assetId) viewAssetIds[view] = assetId;
    else delete viewAssetIds[view];
    onSettingsChange({ ...settings, viewAssetIds });
  };

  return (
    <SubmitShortcut asChild>
      <div className="flex h-full min-h-0 flex-col overflow-hidden bg-slate-950">
        {header}
        <div className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto xl:grid-cols-[minmax(380px,0.9fr)_minmax(420px,1.1fr)]">
          <section className="space-y-6 border-slate-800 p-6 xl:border-r">
            <Media3dModelPicker
              models={models}
              selectedModelId={selectedModel?.id ?? null}
              onSelect={onSelectModel}
              onInstalled={onModelInstalled}
            />
            <section className="space-y-2">
              <h2 className="text-sm font-medium text-slate-200">Views</h2>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {MEDIA_MESH_VIEWS.map((view) => (
                  <ViewSlot
                    key={view}
                    view={view}
                    asset={assetFor(settings.viewAssetIds[view])}
                    importDisabled={!imageImportSupported || imageImportPending}
                    browsing={browsingView === view}
                    canBrowse={imageAssets.length > 0}
                    onImport={() => onAddImage(view)}
                    onBrowse={() => setBrowsingView((current) => (current === view ? null : view))}
                    onRemove={() => setView(view, null)}
                  />
                ))}
              </div>
              {browsingView ? (
                <MediaAssetBrowser
                  assets={imageAssets}
                  metadata={assetMetadata}
                  categories={categories}
                  selectedIds={settings.viewAssetIds[browsingView] ? [settings.viewAssetIds[browsingView]] : []}
                  onSelect={(asset) => {
                    setView(browsingView, asset.id);
                    setBrowsingView(null);
                  }}
                />
              ) : null}
            </section>

            <MediaParameterFields
              idPrefix="mesh"
              fields={PARAMETER_FIELDS}
              values={settings}
              onChange={onSettingsChange}
              overrides={{ numInferenceSteps: { recommended: profile.stepsRecommended } }}
            />

            {cutoutModel && cutoutMissing ? (
              <div className="flex items-center justify-between gap-3 rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-2.5 text-sm text-slate-300">
                <span>Views with busy backgrounds need {cutoutModel.displayName} for a clean cutout.</span>
                <MediaModelInstallButton
                  model={cutoutModel}
                  onInstalled={onModelInstalled}
                  variant="outline"
                  size="sm"
                >
                  Install
                </MediaModelInstallButton>
              </div>
            ) : null}

            {blocked ? (
              <p role="status" className="text-sm text-slate-400">
                {blocked}
              </p>
            ) : null}
            <Media3dGenerateButton
              model={selectedModel}
              disabled={plan.status !== "ready" || generationPending || !generationSupported}
              pending={generationPending}
              onGenerate={onGenerate}
              onModelInstalled={onModelInstalled}
            />
          </section>
          <section className="space-y-4 p-6">
            <MediaGenerationJobs
              jobs={generationJobs}
              selectedJobId={generationJob?.id ?? null}
              onSelect={onSelectGenerationJob}
              onCancel={onCancelGeneration}
              onOpenActivity={onOpenActivity}
            />
            {generationJob ? (
              <MeshJobPreview job={generationJob} frontAsset={jobFront} onOpenResult={onOpenResult} />
            ) : null}
          </section>
        </div>
      </div>
    </SubmitShortcut>
  );
};
