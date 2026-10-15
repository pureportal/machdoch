import type { MediaAssetRecord } from "../../../../core/media/contracts.js";
import {
  resolveUpscaleSize,
  type MediaUpscaleSettings,
} from "../../../../core/media/upscale-settings.js";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { SearchableSelect } from "../../components/ui/searchable-select";

export function MediaUpscaleSizing({
  value,
  onChange,
  disabled,
  source,
}: {
  value: MediaUpscaleSettings;
  onChange: (value: MediaUpscaleSettings) => void;
  disabled: boolean;
  source?: MediaAssetRecord;
}) {
  const size = source
    ? resolveUpscaleSize(source.width, source.height, value)
    : null;
  const dimensions =
    value.sizeMode === "dimensions"
      ? ([
          { key: "minWidth", label: "Min. width" },
          { key: "minHeight", label: "Min. height" },
        ] as const)
      : value.sizeMode === "edges"
        ? ([
            { key: "minLongEdge", label: "Min. long edge" },
            { key: "minShortEdge", label: "Min. short edge" },
          ] as const)
        : ([{ key: "minShortEdge", label: "Min. shortest edge" }] as const);
  return (
    <fieldset disabled={disabled} className="min-w-0 space-y-3">
      <legend className="mb-2 text-sm font-medium text-slate-200">
        Output size
      </legend>
      <SearchableSelect
        label="Sizing"
        value={value.sizeMode}
        disabled={disabled}
        onChange={(sizeMode) =>
          onChange({
            ...value,
            sizeMode: sizeMode as MediaUpscaleSettings["sizeMode"],
          })
        }
        className="w-full"
        options={[
          { value: "scale", label: "Scale factor" },
          { value: "dimensions", label: "Minimum width & height" },
          { value: "edges", label: "Minimum long & short edge" },
          { value: "short-edge", label: "Minimum shortest edge" },
        ]}
      />
      {value.sizeMode === "scale" ? (
        <>
          <div className="grid grid-cols-3 gap-1 rounded-xl border border-slate-800 bg-slate-900/70 p-1">
            {[2, 4, 8].map((scale) => (
              <Button
                key={scale}
                variant={value.scale === scale ? "secondary" : "ghost"}
                className={
                  value.scale === scale
                    ? "bg-slate-700 text-white hover:bg-slate-600"
                    : "text-slate-400 hover:text-slate-100"
                }
                aria-pressed={value.scale === scale}
                onClick={() => onChange({ ...value, scale })}
              >
                {scale}×
              </Button>
            ))}
          </div>
          <div className="flex items-center gap-3">
            <input
              aria-label="Scale factor"
              type="range"
              min={1}
              max={8}
              step={0.05}
              value={Number.isFinite(value.scale) ? value.scale : 1}
              disabled={disabled}
              onChange={(event) =>
                onChange({ ...value, scale: event.target.valueAsNumber })
              }
              className="h-5 min-w-0 flex-1 accent-sky-400 disabled:opacity-50"
            />
            <div className="relative w-24 shrink-0">
              <Input
                aria-label="Custom scale"
                type="number"
                min={1}
                max={8}
                step={0.05}
                value={Number.isFinite(value.scale) ? value.scale : ""}
                aria-invalid={
                  !Number.isFinite(value.scale) ||
                  value.scale < 1 ||
                  value.scale > 8
                }
                className="pr-6 tabular-nums"
                onChange={(event) =>
                  onChange({ ...value, scale: event.target.valueAsNumber })
                }
              />
              <span
                aria-hidden="true"
                className="pointer-events-none absolute top-2 right-2 text-sm text-slate-500"
              >
                ×
              </span>
            </div>
          </div>
        </>
      ) : (
        <div
          className={`grid gap-3 ${dimensions.length === 2 ? "grid-cols-2" : "grid-cols-1"}`}
        >
          {dimensions.map(({ key, label }) => (
            <label key={key} className="space-y-2 text-xs text-slate-400">
              <span className="block">{label}</span>
              <div className="relative">
                <Input
                  aria-label={label}
                  type="number"
                  min={value.sizeMode === "short-edge" ? 1 : 0}
                  max={16384}
                  step={1}
                  value={value[key] || ""}
                  placeholder="—"
                  className="pr-8 tabular-nums"
                  aria-invalid={
                    !Number.isInteger(value[key]) ||
                    value[key] < 0 ||
                    value[key] > 16384
                  }
                  onChange={(event) =>
                    onChange({
                      ...value,
                      [key]:
                        event.target.value === ""
                          ? 0
                          : event.target.valueAsNumber,
                    })
                  }
                />
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute top-2.5 right-2 text-xs text-slate-500"
                >
                  px
                </span>
              </div>
            </label>
          ))}
        </div>
      )}
      {size && Number.isFinite(size.width) && Number.isFinite(size.height) ? (
        <p className="text-xs tabular-nums text-slate-400">
          Output · {size.width} × {size.height}
          {value.sizeMode !== "scale"
            ? ` · ${Number(size.factor.toFixed(2))}×`
            : ""}
        </p>
      ) : null}
    </fieldset>
  );
}
