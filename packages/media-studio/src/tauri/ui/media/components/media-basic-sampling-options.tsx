import { MediaBasicVideoOptions } from "./media-basic-video-options";
import type { JSX } from "react";
import type {
  ImageRecipeSettings,
  MediaGenerationTarget,
  MediaModelDescriptor,
  MediaVideoRecipeSettings,
} from "../../../../core/media/contracts.js";
import {
  defaultMediaImageSteps,
  mediaImageSamplingError,
} from "../../../../core/media/image-sampling.js";
import { mediaVideoDimensionsError } from "../../../../core/media/video-quality.js";

const control =
  "h-9 w-full min-w-0 rounded-lg border border-slate-700 bg-slate-950 px-2 text-slate-200 disabled:opacity-50";
const field = "min-w-0 space-y-1 text-xs text-slate-400";

export const MediaBasicSamplingOptions = ({
  target,
  settings,
  videoSettings,
  model,
  onChange,
  onVideoChange,
}: {
  target: MediaGenerationTarget;
  settings: ImageRecipeSettings;
  videoSettings: MediaVideoRecipeSettings;
  model: MediaModelDescriptor | null;
  onChange: (settings: ImageRecipeSettings) => void;
  onVideoChange: (settings: MediaVideoRecipeSettings) => void;
}): JSX.Element => {
  const local = model?.target === "local";
  const architecture = model?.architecture;
  const sampling = settings.sampling ?? {};
  const updateSampling = (patch: Partial<typeof sampling>): void =>
    onChange({ ...settings, sampling: { ...sampling, ...patch } });
  const imageError =
    target === "image"
      ? mediaImageSamplingError(sampling)
      : target === "video"
        ? mediaVideoDimensionsError(videoSettings)
        : null;
  return (
    <div className="grid gap-3 border-t border-slate-800 pt-4 sm:grid-cols-2">
      {target !== "video" ? (
        <label className={field}>
          <span>Quality</span>
          <select
            className={control}
            value={settings.modelPolicy}
            onChange={(event) =>
              onChange({
                ...settings,
                modelPolicy: event.target
                  .value as ImageRecipeSettings["modelPolicy"],
                ...(target === "image"
                  ? {
                      sampling: {
                        ...sampling,
                        numInferenceSteps: null,
                        guidanceScale: null,
                      },
                    }
                  : {}),
              })
            }
          >
            <option value="fast">Draft</option>
            <option value="balanced">Balanced</option>
            <option value="quality">High</option>
          </select>
        </label>
      ) : null}
      {target === "image" ? (
        <label className={field}>
          <span>Format</span>
          <select
            className={control}
            value={settings.outputFormat}
            onChange={(event) =>
              onChange({
                ...settings,
                outputFormat: event.target
                  .value as ImageRecipeSettings["outputFormat"],
              })
            }
          >
            <option value="png">PNG</option>
            <option value="webp" disabled={Boolean(settings.editMask)}>
              WebP
            </option>
            <option
              value="jpeg"
              disabled={
                settings.transparentBackground || Boolean(settings.editMask)
              }
            >
              JPEG
            </option>
          </select>
        </label>
      ) : null}
      {target === "image" && local ? (
        <>
          <label className={field}>
            <span>{settings.editMask ? "Edit resolution" : "Resolution"}</span>
            <select
              className={control}
              value={
                sampling.width != null || sampling.height != null
                  ? "custom"
                  : "auto"
              }
              onChange={(event) =>
                updateSampling(
                  event.target.value === "custom"
                    ? {
                        width: 1024,
                        height:
                          settings.aspectRatio === "1:1"
                            ? 1024
                            : settings.aspectRatio === "4:5"
                              ? 1280
                              : settings.aspectRatio === "16:9"
                                ? 576
                                : 1824,
                      }
                    : { width: null, height: null },
                )
              }
            >
              <option value="auto">Automatic</option>
              <option value="custom">Custom</option>
            </select>
          </label>
          {sampling.width != null || sampling.height != null ? (
            <div className="grid grid-cols-2 gap-2 sm:col-span-2">
              {(["width", "height"] as const).map((key) => (
                <label key={key} className={field}>
                  <span>{key === "width" ? "Width" : "Height"}</span>
                  <input
                    className={control}
                    type="number"
                    min={256}
                    max={2048}
                    step={32}
                    value={sampling[key] ?? ""}
                    onChange={(event) =>
                      updateSampling({
                        [key]:
                          event.target.value === ""
                            ? null
                            : Number(event.target.value),
                      })
                    }
                  />
                </label>
              ))}
            </div>
          ) : null}
          <label className={field}>
            <span>Sampling steps</span>
            <input
              className={control}
              type="number"
              min={1}
              max={100}
              step={1}
              disabled={architecture === "flux-2"}
              value={sampling.numInferenceSteps ?? ""}
              placeholder={String(
                defaultMediaImageSteps(architecture, settings.modelPolicy),
              )}
              onChange={(event) =>
                updateSampling({
                  numInferenceSteps:
                    event.target.value === ""
                      ? null
                      : Number(event.target.value),
                })
              }
            />
          </label>
          {architecture !== "flux-2" && architecture !== "krea-2" ? (
            <label className={field}>
              <span>Guidance</span>
              <input
                className={control}
                type="number"
                min={0}
                max={20}
                step={0.1}
                value={sampling.guidanceScale ?? ""}
                placeholder="Automatic"
                onChange={(event) =>
                  updateSampling({
                    guidanceScale:
                      event.target.value === ""
                        ? null
                        : Number(event.target.value),
                  })
                }
              />
            </label>
          ) : null}
        </>
      ) : null}
      {target === "image" &&
      Object.values(sampling).some((value) => value != null) ? (
        <button
          type="button"
          className="text-left text-xs text-sky-300"
          onClick={() => onChange({ ...settings, sampling: {} })}
        >
          Reset custom sampling
        </button>
      ) : null}
      {target === "video" ? (
        <MediaBasicVideoOptions
          videoSettings={videoSettings}
          model={model}
          onVideoChange={onVideoChange}
        />
      ) : null}
      {(target === "image" &&
        (local ||
          settings.seed != null ||
          (settings.memoryProfile ?? "auto") !== "auto")) ||
      target === "video" ? (
        <>
          <label className={field}>
            <span>Seed</span>
            <input
              className={control}
              type="number"
              min={0}
              max={Number.MAX_SAFE_INTEGER}
              step={1}
              placeholder="Random"
              value={
                (target === "video" ? videoSettings.seed : settings.seed) ?? ""
              }
              onChange={(event) => {
                const seed =
                  event.target.value === "" ? null : Number(event.target.value);
                if (target === "video")
                  onVideoChange({ ...videoSettings, seed });
                else onChange({ ...settings, seed });
              }}
            />
          </label>
          {target === "video" ||
          architecture === "krea-2" ||
          (settings.memoryProfile ?? "auto") !== "auto" ? (
            <label className={field}>
              <span>Memory</span>
              <select
                className={control}
                value={
                  (target === "video"
                    ? videoSettings.memoryProfile
                    : settings.memoryProfile) ?? "auto"
                }
                onChange={(event) => {
                  const memoryProfile = event.target
                    .value as MediaVideoRecipeSettings["memoryProfile"];
                  if (target === "video")
                    onVideoChange({ ...videoSettings, memoryProfile });
                  else onChange({ ...settings, memoryProfile });
                }}
              >
                <option value="auto">Automatic</option>
                <option value="memory-saver">Memory saver</option>
                <option value="balanced">Balanced</option>
                <option value="maximum-speed">Maximum speed</option>
              </select>
            </label>
          ) : null}
        </>
      ) : null}
      {target === "svg" ? (
        <>
          <label className={field}>
            <span>Canvas size</span>
            <input
              className={control}
              type="number"
              min={128}
              max={4096}
              step={1}
              value={settings.svgTargetSize ?? 1024}
              onChange={(event) =>
                onChange({
                  ...settings,
                  svgTargetSize: Number(event.target.value),
                })
              }
            />
          </label>
          {settings.svgMode !== "vectorize" ? (
            <>
              <label className={field}>
                <span>Candidates</span>
                <input
                  className={control}
                  type="number"
                  min={settings.outputCount}
                  max={model?.id.startsWith("recraft:") ? 6 : 16}
                  step={1}
                  value={settings.svgCandidateCount ?? settings.outputCount}
                  onChange={(event) =>
                    onChange({
                      ...settings,
                      svgCandidateCount: Number(event.target.value),
                    })
                  }
                />
              </label>
              <label className={field}>
                <span>Outputs</span>
                <input
                  className={control}
                  type="number"
                  min={1}
                  max={6}
                  step={1}
                  value={settings.outputCount}
                  onChange={(event) =>
                    onChange({
                      ...settings,
                      outputCount: Number(event.target.value),
                      svgCandidateCount: Math.max(
                        settings.svgCandidateCount ?? 1,
                        Number(event.target.value),
                      ),
                    })
                  }
                />
              </label>
            </>
          ) : null}
          <label className={field}>
            <span>Text</span>
            <select
              className={control}
              value={settings.svgTextPolicy ?? "avoid"}
              onChange={(event) =>
                onChange({
                  ...settings,
                  svgTextPolicy: event.target
                    .value as ImageRecipeSettings["svgTextPolicy"],
                })
              }
            >
              <option value="avoid">Avoid text</option>
              <option value="editable">Editable</option>
              <option value="outlines">Outlines</option>
            </select>
          </label>
          {settings.svgMode === "vectorize" ? (
            <label className="flex items-center gap-2 text-xs text-slate-300">
              <input
                type="checkbox"
                checked={settings.svgAutoCrop !== false}
                onChange={(event) =>
                  onChange({ ...settings, svgAutoCrop: event.target.checked })
                }
              />
              Crop to artwork
            </label>
          ) : null}
        </>
      ) : null}
      {imageError ? (
        <p role="alert" className="text-xs text-rose-300 sm:col-span-2">
          {imageError}
        </p>
      ) : null}
    </div>
  );
};
