import type { JSX } from "react";
import type {
  ImageRecipeSettings,
  MediaAssetRecord,
} from "../../../../core/media/contracts.js";

const control =
  "h-10 w-full min-w-0 rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm text-slate-200 transition-colors hover:border-slate-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/60 disabled:cursor-not-allowed disabled:opacity-50";
const field = "flex min-w-0 flex-col gap-2 text-xs text-slate-400";

export const MediaBasicImageOutputOptions = ({
  settings,
  baseImageAsset,
  onChange,
}: {
  settings: ImageRecipeSettings;
  baseImageAsset: MediaAssetRecord | null;
  onChange: (settings: ImageRecipeSettings) => void;
}): JSX.Element => (
  <section aria-label="Output" className="min-w-0 space-y-4">
    <h3 className="flex min-h-8 items-center text-xs font-semibold text-slate-200">
      Output
    </h3>
    <div className="grid grid-cols-2 gap-x-3 gap-y-4">
      <label className={field}>
        <span>{settings.editMask ? "Output size" : "Aspect ratio"}</span>
        <select
          value={settings.editMask ? "original" : settings.aspectRatio}
          disabled={
            Boolean(settings.editMask) ||
            settings.sampling?.width != null ||
            settings.sampling?.height != null
          }
          onChange={(event) =>
            onChange({
              ...settings,
              aspectRatio: event.target
                .value as ImageRecipeSettings["aspectRatio"],
            })
          }
          className={control}
        >
          {settings.editMask && baseImageAsset ? (
            <option value="original">
              {baseImageAsset.width} × {baseImageAsset.height}
            </option>
          ) : null}
          {(["1:1", "4:5", "16:9", "9:16"] as const).map((value) => (
            <option key={value}>{value}</option>
          ))}
        </select>
      </label>
      <label className={field}>
        <span>Outputs</span>
        <input
          type="number"
          min={1}
          max={8}
          step={1}
          value={settings.outputCount}
          onChange={(event) =>
            onChange({
              ...settings,
              outputCount: Math.min(
                8,
                Math.max(1, Math.round(Number(event.target.value)) || 1),
              ),
            })
          }
          className={control}
        />
      </label>
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
              sampling: {
                ...settings.sampling,
                numInferenceSteps: null,
                guidanceScale: null,
              },
            })
          }
        >
          <option value="fast">Draft</option>
          <option value="balanced">Balanced</option>
          <option value="quality">High</option>
        </select>
      </label>
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
      <label className="col-span-full flex min-h-10 cursor-pointer items-center gap-3 rounded-lg border border-slate-800 bg-slate-950/40 px-3 py-2 text-xs text-slate-300 has-[:disabled]:cursor-default has-[:disabled]:opacity-50">
        <input
          type="checkbox"
          className="h-4 w-4 shrink-0 accent-sky-400"
          checked={settings.transparentBackground}
          disabled={Boolean(settings.editMask)}
          title={
            settings.editMask
              ? "Choose Full image to remove the background"
              : undefined
          }
          onChange={(event) =>
            onChange({
              ...settings,
              transparentBackground: event.target.checked,
              outputFormat:
                event.target.checked && settings.outputFormat === "jpeg"
                  ? "png"
                  : settings.outputFormat,
            })
          }
        />
        Transparent background
      </label>
    </div>
  </section>
);
