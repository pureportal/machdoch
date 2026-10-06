import { useEffect, useRef, useState, type JSX } from "react";
import { ArrowRight, LoaderCircle, Plus, Trash2 } from "lucide-react";
import type { MediaModelDescriptor } from "../../../../core/media/contracts.js";
import type {
  MediaTrainingArchitecture,
  MediaTrainingConcept,
  MediaTrainingSample,
  MediaTrainingSampleInspection,
  MediaTrainingJob,
  MediaTrainingStatus,
  MediaTrainingMethod,
} from "../media-training";
import {
  cancelTraining,
  finishTraining,
  getTrainingStatus,
  inspectTrainingSamples,
  resumeTraining,
  submitTraining,
  defaultTrainingOptions,
  TRAINING_ARCHITECTURES,
  isFlowTrainingArchitecture,
  isVideoTrainingArchitecture,
  defaultTrainingVideoSettings,
  validTrainingVideoSettings,
  supportsEmbeddingTraining,
} from "../media-training";
import { hasMediaHost, isRemoteMedia, open, openUrl } from "../media-platform";
import {
  importTrainingArtifact,
  type ImportedTrainingArtifact,
} from "../media-training-import";
import { Button } from "../../components/ui/button";

import {
  MediaTrainingSettingsFields,
  type MediaTrainingSettings,
} from "./media-training-settings";
import { MediaTrainingVideoSettingsFields } from "./media-training-video-settings";

const JOB_KEY = "media:local-training-job";
const concepts: readonly { id: MediaTrainingConcept; label: string }[] = [
  { id: "style", label: "Style" },
  { id: "face", label: "Face" },
  { id: "character", label: "Character" },
  { id: "object", label: "Object" },
];

const readJob = (): MediaTrainingJob | null => {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(JOB_KEY) ?? "null");
    if (
      typeof value === "object" &&
      value !== null &&
      "id" in value &&
      typeof value.id === "string" &&
      "name" in value &&
      typeof value.name === "string" &&
      "triggerPhrase" in value &&
      typeof value.triggerPhrase === "string" &&
      "concept" in value &&
      concepts.some((concept) => concept.id === value.concept) &&
      "architecture" in value &&
      TRAINING_ARCHITECTURES.some(
        (item) => item.value === value.architecture,
      ) &&
      "method" in value &&
      ["lora", "finetune", "embedding"].includes(String(value.method)) &&
      "baseModelId" in value &&
      (value.baseModelId === null || typeof value.baseModelId === "string")
    )
      return value as MediaTrainingJob;
  } catch {
    localStorage.removeItem(JOB_KEY);
  }
  return null;
};

const errorMessage = (failure: unknown): string => {
  if (failure instanceof Error) return failure.message;
  if (
    typeof failure === "object" &&
    failure !== null &&
    "message" in failure &&
    typeof failure.message === "string"
  )
    return failure.message;
  return "Training could not continue. Try again.";
};
const fileName = (path: string): string => path.split(/[\\/]/u).at(-1) ?? path;

export function MediaTrainView({
  models,
  onImported,
  onUseAddon,
  onUseModel,
  canUseAddon,
  onFindModel,
}: {
  models: readonly MediaModelDescriptor[];
  onImported: () => Promise<unknown>;
  onUseAddon: (addonId: string, baseModelId: string | null) => void;
  onUseModel: (modelId: string) => void;
  canUseAddon: (
    architecture: MediaTrainingArchitecture,
    method: "lora" | "embedding",
    baseModelId: string | null,
  ) => boolean;
  onFindModel: (architecture: MediaTrainingArchitecture) => void;
}): JSX.Element {
  const localHost = hasMediaHost() && !isRemoteMedia();
  const trainingModels = models.filter(
    (model) =>
      model.target === "local" &&
      model.installed &&
      (model.architecture === "krea-2-raw" ||
        TRAINING_ARCHITECTURES.some(
          (item) =>
            item.value !== "krea-2" && item.value === model.architecture,
        )),
  );
  const [architecture, setArchitecture] = useState<MediaTrainingArchitecture>(
    () =>
      ((trainingModels[0]?.architecture === "krea-2-raw"
        ? "krea-2"
        : trainingModels[0]?.architecture) as
        | MediaTrainingArchitecture
        | undefined) ?? "stable-diffusion-xl",
  );
  const [modelId, setModelId] = useState<string | null>(null);
  const matchingModels = trainingModels.filter(
    (model) =>
      model.architecture ===
      (architecture === "krea-2" ? "krea-2-raw" : architecture),
  );
  const selectedModelId = modelId ?? matchingModels[0]?.id ?? "";
  const selectedModel = matchingModels.find(
    (model) => model.id === selectedModelId,
  );
  const [name, setName] = useState("");
  const [concept, setConcept] = useState<MediaTrainingConcept>("style");
  const [triggerPhrase, setTriggerPhrase] = useState("");
  const [modelPath, setModelPath] = useState("");
  const [images, setImages] = useState<MediaTrainingSample[]>([]);
  const [video, setVideo] = useState(defaultTrainingVideoSettings);
  const videoTraining = isVideoTrainingArchitecture(architecture);
  const [imageInspections, setImageInspections] = useState<
    MediaTrainingSampleInspection[]
  >([]);
  const [inspectingImages, setInspectingImages] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [settings, setSettings] = useState<MediaTrainingSettings>(() => ({
    steps: 1000,
    learningRate: 0.0001,
    resolution: 768,
    rank: 32,
    seed: 0,
    attentionOnly: true,
    fourBit: !/Macintosh|Mac OS X/u.test(navigator.userAgent),
    options: {
      ...defaultTrainingOptions(),
      precision: /Macintosh|Mac OS X/u.test(navigator.userAgent)
        ? "fp16"
        : "bf16",
    },
  }));
  const {
    steps,
    learningRate,
    resolution,
    rank,
    seed,
    attentionOnly,
    fourBit,
    options,
  } = settings;
  const [job, setJob] = useState<MediaTrainingJob | null>(readJob);
  const [status, setStatus] = useState<MediaTrainingStatus | null>(null);
  const [importedAddon, setImportedAddon] =
    useState<ImportedTrainingArtifact | null>(null);
  const [cleanupJobId, setCleanupJobId] = useState<string | null>(null);
  const [importFailed, setImportFailed] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const importing = useRef(false);

  useEffect(() => {
    if (!job || !localHost) return;
    let stopped = false;
    let timer: number | undefined;
    const poll = async (): Promise<void> => {
      try {
        const next = await getTrainingStatus(job.id);
        if (stopped) return;
        setStatus(next);
        if (
          next.state !== "completed" ||
          !next.outputPath ||
          importing.current ||
          importFailed
        )
          return;
        importing.current = true;
        setPending(true);
        const result = await importTrainingArtifact(job, next.outputPath);
        await onImported();
        if (stopped) return;
        let cleanupError: string | null = null;
        try {
          await finishTraining(job.id);
        } catch (failure) {
          setCleanupJobId(job.id);
          cleanupError = `Weights imported, but training files remain: ${errorMessage(failure)}`;
        }
        localStorage.removeItem(JOB_KEY);
        setImportedAddon(result);
        setJob(null);
        setError(cleanupError);
      } catch (failure) {
        if (!stopped) {
          setError(errorMessage(failure));
          if (importing.current) setImportFailed(true);
        }
      } finally {
        importing.current = false;
        if (!stopped) {
          setPending(false);
          timer = window.setTimeout(() => void poll(), 5000);
        }
      }
    };
    void poll();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [job, localHost, onImported, importFailed]);

  const addImages = async (): Promise<void> => {
    setInspectingImages(true);
    try {
      const selected = await open({
        multiple: true,
        filters: [
          videoTraining
            ? { name: "Videos", extensions: ["mp4", "webm", "mov", "mkv"] }
            : { name: "Images", extensions: ["png", "jpg", "jpeg", "webp"] },
        ],
      });
      if (!selected) return;
      const paths = Array.isArray(selected) ? selected : [selected];
      const existing = new Set(images.map((image) => image.path));
      const added = paths.filter((path) => {
        if (existing.has(path)) return false;
        existing.add(path);
        return true;
      });
      if (images.length + added.length > 50)
        throw new Error("Choose up to 50 training samples.");
      const inspected = await inspectTrainingSamples(added, architecture);
      setImages([...images, ...added.map((path) => ({ path, caption: "" }))]);
      setImageInspections((current) => [...current, ...inspected]);
      setError(null);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setInspectingImages(false);
    }
  };

  const chooseModelFolder = async (): Promise<void> => {
    try {
      const selected = await open({ directory: true, multiple: false });
      if (typeof selected === "string") setModelPath(selected);
    } catch (failure) {
      setError(errorMessage(failure));
    }
  };

  const startTraining = async (): Promise<void> => {
    if (!canTrain) return;
    setPending(true);
    setError(null);
    try {
      const started = await submitTraining({
        name,
        concept,
        triggerPhrase,
        samples: images,
        video: isVideoTrainingArchitecture(architecture) ? video : null,
        architecture,
        modelId: selectedModel?.id ?? null,
        modelPath: architecture === "krea-2" && !selectedModel ? modelPath : "",
        steps,
        learningRate,
        resolution,
        rank,
        seed,
        attentionOnly,
        fourBit: architecture === "krea-2" && fourBit,
        options,
      });
      localStorage.setItem(JOB_KEY, JSON.stringify(started));
      setJob(started);
      setStatus(null);
      setImportFailed(false);
      setCleanupJobId(null);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setPending(false);
    }
  };

  const stopTraining = async (): Promise<void> => {
    if (!job) return;
    setPending(true);
    try {
      await cancelTraining(job.id);
      setStatus(await getTrainingStatus(job.id));
      setError(null);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setPending(false);
    }
  };

  const continueTraining = async (): Promise<void> => {
    if (!job) return;
    setPending(true);
    try {
      await resumeTraining(job.id);
      setStatus(null);
      setError(null);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setPending(false);
    }
  };

  const removeJob = async (): Promise<void> => {
    if (!job) return;
    setPending(true);
    try {
      await finishTraining(job.id);
      localStorage.removeItem(JOB_KEY);
      setJob(null);
      setStatus(null);
      setError(null);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setPending(false);
    }
  };

  const canTrain =
    localHost &&
    !!name.trim() &&
    !!triggerPhrase.trim() &&
    (!!selectedModel || (architecture === "krea-2" && !!modelPath)) &&
    (options.method !== "embedding" ||
      (!/\s/u.test(triggerPhrase) && !!options.initializerToken.trim())) &&
    images.length >= 3 &&
    (!videoTraining ||
      (validTrainingVideoSettings(video) &&
        !imageInspections.some(
          (sample) => (sample.durationSeconds ?? 0) < video.frames / video.fps,
        ))) &&
    Number.isInteger(steps) &&
    steps >= 1 &&
    steps <= 10_000 &&
    Number.isInteger(seed) &&
    seed >= 0 &&
    seed <= 4_294_967_295 &&
    Number.isFinite(learningRate) &&
    learningRate >= 0.000001 &&
    learningRate <= 0.01 &&
    !pending &&
    !inspectingImages;
  const imageDimensions = new Map(
    imageInspections.map((inspection) => [inspection.path, inspection]),
  );
  const lowResolutionCount = images.filter((image) => {
    const dimensions = imageDimensions.get(image.path);
    return (
      dimensions && Math.sqrt(dimensions.width * dimensions.height) < resolution
    );
  }).length;

  return (
    <div className="h-full overflow-y-auto px-5 py-6 text-slate-100 sm:px-8">
      <div className="mx-auto max-w-3xl space-y-6">
        <h1 className="text-xl font-semibold">Train</h1>
        {!localHost ? (
          <p className="text-sm text-slate-400">
            Open Media Studio on this computer to train locally.
          </p>
        ) : null}
        {job ? (
          <section className="rounded-xl border border-slate-700 bg-slate-900/70 p-5">
            <h2 className="font-medium">{job.name}</h2>
            <p role="status" className="mt-2 text-sm text-slate-300">
              {pending
                ? "Working…"
                : status?.state === "running"
                  ? (status.message ??
                    `Training locally${status.completedSteps === null ? "" : ` · ${status.completedSteps} / ${status.totalSteps} steps`}`)
                  : status?.state === "starting"
                    ? "Starting training…"
                    : status?.state === "completed"
                      ? "Importing weights…"
                      : status?.state === "failed"
                        ? "Training failed"
                        : status?.state === "cancelled"
                          ? "Training stopped"
                          : status?.state === "interrupted"
                            ? "Training interrupted"
                            : "Checking training…"}
            </p>
            {status?.progress &&
            !(status.state === "running" && status.message) ? (
              <div className="mt-3 space-y-2">
                <progress
                  aria-label="Training progress"
                  max={status.totalSteps}
                  value={status.progress.completedSteps}
                  className="w-full"
                />
                <p className="text-xs text-slate-400">
                  Loss {status.progress.loss.toFixed(4)} ·{" "}
                  {Math.ceil(status.progress.remainingSeconds / 60)} min
                  remaining
                </p>
              </div>
            ) : null}
            {status?.message && status.state !== "running" ? (
              <p className="mt-2 text-sm text-red-200">{status.message}</p>
            ) : null}
            <div className="mt-4 flex flex-wrap gap-2">
              {status?.state === "running" || status?.state === "starting" ? (
                <Button
                  variant="outline"
                  disabled={pending}
                  onClick={() => void stopTraining()}
                >
                  Stop training
                </Button>
              ) : null}
              {status?.canResume ? (
                <Button
                  variant="outline"
                  disabled={pending}
                  onClick={() => void continueTraining()}
                >
                  Resume
                </Button>
              ) : null}
              {status &&
              ["failed", "cancelled", "interrupted"].includes(status.state) ? (
                <Button
                  variant="outline"
                  disabled={pending}
                  onClick={() => void removeJob()}
                >
                  Remove job
                </Button>
              ) : null}
              {status?.state === "completed" && importFailed ? (
                <Button
                  variant="outline"
                  onClick={() => {
                    setImportFailed(false);
                    setError(null);
                  }}
                >
                  Retry import
                </Button>
              ) : null}
              {!status && error ? (
                <Button
                  variant="outline"
                  onClick={() => {
                    localStorage.removeItem(JOB_KEY);
                    setJob(null);
                    setError(null);
                  }}
                >
                  Dismiss job
                </Button>
              ) : null}
            </div>
          </section>
        ) : importedAddon ? (
          <section className="rounded-xl border border-sky-700/60 bg-sky-950/20 p-5">
            <h2 className="font-medium">
              {importedAddon.method === "finetune"
                ? "Model"
                : importedAddon.method === "embedding"
                  ? "Embedding"
                  : "LoRA"}{" "}
              ready
            </h2>
            <div className="mt-4 flex flex-wrap gap-2">
              {importedAddon.method === "finetune" ||
              canUseAddon(
                importedAddon.architecture,
                importedAddon.method,
                importedAddon.baseModelId,
              ) ? (
                <Button
                  onClick={() =>
                    importedAddon.method === "finetune"
                      ? onUseModel(importedAddon.id)
                      : onUseAddon(importedAddon.id, importedAddon.baseModelId)
                  }
                >
                  Use in Basic <ArrowRight className="ml-2 h-4 w-4" />
                </Button>
              ) : (
                <Button onClick={() => onFindModel(importedAddon.architecture)}>
                  Find{" "}
                  {importedAddon.architecture === "krea-2"
                    ? "KREA 2 Turbo"
                    : TRAINING_ARCHITECTURES.find(
                        (item) => item.value === importedAddon.architecture,
                      )?.label}{" "}
                  model <ArrowRight className="ml-2 h-4 w-4" />
                </Button>
              )}
              {cleanupJobId ? (
                <Button
                  variant="outline"
                  onClick={() =>
                    void finishTraining(cleanupJobId)
                      .then(() => {
                        setCleanupJobId(null);
                        setError(null);
                      })
                      .catch((failure: unknown) =>
                        setError(errorMessage(failure)),
                      )
                  }
                >
                  Remove training files
                </Button>
              ) : null}
              <Button variant="outline" onClick={() => setImportedAddon(null)}>
                Train another
              </Button>
            </div>
          </section>
        ) : (
          <div className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="space-y-2 text-sm font-medium">
                Name
                <input
                  value={name}
                  maxLength={100}
                  onChange={(event) => setName(event.target.value)}
                  className="block w-full rounded-lg border border-slate-600 bg-slate-950 px-3 py-2 font-normal"
                />
              </label>
              <label className="space-y-2 text-sm font-medium">
                Type
                <select
                  value={concept}
                  onChange={(event) =>
                    setConcept(event.target.value as MediaTrainingConcept)
                  }
                  className="block w-full rounded-lg border border-slate-600 bg-slate-950 px-3 py-2 font-normal"
                >
                  {concepts.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label className="block space-y-2 text-sm font-medium">
              {options.method === "embedding"
                ? "Embedding token"
                : "Trigger phrase"}
              <input
                value={triggerPhrase}
                maxLength={120}
                onChange={(event) => setTriggerPhrase(event.target.value)}
                className="block w-full rounded-lg border border-slate-600 bg-slate-950 px-3 py-2 font-normal"
              />
            </label>
            <label className="block space-y-2 text-sm font-medium">
              Method
              <select
                value={options.method}
                onChange={(event) => {
                  const method = event.target.value as MediaTrainingMethod;
                  setSettings((current) => ({
                    ...current,
                    learningRate:
                      method === "embedding"
                        ? 0.0005
                        : method === "finetune"
                          ? 0.00001
                          : 0.0001,
                    options: {
                      ...current.options,
                      method,
                      trainablePrecision:
                        method === "finetune"
                          ? current.options.trainablePrecision
                          : "float32",
                      weightDecay: method === "embedding" ? 0 : 0.01,
                    },
                  }));
                }}
                className="block w-full rounded-lg border border-slate-600 bg-slate-950 px-3 py-2 font-normal"
              >
                <option value="lora">LoRA</option>
                {architecture !== "krea-2" ? (
                  <>
                    <option value="finetune">Finetune</option>
                    {supportsEmbeddingTraining(architecture) ? (
                      <option value="embedding">Embedding</option>
                    ) : null}
                  </>
                ) : null}
              </select>
            </label>
            {options.method === "embedding" ? (
              <label className="block space-y-2 text-sm font-medium">
                Initializer word
                <input
                  value={options.initializerToken}
                  maxLength={120}
                  onChange={(event) =>
                    setSettings((current) => ({
                      ...current,
                      options: {
                        ...current.options,
                        initializerToken: event.target.value,
                      },
                    }))
                  }
                  className="block w-full rounded-lg border border-slate-600 bg-slate-950 px-3 py-2 font-normal"
                />
              </label>
            ) : null}
            <label className="block space-y-2 text-sm font-medium">
              Architecture
              <select
                value={architecture}
                disabled={inspectingImages}
                onChange={(event) => {
                  const next = event.target.value as MediaTrainingArchitecture;
                  if (isVideoTrainingArchitecture(next) !== videoTraining) {
                    setImages([]);
                    setImageInspections([]);
                  }
                  if (next !== "cogvideox-1.5-5b-i2v")
                    setVideo((current) => ({ ...current, image_dropout: 0 }));
                  setArchitecture(next);
                  setModelId(null);
                  if (next === "krea-2")
                    setSettings((current) => ({
                      ...current,
                      options: {
                        ...defaultTrainingOptions(),
                        precision: current.options.precision,
                      },
                    }));
                  else if (
                    isFlowTrainingArchitecture(next) ||
                    isVideoTrainingArchitecture(next)
                  )
                    setSettings((current) => {
                      const resetEmbedding =
                        current.options.method === "embedding" &&
                        !supportsEmbeddingTraining(next);
                      return {
                        ...current,
                        learningRate: resetEmbedding
                          ? 0.0001
                          : current.learningRate,
                        options: {
                          ...current.options,
                          method: resetEmbedding
                            ? "lora"
                            : current.options.method,
                          weightDecay: resetEmbedding
                            ? 0.01
                            : current.options.weightDecay,
                          snrGamma: 0,
                          preserveAspectRatio: isVideoTrainingArchitecture(next)
                            ? false
                            : current.options.preserveAspectRatio,
                        },
                      };
                    });
                }}
                className="block w-full rounded-lg border border-slate-600 bg-slate-950 px-3 py-2 font-normal"
              >
                {TRAINING_ARCHITECTURES.map((item) => (
                  <option key={item.value} value={item.value}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
            {architecture !== "krea-2" || matchingModels.length > 0 ? (
              <section className="space-y-2">
                <label className="block space-y-2 text-sm font-medium">
                  Base model
                  <select
                    value={selectedModel?.id ?? ""}
                    disabled={!localHost || matchingModels.length === 0}
                    onChange={(event) => setModelId(event.target.value)}
                    className="block w-full rounded-lg border border-slate-600 bg-slate-950 px-3 py-2 font-normal"
                  >
                    <option value="" disabled={architecture !== "krea-2"}>
                      {architecture === "krea-2"
                        ? "Local folder"
                        : "Choose model"}
                    </option>
                    {matchingModels.map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.displayName}
                      </option>
                    ))}
                  </select>
                </label>
                {matchingModels.length === 0 ? (
                  <Button
                    variant="outline"
                    onClick={() => onFindModel(architecture)}
                  >
                    Find{" "}
                    {
                      TRAINING_ARCHITECTURES.find(
                        (item) => item.value === architecture,
                      )?.label
                    }{" "}
                    model
                  </Button>
                ) : null}
              </section>
            ) : null}
            {architecture === "krea-2" && !selectedModel ? (
              <section className="space-y-2">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="text-sm font-medium">
                    KREA 2 RAW model folder
                  </span>
                  <Button
                    variant="outline"
                    disabled={!localHost}
                    onClick={() => void chooseModelFolder()}
                  >
                    Choose folder
                  </Button>
                </div>
                {modelPath ? (
                  <p className="break-all text-xs text-slate-400">
                    {modelPath}
                  </p>
                ) : (
                  <button
                    type="button"
                    onClick={() =>
                      void openUrl("https://huggingface.co/krea/Krea-2-Raw")
                    }
                    className="text-xs text-sky-300"
                  >
                    Get RAW weights
                  </button>
                )}
              </section>
            ) : null}
            <section className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-sm font-medium">
                  {videoTraining ? "Videos" : "Images"} ({images.length})
                </h2>
                <Button
                  variant="outline"
                  disabled={
                    !localHost || images.length >= 50 || inspectingImages
                  }
                  onClick={() => void addImages()}
                >
                  <Plus className="mr-2 h-4 w-4" />
                  {videoTraining ? "Add videos" : "Add images"}
                </Button>
              </div>
              {images.length > 0 ? (
                <div className="max-h-80 space-y-2 overflow-y-auto">
                  {images.map((image, index) => (
                    <div
                      key={image.path}
                      className="rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-2"
                    >
                      <div className="flex items-center gap-3">
                        <span
                          className="min-w-0 flex-1 truncate text-sm"
                          title={image.path}
                        >
                          {fileName(image.path)}
                        </span>
                        {imageDimensions.get(image.path) ? (
                          <span className="shrink-0 text-xs text-slate-400">
                            {imageDimensions.get(image.path)?.width} ×{" "}
                            {imageDimensions.get(image.path)?.height}
                          </span>
                        ) : null}
                        <button
                          type="button"
                          aria-label={`Remove ${fileName(image.path)}`}
                          onClick={() => {
                            setImages((current) =>
                              current.filter(
                                (_, position) => position !== index,
                              ),
                            );
                            setImageInspections((current) =>
                              current.filter(
                                (item) => item.path !== image.path,
                              ),
                            );
                          }}
                          className="text-slate-400 hover:text-white"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                      <input
                        aria-label={`Caption for ${fileName(image.path)}`}
                        maxLength={2000}
                        placeholder={triggerPhrase || "Caption"}
                        value={image.caption}
                        onChange={(event) =>
                          setImages((current) =>
                            current.map((item, position) =>
                              position === index
                                ? { ...item, caption: event.target.value }
                                : item,
                            ),
                          )
                        }
                        className="mt-2 w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 text-xs"
                      />
                    </div>
                  ))}
                </div>
              ) : null}
              {videoTraining ? (
                <MediaTrainingVideoSettingsFields
                  settings={video}
                  imageConditioned={architecture === "cogvideox-1.5-5b-i2v"}
                  onChange={(patch) =>
                    setVideo((current) => ({ ...current, ...patch }))
                  }
                />
              ) : null}
              {videoTraining &&
              imageInspections.some(
                (sample) =>
                  (sample.durationSeconds ?? 0) < video.frames / video.fps,
              ) ? (
                <p role="alert" className="text-xs text-amber-300">
                  A clip is too short. Reduce the frame count or add a longer
                  clip.
                </p>
              ) : null}
              {!videoTraining && images.length >= 3 && images.length < 10 ? (
                <p className="text-xs text-amber-300">
                  Only {images.length} images. Add varied examples for more
                  reliable results.
                </p>
              ) : null}
              {!videoTraining && lowResolutionCount > 0 ? (
                <p className="text-xs text-amber-300">
                  {lowResolutionCount}{" "}
                  {lowResolutionCount === 1 ? "image is" : "images are"} smaller
                  than the {resolution}px training size. Use larger originals.
                </p>
              ) : null}
              {!videoTraining && concept === "style" && images.length > 0 ? (
                <p className="text-xs text-slate-400">
                  Describe each image's subject in its caption.
                </p>
              ) : null}
            </section>
            <section className="rounded-xl border border-slate-800 bg-slate-900/40 p-4">
              <button
                type="button"
                aria-expanded={advanced}
                onClick={() => setAdvanced(!advanced)}
                className="text-sm font-medium"
              >
                Advanced settings
              </button>
              {advanced ? (
                <MediaTrainingSettingsFields
                  architecture={architecture}
                  settings={settings}
                  onChange={(patch) =>
                    setSettings((current) => ({ ...current, ...patch }))
                  }
                />
              ) : null}
            </section>
            <Button disabled={!canTrain} onClick={() => void startTraining()}>
              {pending ? (
                <LoaderCircle className="mr-2 h-4 w-4 animate-spin" />
              ) : null}
              Train locally
            </Button>
          </div>
        )}
        {error ? (
          <p
            role="alert"
            className="rounded-lg border border-red-800 bg-red-950/30 px-3 py-2 text-sm text-red-200"
          >
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}
