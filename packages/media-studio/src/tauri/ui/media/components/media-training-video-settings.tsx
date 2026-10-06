import type { JSX } from "react";
import type { MediaTrainingVideoSettings } from "../media-training";

const fields = [
  { key: "width", label: "Width", min: 64, max: 2048, step: 16 },
  { key: "height", label: "Height", min: 64, max: 2048, step: 16 },
  { key: "frames", label: "Frames", min: 5, max: 161, step: 4 },
  { key: "fps", label: "FPS", min: 1, max: 60, step: 1 },
] as const;

export function MediaTrainingVideoSettingsFields({
  settings,
  imageConditioned,
  onChange,
}: {
  settings: MediaTrainingVideoSettings;
  imageConditioned: boolean;
  onChange: (patch: Partial<MediaTrainingVideoSettings>) => void;
}): JSX.Element {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {fields.map((field) => (
        <label key={field.key} className="space-y-2 text-sm">
          {field.label}
          <input
            type="number"
            min={field.min}
            max={field.max}
            step={field.step}
            value={settings[field.key]}
            onChange={(event) =>
              onChange({ [field.key]: Number(event.target.value) })
            }
            className="block w-full rounded-lg border border-slate-600 bg-slate-950 px-3 py-2"
          />
        </label>
      ))}
      {imageConditioned ? (
        <label className="space-y-2 text-sm">
          Image dropout
          <input
            type="number"
            min={0}
            max={1}
            step={0.01}
            value={settings.image_dropout}
            onChange={(event) =>
              onChange({ image_dropout: Number(event.target.value) })
            }
            className="block w-full rounded-lg border border-slate-600 bg-slate-950 px-3 py-2"
          />
        </label>
      ) : null}
    </div>
  );
}
