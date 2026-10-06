import type {
  MediaModelAddonDescriptor,
  MediaModelDescriptor,
} from "../../../core/media/contracts.js";
import { isMediaModelAddonSelectable } from "../../../core/media/model-addons.js";

export function selectMediaAddonImageModel(
  models: readonly MediaModelDescriptor[],
  addon: MediaModelAddonDescriptor,
  runnableModelIds: readonly string[],
  selectedModelId: string | null,
  baseModelId: string | null,
): MediaModelDescriptor | undefined {
  const candidates = models.filter(
    (model) =>
      model.installed &&
      runnableModelIds.includes(model.id) &&
      (baseModelId === null || model.id === baseModelId) &&
      isMediaModelAddonSelectable(model, addon),
  );
  return (
    candidates.find((model) => model.id === selectedModelId) ?? candidates[0]
  );
}
