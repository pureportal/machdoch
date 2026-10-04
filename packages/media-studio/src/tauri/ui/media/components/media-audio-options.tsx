import type {
  MediaAudioRecipeSettings,
  MediaModelDescriptor,
} from "../../../../core/media/contracts.js";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Textarea } from "../../components/ui/textarea";
import { isMediaModelReady } from "../../../../core/media/model-readiness.js";

export const MediaAudioOptions = ({
  settings,
  models,
  onChange,
  onOpenAssets,
}: {
  settings: MediaAudioRecipeSettings;
  models: readonly MediaModelDescriptor[];
  onChange: (settings: MediaAudioRecipeSettings) => void;
  onOpenAssets: (modelId?: string) => void;
}) => {
  const audioModels = models.filter(
    (model) =>
      model.architecture === "audioldm-2" &&
      model.capabilities.includes("text-to-audio"),
  );
  const readyModels = audioModels.filter(isMediaModelReady);
  return (
    <div className="space-y-5">
      <label className="block space-y-2 text-sm text-slate-200">
        <span>Prompt</span>
        <Textarea
          aria-label="Audio prompt"
          value={settings.prompt}
          maxLength={8000}
          rows={7}
          onChange={(event) =>
            onChange({ ...settings, prompt: event.target.value })
          }
        />
      </label>
      <label className="block space-y-2 text-sm text-slate-200">
        <span>Model</span>
        <select
          aria-label="Audio model"
          className="w-full rounded-lg border border-slate-700 bg-slate-950 p-2"
          value={settings.modelId ?? ""}
          onChange={(event) =>
            onChange({ ...settings, modelId: event.target.value || null })
          }
        >
          <option value="">Automatic</option>
          {readyModels.map((model) => (
            <option key={model.id} value={model.id}>
              {model.displayName}
            </option>
          ))}
        </select>
      </label>
      {readyModels.length === 0 ? (
        <Button
          variant="outline"
          onClick={() => onOpenAssets(audioModels[0]?.id)}
        >
          Install audio model
        </Button>
      ) : null}
      <label className="block space-y-2 text-sm text-slate-200">
        <span>Duration (s)</span>
        <Input
          aria-label="Audio duration"
          type="number"
          min={1}
          max={30}
          step={0.1}
          value={settings.durationSeconds}
          onChange={(event) =>
            onChange({
              ...settings,
              durationSeconds: event.target.valueAsNumber,
            })
          }
        />
      </label>
      <details>
        <summary className="cursor-pointer text-sm text-slate-300">
          Options
        </summary>
        <div className="mt-4 space-y-4">
          <label className="block space-y-2 text-sm text-slate-200">
            <span>Negative prompt</span>
            <Textarea
              aria-label="Audio negative prompt"
              value={settings.negativePrompt}
              maxLength={8000}
              rows={3}
              onChange={(event) =>
                onChange({ ...settings, negativePrompt: event.target.value })
              }
            />
          </label>
          {(
            [
              ["numInferenceSteps", "Steps", 1, 200, 1],
              ["guidanceScale", "Guidance", 0, 20, 0.1],
              ["seed", "Seed", 0, Number.MAX_SAFE_INTEGER, 1],
            ] as const
          ).map(([key, label, min, max, step]) => (
            <label key={key} className="block space-y-2 text-sm text-slate-200">
              <span>{label}</span>
              <Input
                aria-label={`Audio ${label.toLowerCase()}`}
                type="number"
                min={min}
                max={max}
                step={step}
                value={settings[key] ?? ""}
                onChange={(event) =>
                  onChange({
                    ...settings,
                    [key]:
                      key === "seed" && !event.target.value
                        ? null
                        : event.target.valueAsNumber,
                  })
                }
              />
            </label>
          ))}
        </div>
      </details>
    </div>
  );
};
