import { useState, type JSX, type ReactNode } from "react";
import { Box, ChevronDown, ImagePlus, LoaderCircle, X } from "lucide-react";
import type {
  MediaAssetCategory,
  MediaAssetRecord,
  MediaCompiledPlan,
  MediaGenerationAssetMetadata,
  MediaModelDescriptor,
  MediaSplatRecipeSettings,
} from "../../../../core/media/contracts.js";
import { isMediaModelReady } from "../../../../core/media/model-readiness.js";
import { isMediaSplatModel } from "../../../../core/media/splat-flow.js";
import type { MediaGenerationQueueJob } from "../media-generation-queue";
import {
  SUBMIT_SHORTCUT_ACTION_PROPS,
  SubmitShortcut,
} from "../../components/ui/submit-shortcut";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { ControlTooltip } from "../../components/ui/tooltip";
import { cn } from "../../lib/utils";
import { MediaAssetBrowser } from "./media-asset-browser";
import { MediaGenerationJobs } from "./media-generation-jobs";
import { MediaSaveAssetButton } from "./media-save-asset-button";
import { MediaSplatViewer } from "./media-splat-viewer";
import { MediaAssetPreview } from "./media-visual-preview";

const DETAIL_PRESETS = [
  { count: 131_072, label: "Light", short: "131K" },
  { count: 262_144, label: "Standard", short: "262K" },
  { count: 524_288, label: "High", short: "524K" },
  { count: 1_048_576, label: "Max", short: "1M" },
] as const;

const INPUT_KINDS = [
  { value: "synthetic", label: "Render" },
  { value: "real", label: "Photo" },
] as const;

const segmentClass = (active: boolean): string =>
  cn(
    "rounded-lg px-3 py-2 text-sm font-medium transition-colors",
    active ? "bg-slate-700 text-white" : "text-slate-400 hover:text-slate-100",
  );

const SplatJobPreview = ({
  job,
  sourceAsset,
  onOpenResult,
}: {
  job: MediaGenerationQueueJob;
  sourceAsset: MediaAssetRecord | null;
  onOpenResult: (asset: MediaAssetRecord) => void;
}): JSX.Element | null => {
  const result = job.assets.find((asset) => asset.kind === "splat");
  if (result)
    return (
      <article className="space-y-3">
        <MediaSplatViewer asset={result} className="aspect-square max-h-[min(70dvh,720px)] w-full" />
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
      {sourceAsset ? (
        <MediaAssetPreview
          asset={sourceAsset}
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
            {job.error}
          </p>
        )}
      </div>
    </article>
  );
};

export const MediaSplatGenerateView = ({
  header,
  settings,
  onSettingsChange,
  generationSupported,
  generationBlockedReason,
  models,
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
  onOpenAssets,
  onOpenResult,
  onGenerate,
}: {
  header: ReactNode;
  settings: MediaSplatRecipeSettings;
  onSettingsChange: (settings: MediaSplatRecipeSettings) => void;
  generationSupported: boolean;
  generationBlockedReason: string | null;
  models: readonly MediaModelDescriptor[];
  plan: MediaCompiledPlan;
  imageAssets: readonly MediaAssetRecord[];
  assetMetadata: Readonly<Record<string, MediaGenerationAssetMetadata>>;
  categories: readonly MediaAssetCategory[];
  imageImportSupported: boolean;
  imageImportPending: boolean;
  generationJob: MediaGenerationQueueJob | null;
  generationJobs: readonly MediaGenerationQueueJob[];
  generationPending: boolean;
  onAddImage: () => void;
  onSelectGenerationJob: (runId: string) => void;
  onCancelGeneration: (runId: string) => void;
  onOpenActivity: (runId: string) => void;
  onOpenAssets: (modelId?: string) => void;
  onOpenResult: (asset: MediaAssetRecord) => void;
  onGenerate: () => void;
}): JSX.Element => {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const splatModels = models.filter(isMediaSplatModel);
  const ready = splatModels.some(isMediaModelReady);
  const installing = splatModels.some((model) =>
    ["queued", "downloading", "verifying", "activating"].includes(model.installationStatus),
  );
  const sourceAsset =
    imageAssets.find((asset) => asset.id === settings.sourceAssetId) ?? null;
  const jobSource =
    imageAssets.find(
      (asset) => asset.id === generationJob?.recipe.splatSettings?.sourceAssetId,
    ) ?? null;
  const blockingDiagnostic = plan.diagnostics.find((entry) => entry.severity === "error");
  const blocked =
    installing && blockingDiagnostic?.code === "MODEL_NOT_READY"
      ? null
      : (blockingDiagnostic?.message ?? generationBlockedReason);
  const update = (patch: Partial<MediaSplatRecipeSettings>): void =>
    onSettingsChange({ ...settings, ...patch });
  const numberField = (
    key: "numInferenceSteps" | "guidanceScale" | "timeShift" | "minOpacity" | "gaussianCount" | "seed",
    label: string,
    min: number,
    max: number,
    step: number,
  ): JSX.Element => (
    <label key={key} className="block space-y-1.5 text-sm text-slate-200">
      <span>{label}</span>
      <Input
        aria-label={label}
        type="number"
        min={min}
        max={max}
        step={step}
        placeholder={key === "seed" ? "Random" : undefined}
        value={settings[key] ?? ""}
        onChange={(event) =>
          update({
            [key]:
              key === "seed" && !event.target.value
                ? null
                : event.target.valueAsNumber,
          })
        }
      />
    </label>
  );

  return (
    <SubmitShortcut asChild>
      <div className="flex h-full min-h-0 flex-col overflow-hidden bg-slate-950">
        {header}
        <div className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto xl:grid-cols-[minmax(380px,0.9fr)_minmax(420px,1.1fr)]">
          <section className="space-y-6 border-slate-800 p-6 xl:border-r">
            <section className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-sm font-medium text-slate-200">Object image</h2>
                {imageAssets.length > 0 ? (
                  <button
                    type="button"
                    aria-expanded={pickerOpen}
                    onClick={() => setPickerOpen((open) => !open)}
                    className="shrink-0 rounded-lg border border-slate-700 px-3 py-2 text-sm font-medium text-sky-300 hover:bg-slate-800 hover:text-sky-200"
                  >
                    {pickerOpen ? "Close" : "Choose from Assets"}
                  </button>
                ) : null}
              </div>
              {sourceAsset ? (
                <div className="group relative overflow-hidden rounded-xl border border-slate-700 bg-slate-950">
                  <MediaAssetPreview
                    asset={sourceAsset}
                    fit="contain"
                    maxEdge={768}
                    className="h-64 w-full bg-transparent"
                  />
                  <div className="absolute top-2 right-2 flex gap-1">
                    <Button
                      size="icon-sm"
                      variant="secondary"
                      aria-label="Replace image"
                      disabled={!imageImportSupported || imageImportPending}
                      onClick={onAddImage}
                    >
                      <ImagePlus />
                    </Button>
                    <ControlTooltip content="Remove image">
                      <button
                        type="button"
                        aria-label="Remove image"
                        onClick={() => update({ sourceAssetId: null })}
                        className="inline-flex size-8 items-center justify-center rounded-md bg-slate-950/85 text-slate-200 hover:bg-slate-800"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </ControlTooltip>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={onAddImage}
                  disabled={!imageImportSupported || imageImportPending}
                  className="flex h-64 w-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-slate-700 text-slate-400 hover:border-violet-400 hover:text-violet-200 disabled:opacity-40"
                >
                  <ImagePlus className="h-6 w-6" />
                  <span className="text-sm">Add image</span>
                </button>
              )}
              {pickerOpen ? (
                <MediaAssetBrowser
                  assets={imageAssets}
                  metadata={assetMetadata}
                  categories={categories}
                  selectedIds={settings.sourceAssetId ? [settings.sourceAssetId] : []}
                  onSelect={(asset) => {
                    update({ sourceAssetId: asset.id });
                    setPickerOpen(false);
                  }}
                />
              ) : null}
            </section>

            <div className="space-y-2">
              <span className="block text-sm font-medium text-slate-200">Image type</span>
              <div role="group" aria-label="Image type" className="inline-grid grid-cols-2 rounded-xl border border-slate-800 bg-slate-900/70 p-1">
                {INPUT_KINDS.map((kind) => (
                  <button
                    key={kind.value}
                    type="button"
                    aria-pressed={settings.inputKind === kind.value}
                    onClick={() => update({ inputKind: kind.value })}
                    className={segmentClass(settings.inputKind === kind.value)}
                  >
                    {kind.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-2">
              <span className="block text-sm font-medium text-slate-200">Detail</span>
              <div role="group" aria-label="Detail" className="grid grid-cols-4 rounded-xl border border-slate-800 bg-slate-900/70 p-1">
                {DETAIL_PRESETS.map((preset) => (
                  <button
                    key={preset.count}
                    type="button"
                    aria-pressed={settings.gaussianCount === preset.count}
                    onClick={() => update({ gaussianCount: preset.count })}
                    className={cn(segmentClass(settings.gaussianCount === preset.count), "flex flex-col items-center leading-tight")}
                  >
                    <span>{preset.label}</span>
                    <span className="text-[11px] font-normal text-slate-400">{preset.short}</span>
                  </button>
                ))}
              </div>
            </div>

            {!ready ? (
              <Button variant="outline" onClick={() => onOpenAssets(splatModels[0]?.id)}>
                {installing ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Box className="h-4 w-4" />}
                {installing ? "Installing Idol" : "Install Idol"}
              </Button>
            ) : null}

            <section className="rounded-xl border border-slate-800">
              <button
                type="button"
                aria-expanded={optionsOpen}
                onClick={() => setOptionsOpen((open) => !open)}
                className="flex w-full items-center justify-between px-4 py-3 text-sm font-medium text-slate-200"
              >
                Options
                <ChevronDown className={cn("h-4 w-4 transition-transform", optionsOpen && "rotate-180")} />
              </button>
              {optionsOpen ? (
                <div className="grid gap-4 border-t border-slate-800 p-4 sm:grid-cols-2">
                  {numberField("gaussianCount", "Gaussians", 32_768, 1_048_576, 32_768)}
                  {numberField("minOpacity", "Cleanup", 0, 0.5, 0.01)}
                  {numberField("numInferenceSteps", "Steps", 4, 100, 1)}
                  {numberField("guidanceScale", "Guidance", 0, 10, 0.1)}
                  {numberField("timeShift", "Time shift", 1, 6, 0.1)}
                  {numberField("seed", "Seed", 0, Number.MAX_SAFE_INTEGER, 1)}
                </div>
              ) : null}
            </section>

            {blocked ? (
              <p role="status" className="text-sm text-slate-400">
                {blocked}
              </p>
            ) : null}
            <Button
              {...SUBMIT_SHORTCUT_ACTION_PROPS}
              className="w-full"
              disabled={plan.status !== "ready" || generationPending || !generationSupported}
              onClick={onGenerate}
            >
              <Box className="h-4 w-4" />
              {generationPending ? "Preparing" : "Generate 3D"}
            </Button>
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
              <SplatJobPreview job={generationJob} sourceAsset={jobSource} onOpenResult={onOpenResult} />
            ) : null}
          </section>
        </div>
      </div>
    </SubmitShortcut>
  );
};
