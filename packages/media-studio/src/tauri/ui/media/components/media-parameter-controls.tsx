import { useState, type CSSProperties, type JSX, type ReactNode } from "react";
import { ChevronDown, Info } from "lucide-react";
import {
  isMediaNodeFieldVisible,
  type MediaNodeFieldDefinition,
  type MediaNumberRange,
} from "../../../../core/media/node-registry.js";
import { ControlTooltip } from "../../components/ui/tooltip";
import { cn } from "../../lib/utils";

const TRACK_COLOR = "rgb(51 65 85)";
const RECOMMENDED_COLOR = "rgb(52 211 153 / 0.8)";
const MAX_LINEAR_SLIDER_SPAN = 1_000;

const formatNumber = (value: number): string =>
  value.toLocaleString(undefined, { maximumFractionDigits: 2 });

const rangeText = (range: MediaNumberRange): string =>
  range.min === range.max
    ? formatNumber(range.min)
    : `${formatNumber(range.min)}–${formatNumber(range.max)}`;

export const MediaParameterInfo = ({
  label,
  description,
  recommended,
}: {
  label: string;
  description: string;
  recommended?: MediaNumberRange;
}): JSX.Element | null =>
  description ? (
    <ControlTooltip
      className="max-w-72"
      content={
        <span className="block space-y-1">
          <span className="block">{description}</span>
          {recommended ? (
            <span className="block text-emerald-300">Recommended: {rangeText(recommended)}</span>
          ) : null}
        </span>
      }
    >
      <button
        type="button"
        aria-label={`About ${label}`}
        className="inline-flex size-4 shrink-0 items-center justify-center rounded-full text-slate-500 hover:text-slate-200 focus-visible:text-slate-200 focus-visible:outline-none"
      >
        <Info className="size-3.5" />
      </button>
    </ControlTooltip>
  ) : null;

export const MediaParameterLabel = ({
  label,
  description,
}: {
  label: string;
  description: string;
}): JSX.Element => (
  <span className="flex min-w-0 items-center gap-1.5">
    <span className="truncate">{label}</span>
    <MediaParameterInfo label={label} description={description} />
  </span>
);

const ParameterLabel = ({
  htmlFor,
  label,
  description,
  recommended,
}: {
  htmlFor: string;
  label: string;
  description: string;
  recommended?: MediaNumberRange;
}): JSX.Element => (
  <span className="flex min-w-0 items-center gap-1.5">
    <label htmlFor={htmlFor} className="truncate text-sm text-slate-200">
      {label}
    </label>
    <MediaParameterInfo label={label} description={description} recommended={recommended} />
  </span>
);

const sliderScale = (min: number, max: number) => {
  const logarithmic = min > 0 && max / min >= MAX_LINEAR_SLIDER_SPAN;
  return {
    toPosition: (value: number): number => {
      const clamped = Math.min(max, Math.max(min, value));
      return logarithmic
        ? (Math.log(clamped / min) / Math.log(max / min)) * 100
        : ((clamped - min) / (max - min)) * 100;
    },
    fromPosition: (position: number): number =>
      logarithmic
        ? min * Math.pow(max / min, position / 100)
        : min + ((max - min) * position) / 100,
  };
};

const snap = (value: number, min: number, max: number, step: number, integer: boolean): number => {
  const stepped = Math.round((value - min) / step) * step + min;
  const rounded = integer ? Math.round(stepped) : Number(stepped.toFixed(6));
  return Math.min(max, Math.max(min, rounded));
};

export const MediaParameterNumber = ({
  id,
  label,
  description,
  value,
  min,
  max,
  step = 1,
  integer = false,
  recommended,
  emptyLabel,
  slider = true,
  disabled = false,
  onChange,
}: {
  id: string;
  label: string;
  description: string;
  value: number | null;
  min: number;
  max: number;
  step?: number;
  integer?: boolean;
  recommended?: MediaNumberRange;
  emptyLabel?: string;
  slider?: boolean;
  disabled?: boolean;
  onChange: (value: number | null) => void;
}): JSX.Element => {
  const scale = sliderScale(min, max);
  const outside =
    recommended !== undefined &&
    value !== null &&
    (value < recommended.min || value > recommended.max);
  const trackStyle: CSSProperties = recommended
    ? {
        background: `linear-gradient(to right, ${TRACK_COLOR} ${scale.toPosition(recommended.min)}%, ${RECOMMENDED_COLOR} ${scale.toPosition(recommended.min)}%, ${RECOMMENDED_COLOR} ${scale.toPosition(recommended.max)}%, ${TRACK_COLOR} ${scale.toPosition(recommended.max)}%)`,
      }
    : { background: TRACK_COLOR };
  return (
    <div className="space-y-2" data-parameter={id}>
      <div className="flex items-center justify-between gap-3">
        <ParameterLabel htmlFor={id} label={label} description={description} recommended={recommended} />
        <input
          id={id}
          type="number"
          inputMode="decimal"
          min={min}
          max={max}
          step={step}
          value={value ?? ""}
          placeholder={emptyLabel}
          disabled={disabled}
          aria-invalid={value !== null && (value < min || value > max)}
          onChange={(event) => {
            if (event.target.value === "") {
              if (emptyLabel !== undefined) onChange(null);
              return;
            }
            if (Number.isFinite(event.target.valueAsNumber)) onChange(event.target.valueAsNumber);
          }}
          className={cn(
            "h-8 w-28 shrink-0 rounded-md border bg-slate-950 px-2 text-right text-sm tabular-nums text-slate-100 outline-none focus:border-sky-400 disabled:opacity-50 aria-invalid:border-rose-400",
            outside ? "border-amber-400/70" : "border-slate-700",
          )}
        />
      </div>
      {slider ? (
        <input
          type="range"
          aria-label={`${label} slider`}
          min={0}
          max={100}
          step={0.1}
          value={value === null ? 0 : scale.toPosition(value)}
          disabled={disabled}
          onChange={(event) =>
            onChange(snap(scale.fromPosition(Number(event.target.value)), min, max, step, integer))
          }
          style={trackStyle}
          className={cn(
            "block h-1.5 w-full cursor-pointer appearance-none rounded-full disabled:cursor-not-allowed disabled:opacity-50",
            "[&::-webkit-slider-thumb]:size-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-slate-950 [&::-webkit-slider-thumb]:shadow",
            "[&::-moz-range-thumb]:size-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-slate-950",
            value === null
              ? "[&::-moz-range-thumb]:bg-slate-500 [&::-webkit-slider-thumb]:bg-slate-500"
              : outside
                ? "[&::-moz-range-thumb]:bg-amber-300 [&::-webkit-slider-thumb]:bg-amber-300"
                : "[&::-moz-range-thumb]:bg-slate-100 [&::-webkit-slider-thumb]:bg-slate-100",
          )}
        />
      ) : null}
    </div>
  );
};

export const MediaParameterSwitch = ({
  id,
  label,
  description,
  value,
  disabled = false,
  onChange,
}: {
  id: string;
  label: string;
  description: string;
  value: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
}): JSX.Element => (
  <div className="flex items-center justify-between gap-3" data-parameter={id}>
    <ParameterLabel htmlFor={id} label={label} description={description} />
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={value}
      disabled={disabled}
      onClick={() => onChange(!value)}
      className={cn(
        "relative h-5 w-9 shrink-0 rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/40 disabled:opacity-50",
        value ? "bg-emerald-500" : "bg-slate-700",
      )}
    >
      <span
        className={cn(
          "absolute top-0.5 left-0.5 size-4 rounded-full bg-white shadow transition-transform",
          value && "translate-x-4",
        )}
      />
    </button>
  </div>
);

export const MediaMoreOptions = ({
  children,
  defaultOpen = false,
}: {
  children: ReactNode;
  defaultOpen?: boolean;
}): JSX.Element => {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="rounded-xl border border-slate-800">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="flex w-full items-center justify-between px-4 py-3 text-sm font-medium text-slate-200"
      >
        More options
        <ChevronDown className={cn("h-4 w-4 transition-transform", open && "rotate-180")} />
      </button>
      {open ? <div className="space-y-5 border-t border-slate-800 p-4">{children}</div> : null}
    </section>
  );
};

export type MediaParameterFieldOverrides = Readonly<
  Record<string, Partial<Pick<MediaNodeFieldDefinition, "recommended" | "defaultValue">>>
>;

const renderField = <T extends object>(
  idPrefix: string,
  field: MediaNodeFieldDefinition,
  values: T,
  onChange: (values: T) => void,
  overrides: MediaParameterFieldOverrides,
): JSX.Element | null => {
  const value = (values as Record<string, unknown>)[field.id];
  const recommended = overrides[field.id]?.recommended ?? field.recommended;
  const update = (next: unknown): void => onChange({ ...values, [field.id]: next });
  if (field.kind === "boolean")
    return (
      <MediaParameterSwitch
        key={field.id}
        id={`${idPrefix}-${field.id}`}
        label={field.label}
        description={field.description}
        value={value === true}
        onChange={update}
      />
    );
  if (field.kind !== "number" || field.min === undefined || field.max === undefined) return null;
  const nullable = !field.required;
  return (
    <MediaParameterNumber
      key={field.id}
      id={`${idPrefix}-${field.id}`}
      label={field.label}
      description={field.description}
      value={typeof value === "number" ? value : null}
      min={field.min}
      max={field.max}
      step={field.step ?? (field.integer ? 1 : 0.1)}
      integer={field.integer === true}
      recommended={recommended}
      emptyLabel={nullable ? (field.id === "seed" ? "Random" : "Off") : undefined}
      slider={field.id !== "seed"}
      onChange={(next) => update(next === null && !nullable ? field.defaultValue : next)}
    />
  );
};

export const MediaParameterFields = <T extends object>({
  idPrefix,
  fields,
  values,
  onChange,
  overrides = {},
  moreOptions,
}: {
  idPrefix: string;
  fields: readonly MediaNodeFieldDefinition[];
  values: T;
  onChange: (values: T) => void;
  overrides?: MediaParameterFieldOverrides;
  moreOptions?: ReactNode;
}): JSX.Element => {
  const visible = fields.filter((field) =>
    isMediaNodeFieldVisible(field, values as Record<string, unknown>),
  );
  const basic = visible.filter((field) => field.group !== "Expert");
  const expert = visible.filter((field) => field.group === "Expert");
  return (
    <div className="space-y-5">
      {basic.map((field) => renderField(idPrefix, field, values, onChange, overrides))}
      {expert.length > 0 || moreOptions ? (
        <MediaMoreOptions>
          {moreOptions}
          {expert.map((field) => renderField(idPrefix, field, values, onChange, overrides))}
        </MediaMoreOptions>
      ) : null}
    </div>
  );
};
