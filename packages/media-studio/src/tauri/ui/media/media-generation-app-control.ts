import type {
  MediaAssetRecord,
  MediaModelCatalogSnapshot,
  MediaModelInstallJob,
  MediaStudioState,
} from "../../../core/media/contracts.js";
import type { AppControlAction } from "../app-control/app-control-registry";
import {
  applyMediaTargetOptions,
  describeMediaTargetOptions,
  findMediaTargetControl,
  mediaTargetOptionSchema,
  type MediaTargetControl,
} from "./media-target-controls";
import { mediaDownloadMonitor } from "./media-download-monitor";
import { getMediaRuntimeSetup } from "./media-runtime-setup";
import { mediaImportQueue } from "./media-import-queue";
import type { MediaGenerationQueueJob } from "./media-generation-queue";
import {
  exportMediaAsset,
  getMediaModelInstallJob,
  planMediaModelInstall,
  startMediaModelInstall,
} from "./media-runtime";

const LONG_ACTION_MS = 14 * 60_000;
const POLL_MS = 1_000;
const ACTIVE_JOB_STATES = ["queued", "running", "canceling", "needs-review", "waiting-for-review"];
const ACTIVE_INSTALL_STATES = ["queued", "downloading", "verifying", "activating", "canceling"];
const MAX_LISTED_ASSETS = 50;
const ASSET_KINDS = ["image", "video", "audio", "splat", "mesh", "vector"] as const;

export interface MediaGenerationControlContext {
  readState: () => MediaStudioState;
  readCatalog: () => MediaModelCatalogSnapshot;
  readJobs: () => readonly MediaGenerationQueueJob[];
  readBlockedReason: () => string | null;
  readRuntimeError: () => string | null;
  readRuntimeReady: () => boolean;
  startRuntimeSetup: () => Promise<void>;
  generate: () => void;
  readAssets: () => readonly MediaAssetRecord[];
  apply: (transform: (state: MediaStudioState) => MediaStudioState) => void;
  importAsset: (path: string) => Promise<MediaAssetRecord>;
  refreshCatalog: () => Promise<MediaModelCatalogSnapshot | null>;
}

const wait = (milliseconds: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });

const describeAsset = (asset: MediaAssetRecord) => ({
  id: asset.id,
  kind: asset.kind,
  mimeType: asset.mimeType,
  byteSize: asset.byteSize,
  createdAt: asset.createdAt,
  ...(asset.kind === "image" || asset.kind === "video" ? { width: asset.width, height: asset.height } : {}),
});

const SUBMISSION_TIMEOUT_MS = 90_000;

const newestFirst = (
  jobs: readonly MediaGenerationQueueJob[],
): MediaGenerationQueueJob[] => [...jobs].reverse();

const waitForJob = async (
  find: () => MediaGenerationQueueJob | undefined,
  signal: AbortSignal,
): Promise<MediaGenerationQueueJob | undefined> => {
  const deadline = Date.now() + LONG_ACTION_MS;
  let job = find();
  while (job && ACTIVE_JOB_STATES.includes(job.status) && Date.now() < deadline) {
    await wait(POLL_MS, signal);
    job = find();
  }
  return job;
};

const describeJob = (job: MediaGenerationQueueJob) => ({
  runId: job.runId,
  target: job.recipe.target,
  model: job.recipe.modelLabel,
  status: job.status,
  progress: Math.round(job.progress * 100) / 100,
  step: job.currentStep,
  submittedAt: job.submittedAt,
  completedAt: job.completedAt,
  error: job.error,
  assets: job.assets.map(describeAsset),
});

const describeInstall = (job: MediaModelInstallJob) => ({
  jobId: job.id,
  modelId: job.modelId,
  name: job.displayName,
  source: job.sourceUrl,
  status: job.status,
  progress: Math.round(job.progress * 100) / 100,
  bytesDownloaded: job.bytesDownloaded,
  bytesTotal: job.bytesTotal,
  currentFile: job.currentFile,
  error: job.failure?.message ?? job.error,
});

const resolveImage = async (
  context: MediaGenerationControlContext,
  value: string,
): Promise<string | null> => {
  if (!value) return null;
  const existing = context.readAssets().find((asset) => asset.id === value);
  if (existing) {
    if (existing.kind !== "image") throw new Error(`${value} is not an image asset.`);
    return existing.id;
  }
  if (!/[\\/]/u.test(value)) throw new Error(`No image asset has the id ${value}. Pass an asset id or an absolute file path.`);
  const imported = await context.importAsset(value);
  if (imported.kind !== "image") throw new Error("Choose a PNG, JPEG, or WebP image.");
  return imported.id;
};

const targetControl = (context: MediaGenerationControlContext): MediaTargetControl => {
  const target = context.readState().target;
  const control = findMediaTargetControl(target);
  if (!control)
    throw new Error(`${target} uses media.set_prompt and media.set_image_options instead.`);
  return control;
};

export const createMediaGenerationControlActions = (
  context: MediaGenerationControlContext,
): AppControlAction[] => {
  const control = findMediaTargetControl(context.readState().target);
  const actions: AppControlAction[] = [
    {
      id: "media.setup_runtime",
      description:
        "Install or repair the local media runtime that image, audio, and 3D generation need, and wait until it is ready.",
      effect: "write",
      timeoutMs: LONG_ACTION_MS + 30_000,
      input: { type: "object", properties: {} },
      run: async (_input, { signal }) => {
        if (context.readRuntimeReady()) return { ready: true };
        await context.startRuntimeSetup();
        const deadline = Date.now() + LONG_ACTION_MS;
        while (Date.now() < deadline) {
          if (context.readRuntimeReady()) return { ready: true };
          const setup = await getMediaRuntimeSetup();
          if (setup.phase === "failed")
            throw new Error([setup.message, setup.diagnostic].filter(Boolean).join(" "));
          await wait(POLL_MS * 2, signal);
        }
        const setup = await getMediaRuntimeSetup();
        return { ready: false, phase: setup.phase, message: setup.message };
      },
    },
    {
      id: "media.install_model",
      description:
        "Download and install a managed model from the catalog in the background and wait until it is ready. When the model's license requires acceptance, show the user the license name and link first and pass acceptLicense true only after the user accepts it.",
      effect: "write",
      timeoutMs: LONG_ACTION_MS + 30_000,
      input: {
        type: "object",
        properties: {
          modelId: { type: "string", minLength: 1, maxLength: 128 },
          acceptLicense: { type: "boolean", description: "The user accepted the model license." },
          wait: { type: "boolean", description: "Wait for the download to finish. Defaults to true." },
        },
        required: ["modelId"],
      },
      run: async (input, { signal }) => {
        const modelId = String(input.modelId);
        const plan = await planMediaModelInstall(modelId);
        if (plan.alreadyInstalled) return { modelId, status: "installed" };
        let job = plan.activeJob;
        if (!job) {
          if (plan.license.requiresAcceptance && input.acceptLicense !== true)
            return {
              modelId,
              status: "license-required",
              license: { name: plan.license.name, url: plan.license.sourceUrl },
              downloadBytes: plan.totalBytes,
              source: plan.sourceUrl,
            };
          if (plan.hasSufficientSpace === false)
            throw new Error("The model storage volume does not have enough free space.");
          job = await startMediaModelInstall({
            modelId,
            reviewToken: plan.reviewToken,
            manifestDigest: plan.manifestDigest,
            licenseDigest: plan.licenseDigest,
            acceptLicense: input.acceptLicense === true || !plan.license.requiresAcceptance,
          });
          mediaDownloadMonitor.refresh();
        }
        if (input.wait === false) return describeInstall(job);
        const deadline = Date.now() + LONG_ACTION_MS;
        while (ACTIVE_INSTALL_STATES.includes(job.status) && Date.now() < deadline) {
          await wait(POLL_MS, signal);
          job = await getMediaModelInstallJob(job.id);
        }
        if (job.status === "installed") await context.refreshCatalog();
        return describeInstall(job);
      },
    },
    {
      id: "media.list_downloads",
      description: "List model downloads and Civitai downloads with their source, progress, and errors.",
      effect: "read",
      input: { type: "object", properties: {} },
      run: () => ({
        models: mediaDownloadMonitor.getSnapshot().installJobs.map(describeInstall),
        civitai: mediaImportQueue
          .getSnapshot()
          .filter((job) => job.downloadKey)
          .map((job) => ({
            id: job.id,
            name: job.label,
            source: job.sourceUrl ?? null,
            status: job.status,
            received: job.received ?? null,
            total: job.total ?? null,
            error: job.error,
          })),
      }),
    },
    {
      id: "media.list_generations",
      description: "List recent generations with status, progress, and result asset ids.",
      effect: "read",
      input: { type: "object", properties: {} },
      run: () => newestFirst(context.readJobs()).slice(0, 20).map(describeJob),
    },
    {
      id: "media.run_generation",
      description:
        "Start a Basic generation with the current settings and wait for its result assets. Returns the current progress if it is still running after about 14 minutes; continue with media.wait_for_generation.",
      effect: "write",
      timeoutMs: LONG_ACTION_MS + SUBMISSION_TIMEOUT_MS + 30_000,
      input: { type: "object", properties: {} },
      run: async (_input, { signal }) => {
        const blocked = context.readBlockedReason();
        if (blocked) throw new Error(blocked);
        const known = new Set(context.readJobs().map((job) => job.runId));
        const previousError = context.readRuntimeError();
        context.generate();
        const submissionDeadline = Date.now() + SUBMISSION_TIMEOUT_MS;
        const started = (): MediaGenerationQueueJob | undefined =>
          newestFirst(context.readJobs()).find((job) => !known.has(job.runId));
        while (!started() && Date.now() < submissionDeadline) {
          const failure = context.readRuntimeError();
          if (failure && failure !== previousError) throw new Error(failure);
          await wait(250, signal);
        }
        const runId = started()?.runId;
        if (!runId) throw new Error("The generation did not start. Read the view for errors and retry.");
        const job = await waitForJob(
          () => context.readJobs().find((entry) => entry.runId === runId),
          signal,
        );
        if (!job) throw new Error("The generation was removed before it finished.");
        return describeJob(job);
      },
    },
    {
      id: "media.wait_for_generation",
      description:
        "Wait until a generation finishes and return its result assets. Without runId, waits for the newest generation. Returns the current progress if it is still running after about 14 minutes; call it again to keep waiting.",
      effect: "read",
      timeoutMs: LONG_ACTION_MS + 30_000,
      input: {
        type: "object",
        properties: { runId: { type: "string", minLength: 1, maxLength: 200 } },
      },
      run: async (input, { signal }) => {
        const job = await waitForJob(() => {
          const jobs = newestFirst(context.readJobs());
          return typeof input.runId === "string"
            ? jobs.find((entry) => entry.runId === input.runId)
            : jobs[0];
        }, signal);
        if (!job) throw new Error("No generation was found. Start one with media.run_generation.");
        return describeJob(job);
      },
    },
    {
      id: "media.list_assets",
      description: "List the newest library assets, optionally of one kind, with their ids.",
      effect: "read",
      input: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ASSET_KINDS },
          limit: { type: "integer", minimum: 1, maximum: MAX_LISTED_ASSETS },
        },
      },
      run: (input) =>
        context
          .readAssets()
          .filter((asset) => !input.kind || asset.kind === input.kind)
          .slice(0, typeof input.limit === "number" ? input.limit : 20)
          .map(describeAsset),
    },
    {
      id: "media.import_asset",
      description: "Add an image, video, or audio file from an absolute path to the library and return its asset id.",
      effect: "write",
      timeoutMs: 120_000,
      input: {
        type: "object",
        properties: { path: { type: "string", minLength: 1, maxLength: 4_096 } },
        required: ["path"],
      },
      run: async (input) => describeAsset(await context.importAsset(String(input.path))),
    },
    {
      id: "media.export_asset",
      description:
        "Save a library asset as its original file at an absolute destination path, for example a .glb mesh into a game project.",
      effect: "write",
      timeoutMs: 120_000,
      input: {
        type: "object",
        properties: {
          assetId: { type: "string", minLength: 1, maxLength: 256 },
          destinationPath: { type: "string", minLength: 1, maxLength: 4_096 },
        },
        required: ["assetId", "destinationPath"],
      },
      run: async (input) => {
        const exported = await exportMediaAsset({
          assetId: String(input.assetId),
          destinationPath: String(input.destinationPath),
          mode: "verified-original",
        });
        return {
          assetId: exported.assetId,
          destinationPath: exported.destinationPath,
          digest: exported.digest,
        };
      },
    },
  ];
  if (!control) return actions;
  actions.push({
    id: "media.get_options",
    description: `Describe every ${control.target} generation option: meaning, range, recommended range, default, and current value.`,
    effect: "read",
    input: { type: "object", properties: {} },
    run: () => {
      const current = targetControl(context);
      const state = context.readState();
      return {
        target: current.target,
        images: current.readImages(state),
        options: describeMediaTargetOptions(current, state),
      };
    },
  });
  actions.push({
    id: "media.set_options",
    description: `Change ${control.target} generation options. Use media.get_options for meanings and recommended ranges.`,
    effect: "write",
    input: { type: "object", properties: mediaTargetOptionSchema(control) },
    run: (input) => {
      const current = targetControl(context);
      let result: ReturnType<typeof describeMediaTargetOptions> = [];
      context.apply((state) => {
        const next = applyMediaTargetOptions(current, state, input);
        result = describeMediaTargetOptions(current, next);
        return next;
      });
      return result.filter((option) => Object.hasOwn(input, option.id));
    },
  });
  if (control.imageSlots.length > 0)
    actions.push({
      id: "media.set_input_images",
      description: `Set the ${control.target} input images: ${control.imageSlots.join(", ")}. Each value is an image asset id or an absolute file path; an empty string clears it.${control.target === "mesh" ? " Front is required; left, back, and right views improve the shape." : ""}`,
      effect: "write",
      timeoutMs: 120_000,
      input: {
        type: "object",
        properties: Object.fromEntries(
          control.imageSlots.map((slot) => [slot, { type: "string", maxLength: 4_096 } as const]),
        ),
      },
      run: async (input) => {
        const current = targetControl(context);
        const images: Record<string, string | null> = {};
        for (const slot of current.imageSlots)
          if (typeof input[slot] === "string")
            images[slot] = await resolveImage(context, String(input[slot]));
        let result: Record<string, string | null> = {};
        context.apply((state) => {
          const next = current.writeImages(state, images);
          result = current.readImages(next);
          return next;
        });
        return result;
      },
    });
  return actions;
};
