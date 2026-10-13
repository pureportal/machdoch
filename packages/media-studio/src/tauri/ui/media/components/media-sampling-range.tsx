import { TriangleAlert } from "lucide-react";
import type { JSX } from "react";
import { mediaImageSamplingProfile } from "../../../../core/media/image-sampling.js";

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
  if (!range || !Number.isFinite(value)) return null;
  const [minimum, maximum] = range;
  const limit = parameter === "steps" ? 100 : 20;
  const outside = value < minimum || value > maximum;
  const label = parameter === "steps" ? "Sampling steps" : "Guidance";
  const text = minimum === maximum ? String(minimum) : `${minimum}–${maximum}`;
  return (
    <div className="flex items-center gap-2" data-sampling-range={parameter}>
      <div
        className="relative h-1 flex-1 rounded-full bg-slate-800"
        aria-hidden="true"
      >
        <div
          className="absolute h-1 min-w-1 rounded-full bg-gradient-to-r from-teal-400 to-emerald-300 shadow-[0_0_8px_rgba(52,211,153,0.25)]"
          style={{
            left: `${(minimum / limit) * 100}%`,
            width: `${((maximum - minimum) / limit) * 100}%`,
          }}
        />
        <span
          className={`absolute -top-0.5 h-2 w-0.5 rounded-full ${outside ? "bg-amber-300" : "bg-slate-100"}`}
          style={{
            left: `${Math.max(0, Math.min(100, (value / limit) * 100))}%`,
          }}
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
