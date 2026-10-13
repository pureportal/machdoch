import { createRoot } from "react-dom/client";
import { mockIPC } from "@tauri-apps/api/mocks";
import { MediaStudio } from "@machdoch/media-studio/tauri/ui/media/media-studio.js";
import { DEFAULT_MEDIA_STUDIO_STATE } from "@machdoch/media-studio/tauri/ui/media/media-studio-store.js";
import { initializeMediaRuntime } from "@machdoch/media-studio/tauri/ui/media/media-runtime.js";
import { createMediaModelCatalogSnapshot } from "@machdoch/media-studio/core/media/catalog.js";
import { TooltipProvider } from "@machdoch/media-studio/tauri/ui/components/ui/tooltip.js";
import { MEDIA_IMAGE_SAMPLING_PROFILES as samplingProfiles } from "@machdoch/media-studio/core/media/image-sampling.js";
import "../../styles.css";

async function start() {
  const runtime = await initializeMediaRuntime();
  const catalog = createMediaModelCatalogSnapshot({
    isLocalFluxInstalled: true,
    isOpenAiConfigured: false,
  });
  const template = catalog.models.find(
    (model) => model.id === "local:flux-2-klein-4b",
  )!;
  catalog.models.push({
    ...template,
    id: "test:sdxl",
    displayName: "SDXL",
    family: "SDXL",
    architecture: "stable-diffusion-xl",
  });
  catalog.models.push({
    ...template,
    id: "test:qwen-2.1",
    displayName: "Qwen-Image 2.1",
    family: "Qwen-Image",
    architecture: "qwen-image-2.1",
  });
  for (const profile of samplingProfiles) {
    if (
      catalog.models.some(
        (model) => model.architecture === profile.architecture,
      )
    )
      continue;
    catalog.models.push({
      ...template,
      id: `test:${profile.architecture}`,
      displayName: profile.architecture,
      architecture: profile.architecture as typeof template.architecture,
    });
  }
  catalog.models = catalog.models
    .filter((model) => model.target === "local")
    .map((model) => ({
      ...model,
      installed: true,
      installationStatus: "installed",
      runtimeReadiness: "ready",
      capabilities: ["text-to-image"],
    }));
  Object.assign(window, {
    imageSamplingEngineFixtures: samplingProfiles.map((profile) => {
      const model = catalog.models.find(
        (candidate) => candidate.architecture === profile.architecture,
      )!;
      return {
        id: model.id,
        name: model.displayName,
        architecture: profile.architecture,
        steps: profile.steps,
        samplerChoices: profile.samplers.length + 1,
      };
    }),
  });
  const key = "machdoch.desktop.media-studio-state";
  if (!localStorage.getItem(key))
    localStorage.setItem(
      key,
      JSON.stringify({
        ...DEFAULT_MEDIA_STUDIO_STATE,
        recipe: {
          ...DEFAULT_MEDIA_STUDIO_STATE.recipe,
          modelId: "test:sdxl",
          prompt: "An overgrown city painted in vivid colors",
        },
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
          directGenerationModelIds: catalog.models.map((model) => model.id),
          localDiffusers: {
            ...runtime.localDiffusers,
            status: "ready",
            ready: true,
            architectures: catalog.models.map((model) => model.architecture),
          },
        };
      if (command === "media_get_model_catalog") return catalog;
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
      throw new Error(
        `Unhandled image sampling verification command: ${command}`,
      );
    },
    { shouldMockEvents: true },
  );
  createRoot(document.getElementById("root")!).render(
    <TooltipProvider>
      <main className="h-dvh bg-slate-950 text-slate-100">
        <MediaStudio
          onOpenPoseChat={() => undefined}
          providerStatuses={[]}
          workspaceRoot={null}
          onOpenProviderSettings={() => undefined}
        />
      </main>
    </TooltipProvider>,
  );
}

void start();
