import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import type {
  MediaGenerationTarget,
  MediaModelCatalogSnapshot,
  MediaModelDescriptor,
  MediaStudioSection,
  MediaStudioState,
} from "../../../core/media/contracts.js";
import {
  CIVITAI_DEFAULT_SEARCH,
  civitaiModelUrl,
  civitaiVisibleImages,
  type CivitaiModel,
  type CivitaiOptions,
} from "../../../core/media/civitai.js";
import { listSelectableMediaModels } from "../../../core/media/model-library.js";
import type { AppControlAction } from "../app-control/app-control-registry";
import {
  APP_CONTROL_LEVEL,
  useAppControlView,
} from "../app-control/use-app-control";
import { civitaiRuntime } from "./civitai-runtime";
import { enqueueCivitaiDownload } from "./civitai-download-queue";
import { loadCivitaiPreferences } from "./civitai-preferences";
import {
  MEDIA_TARGET_LABELS,
  addMediaAddonSelection,
  civitaiBaseModelsFor,
  compareCivitaiResults,
  describeCivitaiResult,
  describeInstalledMediaAddons,
  describeMediaAddonSelections,
  describeMediaModel,
  mediaTargetModelId,
  mediaTargetPrompt,
  updateMediaAddonSelection,
  withMediaTargetPrompt,
} from "./media-app-control-model";
import { mediaImportQueue } from "./media-import-queue";
import type { MediaGenerationQueueJob } from "./media-generation-queue";

const SECTION_LABELS: Readonly<Record<MediaStudioSection, string>> = {
  generate: "Basic",
  flow: "Advanced",
  upscale: "Upscale",
  train: "Train",
  library: "Assets",
  runs: "Activity",
};
const SECTIONS = Object.keys(SECTION_LABELS) as MediaStudioSection[];
const TARGETS = Object.keys(MEDIA_TARGET_LABELS) as MediaGenerationTarget[];
const CIVITAI_TYPES = ["LORA", "Checkpoint", "TextualInversion"] as const;
const CIVITAI_SORTS = ["Most Downloaded", "Highest Rated", "Newest"] as const;
const MAX_PARALLEL_BASE_MODEL_SEARCHES = 4;
const INSTALL_TIMEOUT_MS = 15 * 60_000;
const CATALOG_REFRESH_ATTEMPTS = 8;
const CATALOG_REFRESH_DELAY_MS = 400;
const STATE_PROMPT_CHARS = 2_000;
const ASPECT_RATIOS = ["1:1", "4:5", "16:9", "9:16"] as const;

const strengthSchema = {
  type: "number",
  minimum: -2,
  maximum: 2,
  description: "LoRA strength; 1 is the default.",
} as const;

export interface MediaAppControlOptions {
  enabled: boolean;
  state: MediaStudioState;
  setState: Dispatch<SetStateAction<MediaStudioState>>;
  catalog: MediaModelCatalogSnapshot;
  runnableImageModelIds: readonly string[] | null;
  generationJobs: readonly MediaGenerationQueueJob[];
  refreshCatalog: () => Promise<MediaModelCatalogSnapshot | null>;
  onSelectSection: (section: MediaStudioSection) => void;
  onSelectTarget: (target: MediaGenerationTarget) => void;
  onUseModel: (model: MediaModelDescriptor) => void;
}

export function useMediaAppControl({
  enabled,
  state,
  setState,
  catalog,
  runnableImageModelIds,
  generationJobs,
  refreshCatalog,
  onSelectSection,
  onSelectTarget,
  onUseModel,
}: MediaAppControlOptions): void {
  const latest = useRef({ state, catalog });
  latest.current = { state, catalog };
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const civitaiOptions = useRef<Promise<CivitaiOptions> | null>(null);
  const loadCivitaiOptions = (): Promise<CivitaiOptions> => {
    civitaiOptions.current ??= civitaiRuntime.options().catch((error) => {
      civitaiOptions.current = null;
      throw error;
    });
    return civitaiOptions.current;
  };
  const selectedModel = (): MediaModelDescriptor | undefined => {
    const { state: current, catalog: currentCatalog } = latest.current;
    return currentCatalog.models.find(
      ({ id }) => id === mediaTargetModelId(current),
    );
  };
  const installedDigests = (): Set<string> =>
    new Set(
      [
        ...latest.current.catalog.models.map(
          (model) => model.installedRevision,
        ),
        ...latest.current.catalog.addons.map((addon) => addon.digest),
      ]
        .filter((value): value is string => Boolean(value))
        .map((value) => value.toLowerCase()),
    );
  const apply = <T>(
    transform: (current: MediaStudioState) => {
      state: MediaStudioState;
      result: T;
    },
  ): T => {
    const { state: next, result } = transform(latest.current.state);
    latest.current = { ...latest.current, state: next };
    setState((current) => {
      if (current === next) return current;
      try {
        return transform(current).state;
      } catch {
        return current;
      }
    });
    return result;
  };
  const waitForAddon = async (
    resourceId: string,
    signal: AbortSignal,
  ): Promise<void> => {
    for (let attempt = 0; attempt < CATALOG_REFRESH_ATTEMPTS; attempt += 1) {
      const refreshed = await refreshCatalog();
      signal.throwIfAborted();
      const addons = refreshed?.addons ?? latest.current.catalog.addons;
      if (addons.some(({ id }) => id === resourceId)) {
        latest.current = {
          ...latest.current,
          catalog: { ...latest.current.catalog, addons },
        };
        return;
      }
      if (latest.current.catalog.models.some(({ id }) => id === resourceId))
        return;
      await new Promise((resolve) =>
        setTimeout(resolve, CATALOG_REFRESH_DELAY_MS),
      );
    }
  };

  const location = [
    SECTION_LABELS[state.activeSection],
    ...(state.activeSection === "generate"
      ? [MEDIA_TARGET_LABELS[state.target]]
      : []),
  ];

  const actions: AppControlAction[] = [
    {
      id: "media.open_section",
      description: `Show a Media Studio section: ${SECTIONS.map((section) => `${section} (${SECTION_LABELS[section]})`).join(", ")}.`,
      effect: "write",
      input: {
        type: "object",
        properties: { section: { type: "string", enum: SECTIONS } },
        required: ["section"],
      },
      run: (input) => {
        onSelectSection(input.section as MediaStudioSection);
        return { section: SECTION_LABELS[input.section as MediaStudioSection] };
      },
    },
    {
      id: "media.set_target",
      description:
        "Choose what Basic creates: image, video, svg, audio, or splat (3D).",
      effect: "write",
      input: {
        type: "object",
        properties: { target: { type: "string", enum: TARGETS } },
        required: ["target"],
      },
      run: (input) => {
        onSelectSection("generate");
        onSelectTarget(input.target as MediaGenerationTarget);
        return {
          target: MEDIA_TARGET_LABELS[input.target as MediaGenerationTarget],
        };
      },
    },
    {
      id: "media.set_prompt",
      description: "Replace the Basic prompt for the current media type.",
      effect: "write",
      input: {
        type: "object",
        properties: { prompt: { type: "string", maxLength: 8_000 } },
        required: ["prompt"],
      },
      run: (input) =>
        apply((current) => ({
          state: withMediaTargetPrompt(current, String(input.prompt)),
          result: { prompt: String(input.prompt) },
        })),
    },
    {
      id: "media.set_image_options",
      description:
        "Change Basic image output: aspect ratio, number of images, and seed (-1 for random).",
      effect: "write",
      input: {
        type: "object",
        properties: {
          aspectRatio: { type: "string", enum: ASPECT_RATIOS },
          outputCount: { type: "integer", minimum: 1, maximum: 8 },
          seed: {
            type: "integer",
            minimum: -1,
            maximum: Number.MAX_SAFE_INTEGER,
          },
        },
      },
      run: (input) =>
        apply((current) => {
          if (current.target !== "image")
            throw new Error("Switch Basic to Image first.");
          const recipe = {
            ...current.recipe,
            ...(typeof input.aspectRatio === "string"
              ? {
                  aspectRatio:
                    input.aspectRatio as (typeof ASPECT_RATIOS)[number],
                }
              : {}),
            ...(typeof input.outputCount === "number"
              ? { outputCount: input.outputCount }
              : {}),
            ...(typeof input.seed === "number"
              ? { seed: input.seed < 0 ? null : input.seed }
              : {}),
          };
          return {
            state: { ...current, recipe },
            result: {
              aspectRatio: recipe.aspectRatio,
              outputCount: recipe.outputCount,
              seed: recipe.seed ?? null,
            },
          };
        }),
    },
    {
      id: "media.list_models",
      description: "List ready models for the current media type.",
      effect: "read",
      input: { type: "object", properties: {} },
      run: () => {
        const { state: current, catalog: currentCatalog } = latest.current;
        return listSelectableMediaModels(currentCatalog.models, {
          target: current.target,
          allowedModelIds:
            current.target === "image" ? runnableImageModelIds : null,
        }).map(describeMediaModel);
      },
    },
    {
      id: "media.select_model",
      description:
        "Use a model in Basic. Incompatible LoRAs are dropped from the list.",
      effect: "write",
      input: {
        type: "object",
        properties: { modelId: { type: "string", minLength: 1 } },
        required: ["modelId"],
      },
      run: (input) => {
        const target = latest.current.catalog.models.find(
          ({ id }) => id === input.modelId,
        );
        if (!target)
          throw new Error("No model has that id. Use media.list_models.");
        onUseModel(target);
        return describeMediaModel(target);
      },
    },
    {
      id: "media.list_loras",
      description:
        "List installed LoRAs and embeddings with compatibility for the selected model and their trigger words.",
      effect: "read",
      input: {
        type: "object",
        properties: { query: { type: "string", maxLength: 200 } },
      },
      run: (input) =>
        describeInstalledMediaAddons(
          latest.current.state,
          latest.current.catalog,
          typeof input.query === "string" ? input.query : "",
        ),
    },
    {
      id: "media.add_lora",
      description:
        "Add an installed LoRA or embedding to the current list and, by default, its first trigger word to the prompt.",
      effect: "write",
      input: {
        type: "object",
        properties: {
          addonId: { type: "string", minLength: 1 },
          strength: strengthSchema,
          insertTriggerWords: { type: "boolean" },
        },
        required: ["addonId"],
      },
      run: (input) =>
        apply((current) => {
          const added = addMediaAddonSelection(
            current,
            latest.current.catalog,
            String(input.addonId),
            {
              ...(typeof input.strength === "number"
                ? { strength: input.strength }
                : {}),
              ...(typeof input.insertTriggerWords === "boolean"
                ? { insertTriggerWords: input.insertTriggerWords }
                : {}),
            },
          );
          return {
            state: added.state,
            result: {
              insertedTrigger: added.insertedTrigger,
              loras: describeMediaAddonSelections(
                added.state,
                latest.current.catalog.addons,
              ),
            },
          };
        }),
    },
    {
      id: "media.update_lora",
      description: "Change the strength of a listed LoRA or turn it on or off.",
      effect: "write",
      input: {
        type: "object",
        properties: {
          addonId: { type: "string", minLength: 1 },
          strength: strengthSchema,
          enabled: { type: "boolean" },
        },
        required: ["addonId"],
      },
      run: (input) =>
        apply((current) => {
          const next = updateMediaAddonSelection(
            current,
            String(input.addonId),
            {
              ...(typeof input.strength === "number"
                ? { strength: input.strength }
                : {}),
              ...(typeof input.enabled === "boolean"
                ? { enabled: input.enabled }
                : {}),
            },
          );
          return {
            state: next,
            result: describeMediaAddonSelections(
              next,
              latest.current.catalog.addons,
            ),
          };
        }),
    },
    {
      id: "media.remove_lora",
      description: "Remove a LoRA or embedding from the current list.",
      effect: "write",
      input: {
        type: "object",
        properties: { addonId: { type: "string", minLength: 1 } },
        required: ["addonId"],
      },
      run: (input) =>
        apply((current) => {
          const next = updateMediaAddonSelection(
            current,
            String(input.addonId),
            { remove: true },
          );
          return {
            state: next,
            result: describeMediaAddonSelections(
              next,
              latest.current.catalog.addons,
            ),
          };
        }),
    },
    {
      id: "media.search_civitai",
      description:
        "Search Civitai. Without baseModel it searches every base model compatible with the selected model. Results mark compatible and installed versions.",
      effect: "read",
      timeoutMs: 60_000,
      input: {
        type: "object",
        properties: {
          query: { type: "string", minLength: 1, maxLength: 200 },
          type: { type: "string", enum: CIVITAI_TYPES },
          baseModel: {
            type: "string",
            description: "Civitai base model name, such as SDXL 1.0.",
          },
          sort: { type: "string", enum: CIVITAI_SORTS },
          limit: { type: "integer", minimum: 1, maximum: 20 },
        },
        required: ["query"],
      },
      run: async (input) => {
        const options = await loadCivitaiOptions();
        const modelType = typeof input.type === "string" ? input.type : "LORA";
        const current = selectedModel();
        const sort =
          typeof input.sort === "string" ? input.sort : "Most Downloaded";
        const baseModels =
          typeof input.baseModel === "string"
            ? [input.baseModel]
            : modelType === "Checkpoint"
              ? [""]
              : civitaiBaseModelsFor(current, options, modelType).slice(
                  0,
                  MAX_PARALLEL_BASE_MODEL_SEARCHES,
                );
        if (baseModels.length === 0)
          throw new Error(
            current
              ? `Civitai has no ${modelType} base model for ${current.displayName}. Pass baseModel to search anyway.`
              : "Select a model first or pass baseModel.",
          );
        const preferences = await loadCivitaiPreferences();
        const pages = await Promise.allSettled(
          baseModels.map((baseModel) =>
            civitaiRuntime.search({
              ...CIVITAI_DEFAULT_SEARCH,
              query: String(input.query),
              modelType,
              baseModel,
              sort,
              contentMode: preferences.contentMode,
            }),
          ),
        );
        const failures = pages.flatMap((page) =>
          page.status === "rejected" ? [page.reason] : [],
        );
        if (failures.length === pages.length) throw failures[0];
        const byId = new Map<number, CivitaiModel>();
        for (const page of pages)
          if (page.status === "fulfilled")
            for (const item of page.value.items)
              if (!byId.has(item.id)) byId.set(item.id, item);
        const digests = installedDigests();
        return {
          baseModels: baseModels.filter(Boolean),
          ...(failures.length > 0
            ? {
                partial: `${failures.length} of ${pages.length} searches failed.`,
              }
            : {}),
          results: [...byId.values()]
            .sort(compareCivitaiResults(sort))
            .slice(0, typeof input.limit === "number" ? input.limit : 8)
            .map((item) =>
              describeCivitaiResult(item, options, current, digests),
            ),
        };
      },
    },
    {
      id: "media.install_civitai",
      description:
        "Download a Civitai model, LoRA, or embedding into the library and wait until it is imported. LoRAs and embeddings are added to the current list with their trigger word unless addToList is false.",
      effect: "write",
      timeoutMs: INSTALL_TIMEOUT_MS,
      input: {
        type: "object",
        properties: {
          modelId: { type: "integer", minimum: 1 },
          versionId: { type: "integer", minimum: 1 },
          addToList: { type: "boolean" },
          strength: strengthSchema,
        },
        required: ["modelId"],
      },
      run: async (input, { signal }) => {
        const preferences = await loadCivitaiPreferences();
        const mature = preferences.contentMode !== "normal";
        const requestedVersion =
          typeof input.versionId === "number" ? input.versionId : null;
        const civitaiModel = await civitaiRuntime.getModel(
          requestedVersion
            ? `${input.modelId}@${requestedVersion}`
            : String(input.modelId),
          mature,
        );
        const version =
          civitaiModel.modelVersions.find(
            ({ id }) => id === requestedVersion,
          ) ??
          civitaiModel.modelVersions.find(
            ({ id }) => id === civitaiModel.matchedVersionId,
          ) ??
          civitaiModel.modelVersions[0];
        if (!version)
          throw new Error(
            "This Civitai model has no version Machdoch supports.",
          );
        const file =
          version.files.find((candidate) => candidate.primary) ??
          version.files.find((candidate) =>
            candidate.name.toLowerCase().endsWith(".safetensors"),
          ) ??
          version.files[0];
        if (!file) throw new Error("This Civitai version has no file.");
        const digest = file.hashes?.SHA256?.toLowerCase();
        const alreadyInstalled = digest
          ? (latest.current.catalog.addons.find(
              (addon) => addon.digest.toLowerCase() === digest,
            )?.id ??
            latest.current.catalog.models.find(
              (model) => model.installedRevision?.toLowerCase() === digest,
            )?.id)
          : undefined;
        let resourceId = alreadyInstalled;
        if (!resourceId) {
          const source = civitaiModelUrl(civitaiModel, version.id);
          const inspection = await civitaiRuntime.inspect(source, file.id);
          signal.throwIfAborted();
          const queuedIds = new Set(
            mediaImportQueue.getSnapshot().map(({ id }) => id),
          );
          const jobId = enqueueCivitaiDownload({
            label: `${civitaiModel.name} · ${version.name}`,
            source,
            inspection,
            images: civitaiVisibleImages(civitaiModel, version, mature),
          });
          const cancelOwnDownload = (): void => {
            if (!queuedIds.has(jobId)) mediaImportQueue.cancel(jobId);
          };
          signal.addEventListener("abort", cancelOwnDownload, { once: true });
          try {
            resourceId = await mediaImportQueue.waitFor(jobId, signal);
          } finally {
            signal.removeEventListener("abort", cancelOwnDownload);
          }
          await waitForAddon(resourceId, signal);
        }
        const merged = latest.current.catalog;
        const addon = merged.addons.find(({ id }) => id === resourceId);
        const installed = {
          resourceId,
          name: addon?.displayName ?? civitaiModel.name,
          kind: addon?.kind ?? "model",
          triggerWords: addon?.triggerWords ?? version.trainedWords,
          ...(alreadyInstalled ? { alreadyInstalled: true } : {}),
        };
        if (!addon || input.addToList === false) return { installed };
        if (!mounted.current)
          return {
            installed,
            added: false,
            reason:
              "Media Studio closed before the LoRA was added. Open Media Studio and use media.add_lora.",
          };
        try {
          const insertedTrigger = apply((current) => {
            const added = addMediaAddonSelection(
              current,
              merged,
              addon.id,
              typeof input.strength === "number"
                ? { strength: input.strength }
                : {},
            );
            return { state: added.state, result: added.insertedTrigger };
          });
          return { installed, added: true, insertedTrigger };
        } catch (error) {
          return {
            installed,
            added: false,
            reason: error instanceof Error ? error.message : String(error),
          };
        }
      },
    },
  ];

  useAppControlView(
    "media",
    APP_CONTROL_LEVEL.view,
    enabled
      ? {
          location,
          state: () => {
            const current = latest.current.state;
            const prompt = mediaTargetPrompt(current);
            const selected = selectedModel();
            return {
              section: SECTION_LABELS[current.activeSection],
              target: current.target,
              prompt:
                prompt.length > STATE_PROMPT_CHARS
                  ? `${prompt.slice(0, STATE_PROMPT_CHARS)}…`
                  : prompt,
              model: selected ? describeMediaModel(selected) : null,
              loras: describeMediaAddonSelections(
                current,
                latest.current.catalog.addons,
              ),
              ...(current.target === "image"
                ? {
                    image: {
                      aspectRatio: current.recipe.aspectRatio,
                      outputCount: current.recipe.outputCount,
                      outputFormat: current.recipe.outputFormat,
                      seed: current.recipe.seed ?? null,
                    },
                  }
                : {}),
              activeGenerations: generationJobs.filter((job) =>
                ["queued", "running", "canceling"].includes(job.status),
              ).length,
              installedLoraCount: latest.current.catalog.addons.length,
            };
          },
          actions,
        }
      : null,
  );
}
