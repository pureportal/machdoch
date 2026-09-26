import * as runtime from "../../packages/media-studio/src/tauri/ui/media/media-runtime.ts";
import { createMediaModelCatalogSnapshot } from "../../packages/media-studio/src/core/media/catalog.ts";
import type { MediaRequest } from "../../packages/fleet-protocol/src/media.ts";

export function createMediaFixture() {
  const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
  const operations = new Map<string, Promise<string>>();
  let stored: unknown = null;
  const catalog = createMediaModelCatalogSnapshot({ isOpenAiConfigured: true });
  const assets = Array.from({ length: 260 }, (_, index) => ({
    id: `asset-${index}`,
    runId: "import",
    digest: "d".repeat(64),
    kind: "image",
    mimeType: "image/png",
    byteSize: 100,
    width: 512,
    height: 512,
    createdAt: new Date().toISOString(),
    outputIndex: index,
    fixture: false,
    operation: { kind: "local-import" },
    sourceAssetIds: [],
    tags: [],
  }));
  const model = {
    id: 10,
    name: "Age Slider LoRA",
    type: "LORA",
    description: "",
    matchedVersionId: null,
    nsfw: false,
    tags: [],
    creator: { username: "Fixture" },
    stats: {},
    modelVersions: [
      {
        id: 101,
        name: "v1",
        baseModel: "SDXL 1.0",
        publishedAt: null,
        trainedWords: ["age"],
        files: [
          {
            id: 1001,
            name: "age.safetensors",
            type: "Model",
            sizeKB: 20,
            primary: true,
            hashes: { SHA256: "a".repeat(64) },
            metadata: { format: "SafeTensor" },
            pickleScanResult: "Success",
            virusScanResult: "Success",
          },
        ],
        images: [],
      },
    ],
  };
  const invoke = async (
    command: string,
    args: Record<string, unknown>,
  ): Promise<unknown> => {
    calls.push({ command, args });
    switch (command) {
      case "media_read_studio_state":
        return stored;
      case "media_write_studio_state":
        stored = args.value;
        return null;
      case "media_initialize_runtime":
        return { ...(await runtime.initializeMediaRuntime()), mode: "native" };
      case "media_get_runtime_setup":
        return {
          phase: "ready",
          downloadPercent: null,
          message: "",
          diagnostic: null,
        };
      case "media_get_model_catalog":
        return catalog;
      case "media_discover_workspace_models":
        return {
          ...(await runtime.discoverMediaWorkspaceModels(
            String(args.workspaceRoot),
          )),
          warnings: [],
        };
      case "media_list_asset_page":
        return {
          schemaVersion: 1,
          revision: "assets-1",
          offset: args.offset,
          unchanged: false,
          totalItems: assets.length,
          items: assets.slice(
            Number(args.offset),
            Number(args.offset) + Number(args.limit),
          ),
        };
      case "media_list_runs":
        return runtime.listMediaRuns();
      case "media_list_assets":
        return assets;
      case "media_list_run_page": {
        const items = await runtime.listMediaRuns();
        return {
          schemaVersion: 1,
          revision: JSON.stringify(items.map((item) => item.updatedAt)),
          offset: args.offset,
          unchanged: false,
          totalItems: items.length,
          items: items.slice(
            Number(args.offset),
            Number(args.offset) + Number(args.limit),
          ),
        };
      }
      case "media_read_asset_preview":
        return {
          binary:
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jGZkAAAAASUVORK5CYII=",
        };
      case "media_list_flows":
        return runtime.listMediaFlows();
      case "media_get_flow":
        return runtime.getMediaFlow(String(args.flowId));
      case "media_save_flow_revision":
        return runtime.saveMediaFlowRevision(
          args.request as Parameters<typeof runtime.saveMediaFlowRevision>[0],
        );
      case "run_media_flow_agent":
        return { message: "The flow is ready.", flow: null };
      case "media_generate_images":
        return runtime.generateMediaImages(
          args.request as Parameters<typeof runtime.generateMediaImages>[0],
        );
      case "media_get_run_detail":
        return runtime.getMediaRunDetail(String(args.runId));
      case "media_cancel_run":
        return runtime.cancelMediaRun(String(args.runId));
      case "media_civitai_connection":
        return false;
      case "media_civitai_options":
        return {
          modelTypes: ["Checkpoint", "LORA", "TextualInversion"],
          baseModels: ["SDXL 1.0"],
          baseModelsByType: {
            Checkpoint: ["SDXL 1.0"],
            LORA: ["SDXL 1.0"],
            TextualInversion: ["SDXL 1.0"],
          },
        };
      case "media_search_civitai":
        return { items: [model], nextCursor: null };
      case "media_get_civitai_model":
        return model;
      default:
        throw new Error(`Unmocked media operation: ${command}`);
    }
  };
  return {
    calls,
    async request(request: MediaRequest): Promise<unknown> {
      if (request.kind === "events")
        return { state: "events", cursor: 0, events: [] };
      if (request.kind === "release") {
        operations.delete(request.id);
        return { state: "complete", chunk: "", offset: 0, total: 0 };
      }
      if (request.kind === "invoke") {
        const result = invoke(request.command, request.args).then((value) =>
          btoa(
            Array.from(
              new TextEncoder().encode(JSON.stringify(value)),
              (byte) => String.fromCharCode(byte),
            ).join(""),
          ),
        );
        void result.catch(() => undefined);
        operations.set(request.id, result);
        return { state: "pending" };
      }
      try {
        const result = await operations.get(request.id);
        if (!result) throw new Error("Missing fixture operation");
        return {
          state: "complete",
          chunk: result.slice(request.offset, request.offset + 262144),
          offset: request.offset,
          total: result.length,
        };
      } catch (error) {
        return {
          state: "failed",
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}
