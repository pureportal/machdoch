import { createRoot } from "react-dom/client";
import { useState } from "react";
import { mockIPC } from "@tauri-apps/api/mocks";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { MediaStudio } from "@machdoch/media-studio/tauri/ui/media/media-studio.js";
import { configureRemoteMediaPlatform } from "@machdoch/media-studio/tauri/ui/media/media-platform.js";
import { DEFAULT_MEDIA_STUDIO_STATE } from "@machdoch/media-studio/tauri/ui/media/media-studio-store.js";
import { initializeMediaRuntime } from "@machdoch/media-studio/tauri/ui/media/media-runtime.js";
import { createMediaModelCatalogSnapshot } from "@machdoch/media-studio/core/media/catalog.js";
import type { MediaModelAddonDescriptor } from "@machdoch/media-studio/core/media/contracts.js";
import { TooltipProvider } from "@machdoch/media-studio/tauri/ui/components/ui/tooltip.js";
import "../styles.css";

async function start() {
  const runtime = await initializeMediaRuntime();
  const catalog = createMediaModelCatalogSnapshot({
    isLocalFluxInstalled: true,
    isOpenAiConfigured: false,
  });
  const modelId = "local:flux-2-klein-4b";
  const names = [
    "Portrait Detail",
    "Watercolor Landscapes",
    "Cinematic Light",
    "Architectural Linework",
    "Soft Film Grain",
    "Botanical Illustration",
    "Hand-painted Storybook Textures and Fine Details",
    "Vintage Photography",
  ];
  catalog.addons = names.map(
    (displayName, index): MediaModelAddonDescriptor => ({
      id: `addon:${index}`,
      kind: "lora",
      displayName,
      architecture: "flux-2",
      architectureConfidence: "high",
      format: "safetensors",
      targetComponents: ["denoiser"],
      embeddingVectors: [],
      loraProfile: {
        algorithm: "lora",
        dialect: "diffusers-peft",
        rankMinimum: 16,
        rankMaximum: 16,
        heterogeneousRanks: false,
        targetModuleCount: 64,
        convolutionTargetCount: 0,
        magnitudeVectorCount: 0,
        networkAlphaCount: 64,
      },
      baseModelHint: "FLUX.2",
      triggerWords: [],
      defaultToken: null,
      digest: String(index).repeat(64),
      headerDigest: "a".repeat(64),
      byteSize: 1000,
      relativePath: `${index}.safetensors`,
      sourceUrl: null,
      license: {
        name: "Test",
        spdxId: null,
        sourceUrl: "https://example.test/license",
        commercialUse: "allowed",
        requiresAcceptance: false,
      },
      importedAt: "2026-09-20T10:00:00Z",
    }),
  );
  const key = "machdoch.desktop.media-studio-state";
  if (!localStorage.getItem(key))
    localStorage.setItem(
      key,
      JSON.stringify({
        ...DEFAULT_MEDIA_STUDIO_STATE,
        recipe: { ...DEFAULT_MEDIA_STUDIO_STATE.recipe, modelId },
        assetMetadata: Object.fromEntries(
          catalog.addons.map((addon, index) => [
            addon.id,
            {
              categoryIds: [],
              tags: [],
              triggerWords: "",
              sourceUrl: null,
              sampleAssetIds: [],
              sampleImages:
                index % 3 === 0
                  ? []
                  : [
                      {
                        url: `https://image.civitai.com/settings-review/${index}.svg`,
                        width: 400,
                        height: 400,
                      },
                    ],
            },
          ]),
        ),
      }),
    );
  Object.assign(window, { isTauri: true });
  mockIPC(
    async (command, payload) => {
      const args = payload as Record<string, unknown>;
      if (command === "plugin:store|load") return 1;
      if (command === "plugin:store|get") {
        const raw = localStorage.getItem(String(args.key));
        return [raw ? JSON.parse(raw) : null, Boolean(raw)];
      }
      if (command === "plugin:store|set") {
        localStorage.setItem(String(args.key), JSON.stringify(args.value));
        return;
      }
      if (command === "plugin:store|save") return;
      if (command === "media_read_studio_state")
        return JSON.parse(localStorage.getItem(key)!);
      if (command === "media_write_studio_state") {
        localStorage.setItem(key, JSON.stringify(args.value));
        return;
      }
      if (command === "media_initialize_runtime")
        return {
          ...runtime,
          mode: "native",
          directGenerationModelIds: [modelId],
          directReferenceImageModelIds: [modelId],
          localDiffusers: {
            ...runtime.localDiffusers,
            status: "ready",
            ready: true,
            architectures: ["flux-2"],
          },
        };
      if (command === "media_get_model_catalog") {
        await new Promise((resolve) => setTimeout(resolve, 900));
        return catalog;
      }
      if (command === "media_plan_model_install") {
        const model = catalog.models.find(
          (model) => model.id === args.modelId,
        )!;
        const totalBytes = (model.expectedDownloadGb ?? 0) * 1024 ** 3;
        return {
          schemaVersion: 1,
          modelId: model.id,
          displayName: model.displayName,
          revision: "review",
          manifestDigest: "a".repeat(64),
          licenseDigest: "b".repeat(64),
          reviewToken: "c".repeat(64),
          sourceUrl: model.license.sourceUrl,
          targetLabel: "models",
          files: [],
          excludedPaths: [],
          totalBytes,
          requiredWorkingBytes: totalBytes * 1.12,
          availableBytes: 100 * 1024 ** 3,
          hasSufficientSpace: true,
          alreadyInstalled: false,
          license: model.license,
          warnings: [],
        };
      }
      if (command === "media_get_runtime_setup")
        return {
          phase: "ready",
          downloadPercent: null,
          message: "",
          diagnostic: null,
        };
      if (
        command === "media_list_run_page" ||
        command === "media_list_asset_page"
      )
        return {
          schemaVersion: 1,
          revision: "empty",
          offset: args.offset,
          unchanged: false,
          totalItems: 0,
          items: [],
        };
      if (
        ["media_list_flows", "media_list_runs", "media_list_assets"].includes(
          command,
        )
      )
        return [];
      if (command === "media_get_flow")
        return {
          schemaVersion: 1,
          flowId: args.flowId,
          head: null,
          revisions: [],
        };
      throw new Error(`Unhandled settings review command: ${command}`);
    },
    { shouldMockEvents: true },
  );
  if (location.search.includes("fleet"))
    configureRemoteMediaPlatform({
      invoke,
      listen,
      storageKey: "fleet:settings-review",
      open: async () => null,
      save: async () => null,
      upload: async () => {
        throw new Error("Not used");
      },
    });
  function Review() {
    const [visible, setVisible] = useState(true);
    return (
      <TooltipProvider>
        <main className="flex h-dvh flex-col bg-slate-950 text-slate-100">
          <div className="shrink-0 border-b border-slate-800 px-4 py-2">
            <button onClick={() => setVisible(!visible)}>
              {visible ? "Leave studio" : "Enter studio"}
            </button>
          </div>
          <div className="min-h-0 flex-1">
            {visible && (
              <MediaStudio
                onOpenPoseChat={() => undefined}
                providerStatuses={[]}
                workspaceRoot={null}
                onOpenProviderSettings={() => undefined}
              />
            )}
          </div>
        </main>
      </TooltipProvider>
    );
  }
  createRoot(document.getElementById("root")!).render(<Review />);
}
void start();
