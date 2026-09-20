import type { JSX } from "react";

interface MediaLoraStrengthControlProps {
  label: string;
  value: number;
  disabled?: boolean;
  onChange: (value: number) => void;
}

const updateStrength = (
  value: string,
  onChange: (value: number) => void,
): void => {
  const next = Number(value);
  if (Number.isFinite(next) && next >= -2 && next <= 2) onChange(next);
};

export const MediaLoraStrengthControl = ({
  label,
  value,
  disabled = false,
  onChange,
}: MediaLoraStrengthControlProps): JSX.Element => (
  <label className="min-w-0 flex-1 text-[9px] text-slate-300">
    <span className="mb-1 flex items-center justify-between gap-2">
      <span>Strength</span>
      <input
        aria-label={`${label} strength value`}
        type="number"
        min={-2}
        max={2}
        step={0.05}
        value={value}
        disabled={disabled}
        onChange={(event) => updateStrength(event.target.value, onChange)}
        className="h-5 w-12 rounded border border-slate-700 bg-slate-950 px-1 text-right text-[9px] text-slate-100 outline-none focus:border-sky-400 disabled:opacity-50"
      />
    </span>
    <input
      aria-label={`${label} model strength`}
      type="range"
      min={-2}
      max={2}
      step={0.05}
      value={value}
      disabled={disabled}
      onChange={(event) => updateStrength(event.target.value, onChange)}
      className="block w-full accent-sky-400 disabled:opacity-50"
    />
  </label>
);
