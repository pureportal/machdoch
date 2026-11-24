import { TriangleAlert } from "lucide-react";
import type { JSX } from "react";
import { mediaImageSamplingProfile } from "../../../../core/media/image-sampling.js";
import type { MediaNumberRange } from "../../../../core/media/node-registry.js";

export const MediaRecommendedRange = ({
  id,
  label,
  range,
  min,
  max,
  value,
}: {
  id: string;
  label: string;
  range: MediaNumberRange;
  min: number;
  max: number;
  value: number;
}): JSX.Element | null => {
  if (!Number.isFinite(value) || max <= min) return null;
  const position = (entry: number): number =>
    Math.max(0, Math.min(100, ((entry - min) / (max - min)) * 100));
  const outside = value < range.min || value > range.max;
  const text =
    range.min === range.max
      ? String(range.min)
      : `${range.min.toLocaleString()}–${range.max.toLocaleString()}`;
  return (
    <div className="flex items-center gap-2" data-sampling-range={id}>
      <div
        className="relative h-1 flex-1 rounded-full bg-slate-800"
        aria-hidden="true"
      >
        <div
          className="absolute h-1 min-w-1 rounded-full bg-gradient-to-r from-teal-400 to-emerald-300 shadow-[0_0_8px_rgba(52,211,153,0.25)]"
          style={{
            left: `${position(range.min)}%`,
            width: `${position(range.max) - position(range.min)}%`,
          }}
        />
        <span
          className={`absolute -top-0.5 h-2 w-0.5 rounded-full ${outside ? "bg-amber-300" : "bg-slate-100"}`}
          style={{ left: `${position(value)}%` }}
        />
      </div>
      <span
        className="text-[10px] tabular-nums text-emerald-300"
        title={`Suggested ${label.toLowerCase()}: ${text}`}
      >
        {text}
      </span>
      {outside ? (
        <span
          role="img"
          aria-label={`${label} outside suggested range (${text})`}
          title={`${label} outside suggested range (${text})`}
        >
          <TriangleAlert
            className="h-3 w-3 text-amber-300"
            aria-hidden="true"
          />
        </span>
      ) : null}
    </div>
  );
};

export const MediaSamplingRange = ({
  architecture,
  parameter,
  value,
}: {
  architecture: string | null | undefined;
  parameter: "steps" | "guidance";
  value: number;
}): JSX.Element | null => {
  const range = mediaImageSamplingProfile(architecture)?.[parameter];
  if (!range) return null;
  return (
    <MediaRecommendedRange
      id={parameter}
      label={parameter === "steps" ? "Sampling steps" : "Guidance"}
      range={{ min: range[0], max: range[1] }}
      min={0}
      max={parameter === "steps" ? 100 : 20}
      value={value}
    />
  );
};
