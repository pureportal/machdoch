import { ChevronDown, Workflow } from "lucide-react";
import type { MediaAssetRecord } from "../../../../core/media/contracts.js";
import { MEDIA_UPSCALERS } from "../../../../core/media/upscale.js";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { SearchableSelect } from "../../components/ui/searchable-select";
import { open } from "../media-platform";
import { normalizeMediaError } from "../media-runtime";
import type { MediaUpscaleSettings } from "../../../../core/media/upscale-settings.js";
import { MediaUpscaleSizing } from "./media-upscale-sizing";
import { MediaUpscaleTiles } from "./media-upscale-tiles";

export interface MediaUpscaleOptionsValue extends MediaUpscaleSettings {
  modelId: string;
  customPath: string;
}

export function MediaUpscaleOptions({
  value,
  onChange,
  source,
  disabled,
  estimate,
  memoryBytes,
  canOpenFlow,
  onOpenFlow,
  onError,
}: {
  value: MediaUpscaleOptionsValue;
  onChange: (value: MediaUpscaleOptionsValue) => void;
  source: MediaAssetRecord | undefined;
  disabled: boolean;
  estimate: { tileSize: number; bytes: number } | null;
  memoryBytes: number | null;
  canOpenFlow: boolean;
  onOpenFlow: () => void;
  onError: (message: string) => void;
}) {
  const { modelId, customPath } = value;
  const changeSettings = (settings: MediaUpscaleSettings) =>
    onChange({ ...value, ...settings });
  return (
    <>
      <div className="space-y-2">
        <span className="block text-sm font-medium text-slate-200">Model</span>
        <SearchableSelect
          label="Model"
          value={modelId}
          disabled={disabled}
          onChange={(modelId) => onChange({ ...value, modelId })}
          className="w-full"
          options={[
            ...MEDIA_UPSCALERS.map((model) => ({
              value: model.id,
              label: `${model.name} · ${model.size}`,
            })),
            { value: "custom", label: "Custom model" },
          ]}
        />
      </div>
      {modelId === "custom" ? (
        <div className="space-y-2">
          <label
            htmlFor="upscale-path"
            className="block text-sm font-medium text-slate-200"
          >
            Model file
          </label>
          <div className="flex gap-2">
            <Input
              id="upscale-path"
              disabled={disabled}
              value={customPath}
              onChange={(event) =>
                onChange({ ...value, customPath: event.target.value })
              }
            />
            <Button
              variant="outline"
              disabled={disabled}
              onClick={() => {
                void open({
                  multiple: false,
                  filters: [
                    {
                      name: "Upscaler",
                      extensions: ["pth", "safetensors"],
                    },
                  ],
                })
                  .then((path) => {
                    if (typeof path === "string")
                      onChange({ ...value, customPath: path });
                  })
                  .catch((failure: unknown) =>
                    onError(
                      normalizeMediaError(failure, "select_upscaler").message,
                    ),
                  );
              }}
            >
              Browse
            </Button>
          </div>
        </div>
      ) : null}
      <MediaUpscaleSizing
        value={value}
        onChange={changeSettings}
        source={source}
        disabled={disabled}
      />
      <details className="group border-t border-slate-800 pt-4">
        <summary className="flex cursor-pointer list-none items-center justify-between rounded-md text-sm font-medium text-slate-300 outline-none focus-visible:ring-2 focus-visible:ring-sky-400/60">
          Advanced settings
          <ChevronDown
            aria-hidden="true"
            className="h-4 w-4 transition-transform group-open:rotate-180"
          />
        </summary>
        <div className="mt-4 space-y-3">
          <MediaUpscaleTiles
            value={value}
            onChange={changeSettings}
            disabled={disabled}
            tileSize={estimate?.tileSize}
            memoryBytes={estimate?.bytes}
            memoryTotal={memoryBytes}
          />
          <Button
            variant="outline"
            className="w-full"
            disabled={!canOpenFlow}
            onClick={onOpenFlow}
          >
            <Workflow aria-hidden="true" />
            Open in Advanced
          </Button>
        </div>
      </details>
    </>
  );
}
