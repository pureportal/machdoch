import type {
  MediaAudioRecipeSettings,
  MediaModelDescriptor,
} from "../../../../core/media/contracts.js";
import { Button } from "../../components/ui/button";
import { Textarea } from "../../components/ui/textarea";
import { isMediaModelReady } from "../../../../core/media/model-readiness.js";
import { getMediaNodeDefinition } from "../../../../core/media/node-registry.js";
import {
  MediaParameterFields,
  MediaParameterLabel,
} from "./media-parameter-controls";

const AUDIO_FIELDS =
  getMediaNodeDefinition("task.generate-audio")?.fields ?? [];
const NUMERIC_FIELDS = AUDIO_FIELDS.filter((field) => field.kind === "number");
const NEGATIVE_PROMPT_DESCRIPTION =
  AUDIO_FIELDS.find((field) => field.id === "negativePrompt")?.description ??
  "";

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
      <MediaParameterFields
        idPrefix="audio"
        fields={NUMERIC_FIELDS}
        values={settings}
        onChange={onChange}
        moreOptions={
          <div className="block space-y-2 text-sm text-slate-200">
            <MediaParameterLabel
              label="Negative prompt"
              description={NEGATIVE_PROMPT_DESCRIPTION}
            />
            <Textarea
              aria-label="Audio negative prompt"
              value={settings.negativePrompt}
              maxLength={8000}
              rows={3}
              onChange={(event) =>
                onChange({ ...settings, negativePrompt: event.target.value })
              }
            />
          </div>
        }
      />
    </div>
  );
};
