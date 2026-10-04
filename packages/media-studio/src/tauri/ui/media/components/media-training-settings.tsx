import type { JSX } from "react";
import type {
  MediaTrainingArchitecture,
  MediaTrainingRequest,
} from "../media-training";

export type MediaTrainingSettings = Pick<
  MediaTrainingRequest,
  | "steps"
  | "learningRate"
  | "resolution"
  | "rank"
  | "seed"
  | "attentionOnly"
  | "fourBit"
>;

export function MediaTrainingSettingsFields({
  architecture,
  settings,
  onChange,
}: {
  architecture: MediaTrainingArchitecture;
  settings: MediaTrainingSettings;
  onChange: (patch: Partial<MediaTrainingSettings>) => void;
}): JSX.Element {
  const {
    steps,
    learningRate,
    resolution,
    rank,
    seed,
    fourBit,
    attentionOnly,
  } = settings;
  return (
    <div className="mt-4 grid gap-4 sm:grid-cols-2">
      <label className="space-y-2 text-sm">
        Steps
        <input
          type="number"
          min={1}
          max={10000}
          step={1}
          value={steps}
          onChange={(event) => onChange({ steps: Number(event.target.value) })}
          className="block w-full rounded-lg border border-slate-600 bg-slate-950 px-3 py-2"
        />
      </label>
      <label className="space-y-2 text-sm">
        Learning rate
        <input
          type="number"
          min={0.00001}
          max={0.001}
          step={0.00001}
          value={learningRate}
          onChange={(event) =>
            onChange({ learningRate: Number(event.target.value) })
          }
          className="block w-full rounded-lg border border-slate-600 bg-slate-950 px-3 py-2"
        />
      </label>
      <label className="space-y-2 text-sm">
        Resolution
        <select
          value={resolution}
          onChange={(event) =>
            onChange({
              resolution: Number(
                event.target.value,
              ) as MediaTrainingSettings["resolution"],
            })
          }
          className="block w-full rounded-lg border border-slate-600 bg-slate-950 px-3 py-2"
        >
          <option value={512}>512</option>
          <option value={768}>768</option>
          <option value={1024}>1024</option>
        </select>
      </label>
      <label className="space-y-2 text-sm">
        Rank
        <select
          value={rank}
          onChange={(event) =>
            onChange({
              rank: Number(event.target.value) as MediaTrainingSettings["rank"],
            })
          }
          className="block w-full rounded-lg border border-slate-600 bg-slate-950 px-3 py-2"
        >
          <option value={4}>4</option>
          <option value={8}>8</option>
          <option value={16}>16</option>
          <option value={32}>32</option>
          <option value={64}>64</option>
        </select>
      </label>
      <label className="space-y-2 text-sm">
        Seed
        <input
          type="number"
          min={0}
          max={4294967295}
          step={1}
          value={seed}
          onChange={(event) => onChange({ seed: Number(event.target.value) })}
          className="block w-full rounded-lg border border-slate-600 bg-slate-950 px-3 py-2"
        />
      </label>
      {architecture === "krea-2" ? (
        <>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={fourBit}
              onChange={(event) => onChange({ fourBit: event.target.checked })}
            />
            4-bit model weights
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={attentionOnly}
              onChange={(event) =>
                onChange({ attentionOnly: event.target.checked })
              }
            />
            Attention layers only
          </label>
        </>
      ) : null}
    </div>
  );
}
