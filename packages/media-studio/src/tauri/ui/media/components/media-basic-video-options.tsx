import type { JSX } from "react";
import type {
  MediaModelDescriptor,
  MediaVideoRecipeSettings,
} from "../../../../core/media/contracts.js";
import {
  mediaVideoOutputFrameCount,
  resolveMediaVideoDimensions,
  resolveMediaVideoFrameContract,
} from "../../../../core/media/video-quality.js";

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
  return (
    <>
      <label className={field}>
        <span>Resolution</span>
        <select
          className={control}
          value={customVideo ? "custom" : videoSettings.resolution}
          onChange={(event) =>
            onVideoChange({
              ...videoSettings,
              ...(event.target.value === "custom"
                ? {
                    width: Math.round(videoDimensions[0] / 32) * 32,
                    height: Math.round(videoDimensions[1] / 32) * 32,
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
          <option value="custom">Custom</option>
        </select>
      </label>
      {customVideo ? (
        <div className="grid grid-cols-2 gap-2 sm:col-span-2">
          {(["width", "height"] as const).map((key) => (
            <label key={key} className={field}>
              <span>{key === "width" ? "Width" : "Height"}</span>
              <input
                className={control}
                type="number"
                min={128}
                max={1536}
                step={32}
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
            </label>
          ))}
        </div>
      ) : null}
      <label className={field}>
        <span>Frame rate</span>
        <input
          className={control}
          type="number"
          min={1}
          max={60}
          step={1}
          value={videoSettings.fps}
          onChange={(event) =>
            onVideoChange({
              ...videoSettings,
              fps: Number(event.target.value),
            })
          }
        />
      </label>
      <label className={field}>
        <span>Frames</span>
        <select
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
      </label>
      <label className={field}>
        <span>Sampling steps</span>
        {fixedVideo ? (
          <select
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
            min={4}
            max={architecture === "framepack-i2v" ? 50 : 40}
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
      </label>
      {!fixedVideo ? (
        <label className={field}>
          <span>Guidance</span>
          <input
            className={control}
            type="number"
            min={1}
            max={10}
            step={0.1}
            value={videoSettings.guidanceScale}
            onChange={(event) =>
              onVideoChange({
                ...videoSettings,
                guidanceScale: Number(event.target.value),
              })
            }
          />
        </label>
      ) : null}
      <label className={field}>
        <span>Encoding</span>
        <select
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
      </label>
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
