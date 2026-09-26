import { useEffect, useRef, useState, type JSX } from "react";
import { ArrowRight, LoaderCircle, Plus, Trash2 } from "lucide-react";
import type { KreaLoraConcept, KreaTrainingImage, KreaTrainingImageInspection, KreaTrainingJob, KreaTrainingStatus } from "../krea-training";
import {
  cancelKreaTraining,
  finishKreaTraining,
  getKreaTrainingStatus,
  inspectKreaTrainingImages,
  resumeKreaTraining,
  submitKreaTraining,
} from "../krea-training";
import { hasMediaHost, isRemoteMedia, open, openUrl } from "../media-platform";
import { importMediaModelAddon, inspectMediaModelAddon } from "../media-runtime";
import { Button } from "../../components/ui/button";

const JOB_KEY = "media:local-krea-training-job";
const concepts: readonly { id: KreaLoraConcept; label: string }[] = [
  { id: "style", label: "Style" },
  { id: "face", label: "Face" },
  { id: "character", label: "Character" },
  { id: "object", label: "Object" },
];

const readJob = (): KreaTrainingJob | null => {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(JOB_KEY) ?? "null");
    if (typeof value === "object" && value !== null && "id" in value && typeof value.id === "string" &&
      "name" in value && typeof value.name === "string" && "triggerPhrase" in value && typeof value.triggerPhrase === "string" &&
      "concept" in value && concepts.some((concept) => concept.id === value.concept)) return value as KreaTrainingJob;
  } catch {
    localStorage.removeItem(JOB_KEY);
  }
  return null;
};

const errorMessage = (failure: unknown): string => {
  if (failure instanceof Error) return failure.message;
  if (typeof failure === "object" && failure !== null && "message" in failure && typeof failure.message === "string") return failure.message;
  return "Training could not continue. Try again.";
};
const fileName = (path: string): string => path.split(/[\\/]/u).at(-1) ?? path;

export function MediaTrainView({ onImported, onUseAddon, canUseAddon, onFindModel }: {
  onImported: () => Promise<unknown>;
  onUseAddon: (addonId: string) => void;
  canUseAddon: boolean;
  onFindModel: () => void;
}): JSX.Element {
  const localHost = hasMediaHost() && !isRemoteMedia();
  const [name, setName] = useState("");
  const [concept, setConcept] = useState<KreaLoraConcept>("style");
  const [triggerPhrase, setTriggerPhrase] = useState("");
  const [rawModelPath, setRawModelPath] = useState("");
  const [images, setImages] = useState<KreaTrainingImage[]>([]);
  const [imageInspections, setImageInspections] = useState<KreaTrainingImageInspection[]>([]);
  const [inspectingImages, setInspectingImages] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [steps, setSteps] = useState(1000);
  const [learningRate, setLearningRate] = useState(0.0003);
  const [resolution, setResolution] = useState<512 | 768 | 1024>(768);
  const [rank, setRank] = useState<16 | 32 | 64>(32);
  const [attentionOnly, setAttentionOnly] = useState(false);
  const [fourBit, setFourBit] = useState(() => !/Macintosh|Mac OS X/u.test(navigator.userAgent));
  const [job, setJob] = useState<KreaTrainingJob | null>(readJob);
  const [status, setStatus] = useState<KreaTrainingStatus | null>(null);
  const [importedAddonId, setImportedAddonId] = useState<string | null>(null);
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
        const next = await getKreaTrainingStatus(job.id);
        if (stopped) return;
        setStatus(next);
        if (next.state !== "completed" || !next.outputPath || importing.current || importFailed) return;
        importing.current = true;
        setPending(true);
        const inspection = await inspectMediaModelAddon(next.outputPath);
        if (!inspection.canImport || inspection.detectedArchitecture !== "krea-2") {
          throw new Error(inspection.blockingReason ?? "The trained LoRA could not be verified as KREA 2.");
        }
        const result = await importMediaModelAddon({
          sourcePath: next.outputPath,
          reviewToken: inspection.reviewToken,
          displayName: job.name,
          kind: "lora",
          architecture: "krea-2",
          triggerWords: [job.triggerPhrase],
          token: null,
          sourceUrl: null,
          licenseName: null,
          commercialUse: null,
        });
        await onImported();
        if (stopped) return;
        let cleanupError: string | null = null;
        try {
          await finishKreaTraining(job.id);
        } catch (failure) {
          setCleanupJobId(job.id);
          cleanupError = `LoRA imported, but training files remain: ${errorMessage(failure)}`;
        }
        localStorage.removeItem(JOB_KEY);
        setImportedAddonId(result.addonId);
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
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [job, localHost, onImported, importFailed]);

  const addImages = async (): Promise<void> => {
    setInspectingImages(true);
    try {
      const selected = await open({ multiple: true, filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp"] }] });
      if (!selected) return;
      const paths = Array.isArray(selected) ? selected : [selected];
      const existing = new Set(images.map((image) => image.path));
      const added = paths.filter((path) => {
        if (existing.has(path)) return false;
        existing.add(path);
        return true;
      });
      if (images.length + added.length > 50) throw new Error("Choose up to 50 images.");
      const inspected = await inspectKreaTrainingImages(added);
      setImages([...images, ...added.map((path) => ({ path, caption: "" }))]);
      setImageInspections((current) => [...current, ...inspected]);
      setError(null);
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setInspectingImages(false); }
  };

  const chooseRawModel = async (): Promise<void> => {
    try {
      const selected = await open({ directory: true, multiple: false });
      if (typeof selected === "string") setRawModelPath(selected);
    } catch (failure) { setError(errorMessage(failure)); }
  };

  const startTraining = async (): Promise<void> => {
    setPending(true);
    setError(null);
    try {
      const started = await submitKreaTraining({ name, concept, triggerPhrase, images, rawModelPath, steps, learningRate, resolution, rank, attentionOnly, fourBit });
      localStorage.setItem(JOB_KEY, JSON.stringify(started));
      setJob(started);
      setStatus(null);
      setImportFailed(false);
      setCleanupJobId(null);
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setPending(false); }
  };

  const stopTraining = async (): Promise<void> => {
    if (!job) return;
    setPending(true);
    try {
      await cancelKreaTraining(job.id);
      setStatus(await getKreaTrainingStatus(job.id));
      setError(null);
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setPending(false); }
  };

  const resumeTraining = async (): Promise<void> => {
    if (!job) return;
    setPending(true);
    try {
      await resumeKreaTraining(job.id);
      setStatus(null);
      setError(null);
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setPending(false); }
  };

  const removeJob = async (): Promise<void> => {
    if (!job) return;
    setPending(true);
    try {
      await finishKreaTraining(job.id);
      localStorage.removeItem(JOB_KEY);
      setJob(null);
      setStatus(null);
      setError(null);
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setPending(false); }
  };

  const canTrain = localHost && !!name.trim() && !!triggerPhrase.trim() && !!rawModelPath && images.length >= 3 &&
    Number.isInteger(steps) && steps >= 100 && steps <= 10_000 &&
    Number.isFinite(learningRate) && learningRate >= 0.00001 && learningRate <= 0.001 && !pending && !inspectingImages;
  const imageDimensions = new Map(imageInspections.map((inspection) => [inspection.path, inspection]));
  const lowResolutionCount = images.filter((image) => {
    const dimensions = imageDimensions.get(image.path);
    return dimensions && Math.sqrt(dimensions.width * dimensions.height) < resolution;
  }).length;

  return <div className="h-full overflow-y-auto px-5 py-6 text-slate-100 sm:px-8">
    <div className="mx-auto max-w-3xl space-y-6">
      <h1 className="text-xl font-semibold">Train LoRA</h1>
      {!localHost ? <p className="text-sm text-slate-400">Open Media Studio on this computer to train locally.</p> : null}
      {job ? <section className="rounded-xl border border-slate-700 bg-slate-900/70 p-5">
        <h2 className="font-medium">{job.name}</h2>
        <p role="status" className="mt-2 text-sm text-slate-300">{pending ? "Working…" : status?.state === "running" ? `Training locally${status.completedSteps === null ? "" : ` · ${status.completedSteps} / ${status.totalSteps} steps`}` : status?.state === "starting" ? "Starting training…" : status?.state === "completed" ? "Importing LoRA…" : status?.state === "failed" ? "Training failed" : status?.state === "cancelled" ? "Training stopped" : status?.state === "interrupted" ? "Training interrupted" : "Checking training…"}</p>
        {status?.message ? <p className="mt-2 text-sm text-red-200">{status.message}</p> : null}
        <div className="mt-4 flex flex-wrap gap-2">
          {status?.state === "running" || status?.state === "starting" ? <Button variant="outline" disabled={pending} onClick={() => void stopTraining()}>Stop training</Button> : null}
          {status?.canResume ? <Button variant="outline" disabled={pending} onClick={() => void resumeTraining()}>Resume</Button> : null}
          {status && ["failed", "cancelled", "interrupted"].includes(status.state) ? <Button variant="outline" disabled={pending} onClick={() => void removeJob()}>Remove job</Button> : null}
          {status?.state === "completed" && importFailed ? <Button variant="outline" onClick={() => { setImportFailed(false); setError(null); }}>Retry import</Button> : null}
          {!status && error ? <Button variant="outline" onClick={() => { localStorage.removeItem(JOB_KEY); setJob(null); setError(null); }}>Dismiss job</Button> : null}
        </div>
      </section> : importedAddonId ? <section className="rounded-xl border border-sky-700/60 bg-sky-950/20 p-5">
        <h2 className="font-medium">LoRA ready</h2>
        <div className="mt-4 flex flex-wrap gap-2">
          {canUseAddon ? <Button onClick={() => onUseAddon(importedAddonId)}>Use in Basic <ArrowRight className="ml-2 h-4 w-4" /></Button> : <Button onClick={onFindModel}>Find KREA 2 model <ArrowRight className="ml-2 h-4 w-4" /></Button>}
          {cleanupJobId ? <Button variant="outline" onClick={() => void finishKreaTraining(cleanupJobId).then(() => { setCleanupJobId(null); setError(null); }).catch((failure: unknown) => setError(errorMessage(failure)))}>Remove training files</Button> : null}
          <Button variant="outline" onClick={() => setImportedAddonId(null)}>Train another</Button>
        </div>
      </section> : <div className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="space-y-2 text-sm font-medium">Name<input value={name} maxLength={100} onChange={(event) => setName(event.target.value)} className="block w-full rounded-lg border border-slate-600 bg-slate-950 px-3 py-2 font-normal" /></label>
          <label className="space-y-2 text-sm font-medium">Type<select value={concept} onChange={(event) => setConcept(event.target.value as KreaLoraConcept)} className="block w-full rounded-lg border border-slate-600 bg-slate-950 px-3 py-2 font-normal">{concepts.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
        </div>
        <label className="block space-y-2 text-sm font-medium">Trigger phrase<input value={triggerPhrase} maxLength={120} onChange={(event) => setTriggerPhrase(event.target.value)} className="block w-full rounded-lg border border-slate-600 bg-slate-950 px-3 py-2 font-normal" /></label>
        <section className="space-y-2">
          <div className="flex flex-wrap items-center gap-3"><span className="text-sm font-medium">KREA 2 RAW model folder</span><Button variant="outline" disabled={!localHost} onClick={() => void chooseRawModel()}>Choose folder</Button></div>
          {rawModelPath ? <p className="break-all text-xs text-slate-400">{rawModelPath}</p> : <button type="button" onClick={() => void openUrl("https://huggingface.co/krea/Krea-2-Raw")} className="text-xs text-sky-300">Get RAW weights</button>}
        </section>
        <section className="space-y-3">
          <div className="flex items-center justify-between gap-3"><h2 className="text-sm font-medium">Images ({images.length})</h2><Button variant="outline" disabled={!localHost || images.length >= 50 || inspectingImages} onClick={() => void addImages()}><Plus className="mr-2 h-4 w-4" />Add images</Button></div>
          {images.length > 0 ? <div className="max-h-80 space-y-2 overflow-y-auto">{images.map((image, index) => <div key={image.path} className="rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-2">
            <div className="flex items-center gap-3"><span className="min-w-0 flex-1 truncate text-sm" title={image.path}>{fileName(image.path)}</span>{imageDimensions.get(image.path) ? <span className="shrink-0 text-xs text-slate-400">{imageDimensions.get(image.path)?.width} × {imageDimensions.get(image.path)?.height}</span> : null}<button type="button" aria-label={`Remove ${fileName(image.path)}`} onClick={() => { setImages((current) => current.filter((_, position) => position !== index)); setImageInspections((current) => current.filter((item) => item.path !== image.path)); }} className="text-slate-400 hover:text-white"><Trash2 className="h-4 w-4" /></button></div>
            <input aria-label={`Caption for ${fileName(image.path)}`} maxLength={2000} placeholder={triggerPhrase || "Caption"} value={image.caption} onChange={(event) => setImages((current) => current.map((item, position) => position === index ? { ...item, caption: event.target.value } : item))} className="mt-2 w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 text-xs" />
          </div>)}</div> : null}
          {images.length >= 3 && images.length < 10 ? <p className="text-xs text-amber-300">Only {images.length} images. Add varied examples for more reliable results.</p> : null}
          {lowResolutionCount > 0 ? <p className="text-xs text-amber-300">{lowResolutionCount} {lowResolutionCount === 1 ? "image is" : "images are"} smaller than the {resolution}px training size. Use larger originals.</p> : null}
          {concept === "style" && images.length > 0 ? <p className="text-xs text-slate-400">Describe each image's subject in its caption.</p> : null}
        </section>
        <section className="rounded-xl border border-slate-800 bg-slate-900/40 p-4">
          <button type="button" aria-expanded={advanced} onClick={() => setAdvanced(!advanced)} className="text-sm font-medium">Advanced settings</button>
          {advanced ? <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <label className="space-y-2 text-sm">Steps<input type="number" min={100} max={10000} step={50} value={steps} onChange={(event) => setSteps(Number(event.target.value))} className="block w-full rounded-lg border border-slate-600 bg-slate-950 px-3 py-2" /></label>
            <label className="space-y-2 text-sm">Learning rate<input type="number" min={0.00001} max={0.001} step={0.00001} value={learningRate} onChange={(event) => setLearningRate(Number(event.target.value))} className="block w-full rounded-lg border border-slate-600 bg-slate-950 px-3 py-2" /></label>
            <label className="space-y-2 text-sm">Resolution<select value={resolution} onChange={(event) => setResolution(Number(event.target.value) as 512 | 768 | 1024)} className="block w-full rounded-lg border border-slate-600 bg-slate-950 px-3 py-2"><option value={512}>512</option><option value={768}>768</option><option value={1024}>1024</option></select></label>
            <label className="space-y-2 text-sm">Rank<select value={rank} onChange={(event) => setRank(Number(event.target.value) as 16 | 32 | 64)} className="block w-full rounded-lg border border-slate-600 bg-slate-950 px-3 py-2"><option value={16}>16</option><option value={32}>32</option><option value={64}>64</option></select></label>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={fourBit} onChange={(event) => setFourBit(event.target.checked)} />4-bit model weights</label>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={attentionOnly} onChange={(event) => setAttentionOnly(event.target.checked)} />Attention layers only</label>
          </div> : null}
        </section>
        <Button disabled={!canTrain} onClick={() => void startTraining()}>{pending ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : null}Train locally</Button>
      </div>}
      {error ? <p role="alert" className="rounded-lg border border-red-800 bg-red-950/30 px-3 py-2 text-sm text-red-200">{error}</p> : null}
    </div>
  </div>;
}
