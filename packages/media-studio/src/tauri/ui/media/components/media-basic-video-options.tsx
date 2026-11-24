import type { JSX } from "react";
import { MediaParameterLabel } from "./media-parameter-controls";
import { MEDIA_PARAMETER_DESCRIPTIONS } from "../../../../core/media/parameter-descriptions.js";
import type {
  MediaModelDescriptor,
  MediaVideoRecipeSettings,
} from "../../../../core/media/contracts.js";
import {
  mediaVideoOutputFrameCount,
  resolveMediaVideoDimensions,
  resolveMediaVideoFrameContract,
  resolveMediaVideoSpatialMultiple,
} from "../../../../core/media/video-quality.js";
import { openMediaModelProfile } from "../../../../core/media/open-model-profiles.js";

const control =
  "h-9 w-full min-w-0 rounded-lg border border-slate-700 bg-slate-950 px-2 text-slate-200 disabled:opacity-50";
const field = "min-w-0 space-y-1 text-xs text-slate-400";

export const MediaBasicVideoOptions = ({
  videoSettings,
  model,
  onVideoChange,
}: {
  videoSettings: MediaVideoRecipeSettings;
  model: MediaModelDescriptor | null;
  onVideoChange: (settings: MediaVideoRecipeSettings) => void;
}): JSX.Element => {
  const architecture = model?.architecture;
  const profile = openMediaModelProfile(architecture);
  const spatialMultiple = resolveMediaVideoSpatialMultiple(architecture);
  const frameContract = resolveMediaVideoFrameContract(architecture);
  const videoDimensions = resolveMediaVideoDimensions(
    videoSettings.aspectRatio,
    videoSettings.resolution,
    architecture,
  );
  const customVideo =
    videoSettings.width != null || videoSettings.height != null;
  const fixedVideo =
    architecture === "ltx-video" || architecture === "hunyuan-video-1.5-i2v";
  const fixedGuidance =
    fixedVideo ||
    architecture === "minimax-h3-ref2va" ||
    profile?.fixedGuidance === true;
  const fixedFrameRate =
    architecture === "minimax-h3-ref2va" || Boolean(profile?.distillation);
  return (
    <>
      <div className={field}>
        <MediaParameterLabel
          label="Resolution"
          description={MEDIA_PARAMETER_DESCRIPTIONS.resolution}
        />
        <select
          aria-label="Resolution"
          className={control}
          value={customVideo ? "custom" : videoSettings.resolution}
          onChange={(event) =>
            onVideoChange({
              ...videoSettings,
              ...(event.target.value === "custom"
                ? {
                    width:
                      Math.round(videoDimensions[0] / spatialMultiple) *
                      spatialMultiple,
                    height:
                      Math.round(videoDimensions[1] / spatialMultiple) *
                      spatialMultiple,
                  }
                : {
                    resolution: event.target
                      .value as MediaVideoRecipeSettings["resolution"],
                    width: null,
                    height: null,
                  }),
            })
          }
        >
          {(["preview-512", "quality-640", "quality-768"] as const).map(
            (resolution) => (
              <option key={resolution} value={resolution}>
                {resolveMediaVideoDimensions(
                  videoSettings.aspectRatio,
                  resolution,
                  architecture,
                ).join(" × ")}
              </option>
            ),
          )}
          {architecture === "minimax-h3-ref2va" ? (
            <option value="quality-2k">
              {resolveMediaVideoDimensions(
                videoSettings.aspectRatio,
                "quality-2k",
                architecture,
              ).join(" × ")}{" "}
              local 2K
            </option>
          ) : null}
          <option value="custom">Custom</option>
        </select>
      </div>
      {customVideo ? (
        <div className="grid grid-cols-2 gap-2 sm:col-span-2">
          {(["width", "height"] as const).map((key) => (
            <div key={key} className={field}>
              <MediaParameterLabel
                label={key === "width" ? "Width" : "Height"}
                description={MEDIA_PARAMETER_DESCRIPTIONS[key]}
              />
              <input
                aria-label={key === "width" ? "Width" : "Height"}
                className={control}
                type="number"
                min={128}
                max={1536}
                step={spatialMultiple}
                value={videoSettings[key] ?? ""}
                onChange={(event) =>
                  onVideoChange({
                    ...videoSettings,
                    [key]:
                      event.target.value === ""
                        ? null
                        : Number(event.target.value),
                  })
                }
              />
            </div>
          ))}
        </div>
      ) : null}
      {!fixedFrameRate || videoSettings.fps !== 24 ? (
        <div className={field}>
          <MediaParameterLabel
            label="Frame rate"
            description={MEDIA_PARAMETER_DESCRIPTIONS.fps}
          />
          <input
            aria-label="Frame rate"
            className={control}
            type="number"
            min={fixedFrameRate ? 24 : 1}
            max={fixedFrameRate ? 24 : 60}
            step={1}
            value={videoSettings.fps}
            onChange={(event) =>
              onVideoChange({
                ...videoSettings,
                fps: Number(event.target.value),
              })
            }
          />
        </div>
      ) : null}
      <div className={field}>
        <MediaParameterLabel
          label="Frames"
          description={MEDIA_PARAMETER_DESCRIPTIONS.numFrames}
        />
        <select
          aria-label="Frames"
          className={control}
          value={videoSettings.numFrames}
          onChange={(event) =>
            onVideoChange({
              ...videoSettings,
              numFrames: Number(event.target.value),
            })
          }
        >
          {Array.from(
            {
              length:
                Math.floor(
                  (frameContract.maximum - frameContract.minimum) /
                    frameContract.stride,
                ) + 1,
            },
            (_, index) => frameContract.minimum + index * frameContract.stride,
          ).map((frames) => (
            <option value={frames} key={frames}>
              {frames}
            </option>
          ))}
        </select>
      </div>
      <div className={field}>
        <MediaParameterLabel
          label="Sampling steps"
          description={MEDIA_PARAMETER_DESCRIPTIONS.numInferenceSteps}
        />
        {fixedVideo ? (
          <select
            aria-label="Sampling steps"
            className={control}
            value={videoSettings.numInferenceSteps <= 8 ? 8 : 12}
            disabled={architecture === "ltx-video"}
            onChange={(event) =>
              onVideoChange({
                ...videoSettings,
                numInferenceSteps: Number(event.target.value),
              })
            }
          >
            <option value={8}>8</option>
            {architecture === "hunyuan-video-1.5-i2v" ? (
              <option value={12}>12</option>
            ) : null}
          </select>
        ) : (
          <input
            className={control}
            type="number"
            min={profile ? 1 : 4}
            max={profile ? 100 : architecture === "framepack-i2v" ? 50 : 40}
            disabled={profile?.fixedSteps}
            step={1}
            value={videoSettings.numInferenceSteps}
            onChange={(event) =>
              onVideoChange({
                ...videoSettings,
                numInferenceSteps: Number(event.target.value),
              })
            }
          />
        )}
      </div>
      {!fixedGuidance ? (
        <div className={field}>
          <MediaParameterLabel
            label="Guidance"
            description={MEDIA_PARAMETER_DESCRIPTIONS.motionGuidance}
          />
          <input
            aria-label="Guidance"
            className={control}
            type="number"
            min={profile ? 0 : 1}
            max={profile ? 20 : 10}
            step={0.1}
            value={videoSettings.guidanceScale}
            onChange={(event) =>
              onVideoChange({
                ...videoSettings,
                guidanceScale: Number(event.target.value),
              })
            }
          />
        </div>
      ) : null}
      <div className={field}>
        <MediaParameterLabel
          label="Encoding"
          description={MEDIA_PARAMETER_DESCRIPTIONS.encoding}
        />
        <select
          aria-label="Encoding"
          className={control}
          value={videoSettings.encodingQuality}
          onChange={(event) =>
            onVideoChange({
              ...videoSettings,
              encodingQuality: event.target
                .value as MediaVideoRecipeSettings["encodingQuality"],
            })
          }
        >
          <option value="draft">Draft</option>
          <option value="balanced">Balanced</option>
          <option value="production">High</option>
          <option value="lossless">Lossless</option>
        </select>
      </div>
      {videoSettings.fps > 0 ? (
        <p className="self-end pb-2 text-xs text-slate-400">
          {(
            mediaVideoOutputFrameCount(
              videoSettings.numFrames,
              videoSettings.loopMode,
            ) / videoSettings.fps
          ).toFixed(2)}{" "}
          seconds
        </p>
      ) : null}
    </>
  );
};
