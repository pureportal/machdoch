import type { MediaModelDescriptor } from "./contracts.js";
import type { MediaImageLayout, MediaImageLayoutMethod } from "./image-layout.js";

export interface MediaImageLayoutCapability {
  method: MediaImageLayoutMethod;
  modelId: string;
  revision: string | null;
  adapter: string | null;
  published: boolean;
  integrated: boolean;
  installed: boolean;
  inference: "unverified" | "verified";
  verificationAssetId: string | null;
  error: string | null;
}

export function resolveMediaImageLayoutCapabilities(model: MediaModelDescriptor, models: readonly MediaModelDescriptor[], layout?: MediaImageLayout): MediaImageLayoutCapability[] {
  const local = model.providerId === "local-diffusers" && model.target === "local" && model.architecture !== "ideogram-4";
  const native = local && ["moss-image-base", "moss-image-sft", "flux-3-image-klein"].includes(model.architecture ?? "");
  const composition = local && model.capabilities.includes("text-to-image");
  const maskAdapter = local && ["flux-2", "stable-diffusion-1", "stable-diffusion-2", "stable-diffusion-xl", "pony", "flux-1", "krea-2"].includes(model.architecture ?? "");
  const referenceAdapter = local && model.capabilities.includes("image-to-image");
  const needsCutout = layout?.elements.some((element) => element.kind === "object" && element.cutout !== false);
  const cutout = models.find((entry) => entry.id === "local:birefnet-matting");
  return (["native", "composition", "reference", "masked"] as const).map((method) => {
    const integrated = method === "native" ? native : method === "composition" ? composition : method === "reference" ? referenceAdapter : maskAdapter;
    const published = method === "native" ? native : method === "composition" ? composition : local && model.capabilities.includes(method === "reference" ? "image-to-image" : "masked-image-edit");
    const error = !integrated ? "This model has no adapter for this layout method."
      : !model.installed ? `Install ${model.displayName}.`
        : !model.configured || model.runtimeReadiness === "runtime-unavailable" ? "Set up the local image runtime."
          : model.runtimeReadiness === "failed" ? model.runtimeReadinessDiagnostic ?? "Repair the selected model runtime before generating."
          : method !== "native" && needsCutout && !cutout?.installed ? "Install BiRefNet for subject cutouts."
            : method !== "native" && !composition && layout?.elements.some((element) => element.kind === "object" && !element.assetId) ? "Choose an asset for every object; this model only edits images."
              : method === "masked" && (layout?.elements.filter((element) => element.kind === "object").length ?? 0) > 16 ? "Use at most 16 objects for masked insertion."
            : method === "native" && layout?.elements.some((element) => element.kind === "object" && element.assetId) ? "Use composition for layout assets."
              : null;
    const verification = model.layoutVerifications?.find((entry) => entry.method === method && entry.revision === model.installedRevision && entry.workerVersion === "media-diffusers-worker/1.113.0");
    return { method, modelId: model.id, revision: model.installedRevision ?? null,
      adapter: integrated ? method === "native" ? `${model.architecture}/layout-v1` : `machdoch-compositor/resvg-0.47/alpha4/${method === "reference" ? "reference-regions-v1" : method}/${model.architecture}` : null,
      published, integrated, installed: model.installed, inference: verification ? "verified" : "unverified", verificationAssetId: verification?.assetId ?? null, error };
  });
}

export function mediaImageLayoutCapabilityError(model: MediaModelDescriptor | null, models: readonly MediaModelDescriptor[], layout: MediaImageLayout, method?: MediaImageLayoutMethod): string | null {
  if (!model) return "Choose an installed local model for this layout.";
  if (!method) return "Choose a layout method.";
  return resolveMediaImageLayoutCapabilities(model, models, layout).find((entry) => entry.method === method)?.error ?? null;
}
