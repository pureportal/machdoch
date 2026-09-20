import { createRoot } from "react-dom/client";
import { useState } from "react";
import { mockIPC } from "@tauri-apps/api/mocks";
import { emit, listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { configureRemoteMediaPlatform } from "@machdoch/media-studio/tauri/ui/media/media-platform.js";
import type {
  CivitaiInspection,
  CivitaiModel,
} from "@machdoch/media-studio/core/media/civitai.js";
import { CivitaiBrowserDialog } from "@machdoch/media-studio/tauri/ui/media/components/civitai-browser-dialog.js";
import { Button } from "@machdoch/media-studio/tauri/ui/components/ui/button.js";
import { TooltipProvider } from "@machdoch/media-studio/tauri/ui/components/ui/tooltip.js";
import "../styles.css";

const state = {
  requests: [] as { command: string; args: Record<string, unknown> }[],
  imports: [] as { kind: string; request: unknown; metadata: unknown }[],
  copied: [] as string[],
  downloadMode: "complete" as "complete" | "hold" | "error" | "auth",
  failSearch: false,
  connected: localStorage.getItem("civitai-test-connected") === "true",
};
Object.assign(window, { isTauri: true, civitaiReview: state });
Object.defineProperty(navigator, "clipboard", {
  value: {
    writeText: async (value: string) => {
      state.copied.push(value);
    },
  },
});

const model = (id: number, name: string, type = "LORA"): CivitaiModel => ({
  id,
  name,
  type,
  description: "<p>Watercolor textures for landscapes.</p>",
  matchedVersionId: null,
  nsfw: false,
  tags: ["watercolor", "landscape"],
  creator: { username: "StudioMaker" },
  stats: { downloadCount: 12800, thumbsUpCount: 850 },
  modelVersions: [1, 2].map((version) => ({
    id: id * 10 + version,
    name: version === 1 ? "v2.0" : "v1.0",
    baseModel: "SDXL 1.0",
    publishedAt: "2026-09-10T12:00:00Z",
    trainedWords: ["watercolor", "soft edges"],
    files: [1, 2].map((file) => ({
      id: id * 100 + version * 10 + file,
      name: `${name.toLowerCase().replaceAll(" ", "_")}_${file}.safetensors`,
      type: "Model",
      sizeKB: 2048,
      primary: file === 1,
      hashes: { SHA256: String(id + version + file).padStart(64, "a") },
      metadata: {
        format: "SafeTensor",
        fp: file === 1 ? "fp16" : "fp32",
        size: "pruned",
      },
      pickleScanResult: "Success",
      virusScanResult: "Success",
    })),
    images: [1, 2].map((image) => ({
      url: `https://image.civitai.com/review/${id}-${image}.svg`,
      width: 800,
      height: 600,
      nsfw: false,
      nsfwLevel: 1,
      type: "image",
      meta: {
        prompt: "A watercolor mountain landscape at sunrise",
        negativePrompt: null,
      },
    })),
  })),
});
const models = [
  model(1, "Watercolor Landscapes"),
  model(2, "Studio XL", "Checkpoint"),
  model(3, "Soft Light", "TextualInversion"),
  model(4, "Texture Study"),
  model(5, "Linework"),
  model(6, "Night Colors"),
];
const matureModel = { ...model(7, "Mature catalog fixture"), nsfw: true };
let rejectDownload: ((reason: Error) => void) | null = null;

const inspection = (source: string, fileId: number): CivitaiInspection => {
  const modelId = Number(/models\/(\d+)/u.exec(source)![1]);
  const item = [...models, matureModel].find((item) => item.id === modelId)!;
  const versionId = Number(new URL(source).searchParams.get("modelVersionId"));
  const version = item.modelVersions.find(
    (version) => version.id === versionId,
  )!;
  const file = version.files.find((file) => file.id === fileId)!;
  return {
    schemaVersion: 1,
    canEnrich: true,
    canDownload: true,
    reviewToken: `review-${fileId}`,
    resourceType: item.type,
    blockingReason: null,
    observedAt: "2026-09-19T10:00:00Z",
    sourceUrl: source,
    air: null,
    modelId,
    versionId,
    modelName: item.name,
    versionName: version.name,
    kind:
      item.type === "Checkpoint"
        ? null
        : item.type === "TextualInversion"
          ? "textual-inversion"
          : "lora",
    baseModel: version.baseModel,
    suggestedArchitecture: "stable-diffusion-xl",
    trainedWords: version.trainedWords,
    tags: item.tags,
    sampleImages: version.images,
    creator: "StudioMaker",
    nsfw: item.nsfw,
    poi: false,
    availability: "Public",
    status: "Published",
    warnings: [],
    file: {
      id: fileId,
      name: file.name,
      byteSize: file.sizeKB * 1024,
      sha256: file.hashes!.SHA256!,
      pickleScanResult: "Success",
      virusScanResult: "Success",
      scannedAt: null,
    },
    licenseClaims: {
      allowNoCredit: false,
      allowCommercialUse: ["Image"],
      allowDerivatives: true,
      allowDifferentLicense: false,
    },
  };
};

mockIPC(
  async (command, payload) => {
    const args = payload as Record<string, unknown>;
    state.requests.push({ command, args });
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
    if (command === "media_civitai_options")
      return {
        modelTypes: ["Checkpoint", "LORA", "LoCon", "DoRA", "TextualInversion"],
        baseModels: [
          "Flux.1 S",
          "Flux.1 Krea",
          "Flux.2 Klein 4B",
          "Flux.2 Klein 4B-base",
          "Illustrious",
          "Pony",
          "SDXL 1.0",
          "SD 1.5",
          "Flux.1 D",
          "Krea 2",
          "Wan Video 2.2 TI2V-5B",
        ],
        baseModelsByType: {
          Checkpoint: ["SDXL 1.0", "SD 1.5", "Flux.1 D", "Krea 2"],
          LORA: [
            "SDXL 1.0",
            "SD 1.5",
            "Flux.1 D",
            "Krea 2",
            "Wan Video 2.2 TI2V-5B",
          ],
          LoCon: [
            "SDXL 1.0",
            "SD 1.5",
            "Flux.1 D",
            "Krea 2",
            "Wan Video 2.2 TI2V-5B",
          ],
          DoRA: [
            "SDXL 1.0",
            "SD 1.5",
            "Flux.1 D",
            "Krea 2",
            "Wan Video 2.2 TI2V-5B",
          ],
          TextualInversion: ["SDXL 1.0", "SD 1.5", "Flux.1 D"],
        },
      };
    if (command === "media_civitai_connection") return state.connected;
    if (command === "media_connect_civitai") {
      state.connected = Boolean(args.token);
      localStorage.setItem("civitai-test-connected", String(state.connected));
      return state.connected;
    }
    if (command === "media_search_civitai") {
      const request = args.request as {
        query: string;
        nsfw: boolean;
        cursor: string | null;
        modelType: string;
        period: string;
      };
      if (request.query === "slow") {
        await new Promise((resolve) => setTimeout(resolve, 700));
        return { items: [model(8, "Stale result")], nextCursor: null };
      }
      if (state.failSearch)
        throw {
          message: "Civitai rate limit reached. Wait a minute and try again.",
        };
      if (request.query === "empty") return { items: [], nextCursor: null };
      if (request.query.toLowerCase() === "age") {
        if (request.period !== "AllTime")
          return { items: [], nextCursor: null };
        if (!request.cursor) return { items: [], nextCursor: "age-2" };
        if (request.cursor === "age-2")
          return { items: [], nextCursor: "age-3" };
        return { items: [model(10, "Age Slider LoRA")], nextCursor: null };
      }
      if (request.query === "sparse") {
        const cursor = Number(request.cursor ?? 0);
        return cursor < 6
          ? { items: [], nextCursor: String(cursor + 1) }
          : { items: [model(10, "Age Slider LoRA")], nextCursor: null };
      }
      if (request.query === "cycle") {
        return { items: [], nextCursor: request.cursor === "a" ? "b" : "a" };
      }
      if (request.query === "slow-empty") {
        await new Promise((resolve) => setTimeout(resolve, 700));
        return { items: [], nextCursor: "stale-page" };
      }
      const items = request.nsfw ? [...models, matureModel] : models;
      return {
        items: request.cursor
          ? [model(9, "More Watercolors")]
          : items.filter(
              (model) => !request.modelType || model.type === request.modelType,
            ),
        nextCursor: request.cursor ? null : "page-2",
      };
    }
    if (command === "media_get_civitai_model") {
      const source = String(args.source);
      const id = /^[a-f\d]{64}$/iu.test(source)
        ? 1
        : Number(/(?:models\/|^)(\d+)/u.exec(source)?.[1] ?? 1);
      const item = [...models, matureModel].find((model) => model.id === id)!;
      if (item.nsfw && !args.nsfw)
        throw new Error("Enable mature content to view this model");
      return {
        ...item,
        matchedVersionId: /^[a-f\d]{64}$/iu.test(source) ? 12 : null,
      };
    }
    if (command === "media_inspect_civitai_file")
      return inspection(String(args.source), Number(args.fileId));
    if (command === "media_download_civitai_resource") {
      const request = args.request as {
        source: string;
        fileId: number;
        operationId: string;
      };
      await emit("media-civitai-download-progress", {
        operationId: request.operationId,
        received: 1024 * 1024,
        total: 2048 * 1024,
      });
      if (state.downloadMode === "hold")
        await new Promise((_resolve, reject) => {
          rejectDownload = reject;
        });
      if (state.downloadMode === "auth")
        throw {
          code: "MODEL_ACCESS_DENIED",
          message:
            "Civitai denied this download. Save an API key with access to this model in Settings, then try again.",
        };
      if (state.downloadMode === "error")
        throw new Error(
          "The downloaded Civitai bytes failed SHA-256 or byte-size verification",
        );
      const metadata = inspection(request.source, request.fileId);
      const local = {
        canImport: true,
        blockingReason: null,
        sourcePath: "C:\\review\\model.safetensors",
        reviewToken: "local-review",
        detectedArchitecture: "stable-diffusion-xl",
        detectedKind: metadata.kind,
        suggestedToken: "softlight",
      };
      return {
        model: metadata.resourceType === "Checkpoint" ? local : null,
        addon: metadata.resourceType === "Checkpoint" ? null : local,
        metadata,
      };
    }
    if (command === "media_cancel_civitai_download") {
      rejectDownload?.(new Error("Download cancelled"));
      return;
    }
    if (command === "plugin:opener|open_url") return;
    throw new Error(`Unhandled review command: ${command}`);
  },
  { shouldMockEvents: true },
);

function Review() {
  const [open, setOpen] = useState(true);
  return (
    <TooltipProvider>
      <main className="min-h-screen bg-slate-950 p-4 text-slate-100">
        <Button onClick={() => setOpen(true)}>Browse Civitai</Button>
        {open && (
          <CivitaiBrowserDialog
            installedHashes={new Set()}
            onClose={() => setOpen(false)}
            onImportModel={async (request, metadata) => {
              state.imports.push({ kind: "model", request, metadata });
              return true;
            }}
            onImportAddon={async (request, metadata) => {
              state.imports.push({ kind: "addon", request, metadata });
              return true;
            }}
            onImportSampleUrl={async () =>
              ({ asset: { id: "preview" } }) as never
            }
          />
        )}
      </main>
    </TooltipProvider>
  );
}

if (new URLSearchParams(location.search).has("fleet")) {
  Object.assign(window, { isTauri: false });
  configureRemoteMediaPlatform({
    invoke,
    listen,
    storageKey: "fleet:review-host",
    open: async () => null,
    save: async () => null,
    upload: async () => {
      throw new Error("No upload in this fixture");
    },
  });
}
createRoot(document.getElementById("root")!).render(<Review />);
