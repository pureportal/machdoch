import type { ReactNode } from "react";
import type {
  MediaAudioRecipeSettings,
  MediaCompiledPlan,
  MediaModelDescriptor,
} from "../../../../core/media/contracts.js";
import type { MediaGenerationQueueJob } from "../media-generation-queue";
import {
  SUBMIT_SHORTCUT_ACTION_PROPS,
  SubmitShortcut,
} from "../../components/ui/submit-shortcut";
import { Button } from "../../components/ui/button";
import { MediaAudioOptions } from "./media-audio-options";
import { MediaGenerationJobs } from "./media-generation-jobs";
import { MediaAssetPreview } from "./media-visual-preview";
import { MediaSaveAssetButton } from "./media-save-asset-button";

export const MediaAudioGenerateView = ({
  header,
  audioSettings,
  onAudioSettingsChange,
  audioGenerationSupported,
  audioGenerationBlockedReason,
  models,
  plan,
  generationJob,
  generationJobs,
  generationPending,
  onSelectGenerationJob,
  onCancelGeneration,
  onOpenActivity,
  onOpenAssets,
  onGenerate,
}: {
  header: ReactNode;
  audioSettings: MediaAudioRecipeSettings;
  onAudioSettingsChange: (settings: MediaAudioRecipeSettings) => void;
  audioGenerationSupported: boolean;
  audioGenerationBlockedReason: string | null;
  models: readonly MediaModelDescriptor[];
  plan: MediaCompiledPlan;
  generationJob: MediaGenerationQueueJob | null;
  generationJobs: readonly MediaGenerationQueueJob[];
  generationPending: boolean;
  onSelectGenerationJob: (runId: string) => void;
  onCancelGeneration: (runId: string) => void;
  onOpenActivity: (runId: string) => void;
  onOpenAssets: (modelId?: string) => void;
  onGenerate: () => void;
}) => (
  <SubmitShortcut asChild>
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-slate-950">
      {header}
      <div className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto xl:grid-cols-2">
        <section className="space-y-5 border-slate-800 p-6 xl:border-r">
          <MediaAudioOptions
            settings={audioSettings}
            models={models}
            onChange={onAudioSettingsChange}
            onOpenAssets={onOpenAssets}
          />
          {plan.status === "blocked" ? (
            <p role="status" className="text-sm text-slate-400">
              {
                plan.diagnostics.find((entry) => entry.severity === "error")
                  ?.message
              }
            </p>
          ) : null}
          {audioGenerationBlockedReason ? (
            <p role="status" className="text-sm text-slate-400">
              {audioGenerationBlockedReason}
            </p>
          ) : null}
          <Button
            {...SUBMIT_SHORTCUT_ACTION_PROPS}
            disabled={
              plan.status !== "ready" ||
              generationPending ||
              !audioGenerationSupported
            }
            onClick={onGenerate}
          >
            {generationPending ? "Preparing audio" : "Generate audio"}
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
          {generationJob?.assets
            .filter((asset) => asset.kind === "audio")
            .map((asset) => (
              <article
                key={asset.id}
                className="space-y-4 rounded-xl border border-slate-800 p-4"
              >
                <MediaAssetPreview asset={asset} controls />
                <MediaSaveAssetButton asset={asset} />
              </article>
            ))}
        </section>
      </div>
    </div>
  </SubmitShortcut>
);
