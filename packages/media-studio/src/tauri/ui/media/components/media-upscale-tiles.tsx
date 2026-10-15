import type { MediaUpscaleSettings } from "../../../../core/media/upscale-settings.js";
import { Input } from "../../components/ui/input";
import { SearchableSelect } from "../../components/ui/searchable-select";

export function MediaUpscaleTiles({
  value,
  onChange,
  disabled,
  tileSize,
  memoryBytes,
  memoryTotal,
}: {
  value: MediaUpscaleSettings;
  onChange: (value: MediaUpscaleSettings) => void;
  disabled: boolean;
  tileSize?: number;
  memoryBytes?: number;
  memoryTotal: number | null;
}) {
  return (
    <fieldset disabled={disabled} className="min-w-0 space-y-3">
      <legend className="mb-2 text-xs text-slate-400">Tiles</legend>
      <SearchableSelect
        label="Tiles"
        value={value.tileMode}
        disabled={disabled}
        className="w-full"
        onChange={(tileMode) =>
          onChange({
            ...value,
            tileMode: tileMode as MediaUpscaleSettings["tileMode"],
          })
        }
        options={[
          { value: "automatic", label: "Automatic" },
          { value: "manual", label: "Manual" },
          { value: "factor", label: "Divide by factor" },
          { value: "full", label: "Full frame" },
        ]}
      />
      {value.tileMode === "manual" ? (
        <label className="block space-y-2 text-xs text-slate-400">
          <span>Tile size (px)</span>
          <Input
            id="upscale-tile"
            aria-label="Tile size (px)"
            type="number"
            min={32}
            max={2048}
            step={32}
            value={Number.isFinite(value.tileSize) ? value.tileSize : ""}
            aria-invalid={
              !Number.isInteger(value.tileSize) ||
              value.tileSize < 32 ||
              value.tileSize > 2048
            }
            onChange={(event) =>
              onChange({ ...value, tileSize: event.target.valueAsNumber })
            }
          />
        </label>
      ) : value.tileMode === "factor" ? (
        <label className="block space-y-2 text-xs text-slate-400">
          <span>Longest edge ÷</span>
          <Input
            aria-label="Tile divisor"
            type="number"
            min={2}
            max={16}
            step={1}
            value={Number.isFinite(value.tileFactor) ? value.tileFactor : ""}
            aria-invalid={
              !Number.isInteger(value.tileFactor) ||
              value.tileFactor < 2 ||
              value.tileFactor > 16
            }
            onChange={(event) =>
              onChange({ ...value, tileFactor: event.target.valueAsNumber })
            }
          />
        </label>
      ) : null}
      {tileSize !== undefined &&
      memoryBytes !== undefined &&
      (value.tileMode !== "full" || memoryTotal !== null) ? (
        <p className="text-xs tabular-nums text-slate-400">
          {value.tileMode !== "full"
            ? `${value.tileMode === "automatic" ? "~" : ""}${tileSize} px tiles${memoryTotal !== null ? " · " : ""}`
            : ""}
          {memoryTotal !== null
            ? `Est. VRAM ${(memoryBytes / 1024 ** 3).toFixed(1)} GB / ${(memoryTotal / 1024 ** 3).toFixed(1)} GB total`
            : ""}
        </p>
      ) : null}
    </fieldset>
  );
}
