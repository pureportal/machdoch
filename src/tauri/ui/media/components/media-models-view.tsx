import {
  ChevronDown,
  Cloud,
  Cpu,
  Database,
  Download,
  ExternalLink,
  FileCheck2,
  Gauge,
  HardDrive,
  Image as ImageIcon,
  LoaderCircle,
  Layers3,
  LockKeyhole,
  MemoryStick,
  PenTool,
  RefreshCw,
  Scissors,
  ServerCog,
  Shield,
  Trash2,
  TriangleAlert,
  Upload,
} from "lucide-react";
import { useEffect, useState, type JSX } from "react";
import type {
  MediaHardwareInspection,
  DownloadMediaCivitaiModelAddonRequest,
  ImportMediaLocalModelRequest,
  ImportMediaModelAddonRequest,
  MediaLocalModelImportInspection,
  MediaLocalModelImportResult,
  MediaModelCatalogSnapshot,
  MediaModelAddonImportInspection,
  MediaModelAddonImportResult,
  MediaModelAddonRemovalPlan,
  MediaModelAddonRemovalResult,
  MediaCivitaiModelAddonInspection,
  MediaCapability,
  MediaModelDescriptor,
  MediaModelInstallJob,
  MediaModelInstallPlan,
  MediaModelRemovalPlan,
  MediaModelRemovalResult,
  MediaLocalDiffusersRuntimeStatus,
  MediaToolProbe,
  RemoveMediaModelRequest,
  RemoveMediaModelAddonRequest,
  StartMediaModelInstallRequest,
} from "../../../../core/media/contracts.js";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import { cn } from "../../lib/utils";

const FFMPEG_DOWNLOAD_URL = "https://www.ffmpeg.org/download.html";
const PYTHON_DOWNLOAD_URL = "https://www.python.org/downloads/";
const PYTORCH_INSTALL_URL = "https://pytorch.org/get-started/previous-versions/";
const LOCAL_DIFFUSERS_PYTHON_REQUIREMENT = "3.10+";
// Keep these pins aligned with src-tauri/python/media_diffusers_requirements.txt.
const LOCAL_DIFFUSERS_PACKAGE_REQUIREMENTS = [
  { id: "torch", name: "PyTorch", version: "2.13.0" },
  { id: "diffusers", name: "Diffusers", version: "0.39.0" },
  { id: "transformers", name: "Transformers", version: "5.13.0" },
  { id: "accelerate", name: "Accelerate", version: "1.14.0" },
  { id: "peft", name: "PEFT", version: "0.19.1" },
  { id: "safetensors", name: "Safetensors", version: "0.8.0" },
  { id: "pillow", name: "Pillow", version: "12.3.0" },
] as const;
const LOCAL_DIFFUSERS_PACKAGE_INSTALL_COMMAND =
  "python -m pip install diffusers==0.39.0 transformers==5.13.0 accelerate==1.14.0 peft==0.19.1 safetensors==0.8.0 Pillow==12.3.0";

type RuntimeRequirementState = "ready" | "missing" | "mismatch" | "unknown";

interface MediaModelsViewProps {
  catalog: MediaModelCatalogSnapshot;
  catalogLoading: boolean;
  catalogError: string | null;
  hardware: MediaHardwareInspection | null;
  hardwareLoading: boolean;
  hardwareError: string | null;
  installPlan: MediaModelInstallPlan | null;
  installJob: MediaModelInstallJob | null;
  installLoading: boolean;
  installError: string | null;
  removalPlan: MediaModelRemovalPlan | null;
  removalResult: MediaModelRemovalResult | null;
  removalLoading: boolean;
  removalError: string | null;
  modelImportInspection: MediaLocalModelImportInspection | null;
  modelImportResult: MediaLocalModelImportResult | null;
  modelImportSupported: boolean;
  modelImportLoading: boolean;
  modelImportError: string | null;
  modelProbeSupported: boolean;
  modelProbeLoadingId: string | null;
  modelProbeError: string | null;
  addonImportInspection: MediaModelAddonImportInspection | null;
  addonImportResult: MediaModelAddonImportResult | null;
  addonImportSupported: boolean;
  addonImportLoading: boolean;
  addonImportError: string | null;
  civitaiAddonInspection: MediaCivitaiModelAddonInspection | null;
  addonImportCivitaiSource: MediaCivitaiModelAddonInspection | null;
  civitaiAddonLoading: boolean;
  civitaiAddonError: string | null;
  addonRemovalPlan: MediaModelAddonRemovalPlan | null;
  addonRemovalResult: MediaModelAddonRemovalResult | null;
  addonRemovalLoading: boolean;
  addonRemovalError: string | null;
  localDiffusers: MediaLocalDiffusersRuntimeStatus | null;
  onRefreshHardware: () => void;
  onRefreshCatalog: () => void;
  onReviewInstall: (modelId: string) => void;
  onStartInstall: (request: StartMediaModelInstallRequest) => void;
  onCancelInstall: (jobId: string) => void;
  onDismissInstall: () => void;
  onReviewRemoval: (modelId: string) => void;
  onConfirmRemoval: (request: RemoveMediaModelRequest) => void;
  onDismissRemoval: () => void;
  onChooseModelImport: () => void;
  onImportModel: (request: ImportMediaLocalModelRequest) => void;
  onDismissModelImport: () => void;
  onProbeModel: (modelId: string) => void;
  onChooseAddonImport: () => void;
  onInspectCivitaiAddon: (source: string) => void;
  onDownloadCivitaiAddon: (
    request: DownloadMediaCivitaiModelAddonRequest,
  ) => void;
  onDismissCivitaiAddon: () => void;
  onReviewAddonRemoval: (addonId: string) => void;
  onConfirmAddonRemoval: (request: RemoveMediaModelAddonRequest) => void;
  onDismissAddonRemoval: () => void;
  onImportAddon: (request: ImportMediaModelAddonRequest) => void;
  onDismissAddonImport: () => void;
  onOpenProviderSettings: () => void;
}

const isReady = (model: MediaModelDescriptor): boolean => {
  if (model.target === "remote") return model.configured;
  if (model.providerId === "local-diffusers") {
    return model.installed && model.runtimeReadiness === "ready";
  }
  return model.installed;
};

type MediaModelPurpose =
  | "image-generation"
  | "vector-graphics"
  | "background-removal"
  | "image-analysis"
  | "other";

const getMediaModelPurpose = (model: MediaModelDescriptor): MediaModelPurpose => {
  const hasCapability = (capability: MediaCapability): boolean =>
    model.capabilities.includes(capability);

  if (
    hasCapability("text-to-svg") ||
    hasCapability("image-to-svg") ||
    hasCapability("guided-svg-generation") ||
    hasCapability("svg-edit")
  ) {
    return "vector-graphics";
  }

  if (
    hasCapability("text-to-image") ||
    hasCapability("image-to-image") ||
    hasCapability("multi-reference-edit")
  ) {
    return "image-generation";
  }

  if (hasCapability("background-remove")) {
    return "background-removal";
  }

  if (hasCapability("image-quality-analysis")) {
    return "image-analysis";
  }

  return "other";
};

const MEDIA_MODEL_PURPOSE_GROUPS = [
  {
    id: "image-generation",
    title: "Image generation",
    description: "Create and edit pixel-based images from prompts and references.",
    icon: ImageIcon,
    iconClassName: "text-fuchsia-300",
  },
  {
    id: "vector-graphics",
    title: "Vector graphics",
    description: "Create and vectorize scalable SVG artwork.",
    icon: PenTool,
    iconClassName: "text-sky-300",
  },
  {
    id: "background-removal",
    title: "Background removal",
    description: "Extract subjects and produce transparent image outputs.",
    icon: Scissors,
    iconClassName: "text-emerald-300",
  },
  {
    id: "image-analysis",
    title: "Image analysis",
    description: "Inspect images with local technical analysis tools.",
    icon: Gauge,
    iconClassName: "text-amber-300",
  },
  {
    id: "other",
    title: "Other models",
    description: "Models without a recognized primary media purpose.",
    icon: Layers3,
    iconClassName: "text-slate-400",
  },
] as const;

const readinessLabel = (model: MediaModelDescriptor): string => {
  if (isReady(model)) return "Ready";
  if (model.target === "remote") return "Configure";
  if (!model.installed) return "Not installed";
  if (model.runtimeReadiness === "failed") return "Verification failed";
  if (model.runtimeReadiness === "runtime-unavailable") return "Runtime unavailable";
  return "Needs verification";
};

const formatBytes = (bytes: number | null): string => {
  if (bytes === null) {
    return "Not reported";
  }
  return `${(bytes / 1_024 ** 3).toFixed(1)} GiB`;
};

const formatBytesWithSuffix = (
  bytes: number | null,
  suffix: string,
): string => (bytes === null ? "Not reported" : `${formatBytes(bytes)} ${suffix}`);

const formatFileBytes = (bytes: number): string => {
  if (bytes < 1_024) {
    return `${bytes} B`;
  }
  if (bytes < 1_024 ** 2) {
    return `${(bytes / 1_024).toFixed(1)} KiB`;
  }
  if (bytes < 1_024 ** 3) {
    return `${(bytes / 1_024 ** 2).toFixed(1)} MiB`;
  }
  return `${(bytes / 1_024 ** 3).toFixed(2)} GiB`;
};

const formatObservedAt = (value: string): string => {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? new Date(timestamp).toLocaleString()
    : "Unknown observation time";
};

const compactDigest = (value: string): string =>
  `${value.slice(0, 10)}…${value.slice(-8)}`;

const ACTIVE_INSTALL_STATUSES = [
  "queued",
  "downloading",
  "verifying",
  "activating",
  "canceling",
] as const;

const isActiveInstall = (job: MediaModelInstallJob | null): boolean =>
  job !== null && ACTIVE_INSTALL_STATUSES.includes(
    job.status as (typeof ACTIVE_INSTALL_STATUSES)[number],
  );

const ModelInstallDialog = ({
  plan,
  job,
  loading,
  error,
  onStart,
  onCancel,
  onDismiss,
}: {
  plan: MediaModelInstallPlan | null;
  job: MediaModelInstallJob | null;
  loading: boolean;
  error: string | null;
  onStart: (request: StartMediaModelInstallRequest) => void;
  onCancel: (jobId: string) => void;
  onDismiss: () => void;
}): JSX.Element => {
  const [licenseAccepted, setLicenseAccepted] = useState(false);
  useEffect(() => {
    setLicenseAccepted(false);
  }, [plan?.reviewToken]);

  const active = isActiveInstall(job);
  const insufficientSpace = plan?.hasSufficientSpace === false;
  return (
    <Dialog
      open={plan !== null}
      onOpenChange={(open) => {
        if (!open) {
          onDismiss();
        }
      }}
    >
      {plan ? (
        <DialogContent
          className="max-h-[min(860px,calc(100vh-32px))] w-[min(820px,calc(100vw-32px))] max-w-none gap-0 overflow-hidden border-slate-800 bg-slate-950 p-0 text-slate-100 sm:max-w-none"
          confirmOnInteractOutside={
            licenseAccepted && !job
              ? {
                  title: "Discard this reviewed install?",
                  description:
                    "The pinned manifest will need to be reviewed and accepted again.",
                  confirmLabel: "Discard review",
                }
              : false
          }
        >
          <DialogHeader className="border-b border-slate-800 px-6 py-5 pr-12 text-left">
            <div className="flex items-center gap-2 text-[10px] font-semibold tracking-[0.14em] text-violet-300 uppercase">
              <LockKeyhole className="h-3.5 w-3.5" /> Reviewed local install
            </div>
            <DialogTitle className="text-lg text-white">
              Install {plan.displayName}
            </DialogTitle>
            <DialogDescription className="text-xs leading-5 text-slate-500">
              A commit-pinned, allowlisted Diffusers package. Nothing is activated until every reviewed byte passes verification.
            </DialogDescription>
          </DialogHeader>

          <div className="overflow-y-auto px-6 py-5">
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="rounded-xl border border-slate-800 bg-slate-900/45 p-3.5">
                <div className="text-[9px] tracking-[0.12em] text-slate-600 uppercase">Download</div>
                <div className="mt-1.5 text-sm font-semibold text-slate-200">{formatBytes(plan.totalBytes)}</div>
                <div className="mt-1 text-[10px] text-slate-600">{plan.files.length} allowlisted files</div>
              </div>
              <div className="rounded-xl border border-slate-800 bg-slate-900/45 p-3.5">
                <div className="text-[9px] tracking-[0.12em] text-slate-600 uppercase">Working space</div>
                <div className="mt-1.5 text-sm font-semibold text-slate-200">{formatBytes(plan.requiredWorkingBytes)}</div>
                <div className="mt-1 text-[10px] text-slate-600">includes staging headroom</div>
              </div>
              <div className={cn(
                "rounded-xl border p-3.5",
                insufficientSpace
                  ? "border-rose-400/25 bg-rose-950/20"
                  : "border-slate-800 bg-slate-900/45",
              )}>
                <div className="text-[9px] tracking-[0.12em] text-slate-600 uppercase">Available</div>
                <div className={cn("mt-1.5 text-sm font-semibold", insufficientSpace ? "text-rose-200" : "text-slate-200")}>
                  {formatBytes(plan.availableBytes)}
                </div>
                <div className="mt-1 text-[10px] text-slate-600">checked again before queueing</div>
              </div>
            </div>

            <div className="mt-4 rounded-xl border border-slate-800 bg-slate-900/30 p-4">
              <dl className="grid gap-3 text-[11px] sm:grid-cols-[120px_1fr]">
                <dt className="text-slate-600">Pinned revision</dt>
                <dd className="break-all font-mono text-slate-300">{plan.revision}</dd>
                <dt className="text-slate-600">Manifest SHA-256</dt>
                <dd title={plan.manifestDigest} className="font-mono text-slate-300">{compactDigest(plan.manifestDigest)}</dd>
                <dt className="text-slate-600">Install location</dt>
                <dd className="break-all font-mono text-slate-400">{plan.targetLabel}</dd>
              </dl>
            </div>

            {job ? (
              <div
                className="mt-4 rounded-xl border border-violet-400/20 bg-violet-950/15 p-4"
                aria-live="polite"
              >
                <div className="flex items-center justify-between gap-3 text-xs">
                  <span className="font-semibold capitalize text-violet-100">{job.status}</span>
                  <span className="font-mono text-violet-300">{Math.round(job.progress * 100)}%</span>
                </div>
                <div
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(job.progress * 100)}
                  aria-label="Model installation progress"
                  className="mt-3 h-1.5 overflow-hidden rounded-full bg-slate-800"
                >
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-violet-500 to-cyan-400 transition-[width] duration-300"
                    style={{ width: `${Math.max(1, job.progress * 100)}%` }}
                  />
                </div>
                <div className="mt-2 flex flex-wrap justify-between gap-2 text-[10px] text-slate-500">
                  <span>{job.filesCompleted}/{job.filesTotal} files · {formatBytes(job.bytesDownloaded)} verified or downloaded</span>
                  <span className="max-w-full truncate font-mono">{job.currentFile ?? "Safe checkpoint"}</span>
                </div>
                {job.error ? <p className="mt-3 text-xs leading-5 text-rose-200">{job.error}</p> : null}
                {job.id.startsWith("browser-") ? (
                  <p className="mt-3 text-[10px] leading-4 text-amber-200/70">
                    Browser preview simulates the state machine only. The desktop app performs the real disk, network, and digest operations.
                  </p>
                ) : null}
              </div>
            ) : null}

            <details className="mt-4 rounded-xl border border-slate-800 bg-slate-900/25 open:bg-slate-900/40">
              <summary className="cursor-pointer select-none px-4 py-3 text-xs font-semibold text-slate-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/50">
                Exact file allowlist ({plan.files.length})
              </summary>
              <div className="max-h-52 overflow-auto border-t border-slate-800 px-4 py-2">
                {plan.files.map((file) => (
                  <div key={file.path} className="grid grid-cols-[1fr_auto] gap-3 border-b border-slate-800/60 py-2 text-[10px] last:border-b-0">
                    <div className="min-w-0">
                      <div className="truncate font-mono text-slate-300" title={file.path}>{file.path}</div>
                      <div className="mt-0.5 font-mono text-slate-700" title={file.sha256}>{compactDigest(file.sha256)}</div>
                    </div>
                    <div className="text-slate-500">{formatFileBytes(file.byteSize)}</div>
                  </div>
                ))}
              </div>
            </details>

            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <div className="rounded-xl border border-emerald-400/15 bg-emerald-950/10 p-4">
                <div className="flex items-center gap-2 text-xs font-semibold text-emerald-200">
                  <FileCheck2 className="h-4 w-4" /> Included safeguards
                </div>
                <ul className="mt-2 space-y-1.5 text-[10px] leading-4 text-slate-500">
                  <li>HTTPS from a fixed repository and immutable commit</li>
                  <li>Resumable partial files with exact size and SHA-256 checks</li>
                  <li>Atomic revision activation; interrupted commits are re-verified</li>
                </ul>
              </div>
              <div className="rounded-xl border border-slate-800 bg-slate-900/25 p-4">
                <div className="text-xs font-semibold text-slate-300">Deliberately excluded</div>
                <ul className="mt-2 space-y-1.5 text-[10px] leading-4 text-slate-500">
                  {plan.excludedPaths.map((path) => <li key={path}>{path}</li>)}
                </ul>
              </div>
            </div>

            {error ? (
              <div role="alert" className="mt-4 rounded-xl border border-rose-400/20 bg-rose-950/20 px-4 py-3 text-xs leading-5 text-rose-200">
                {error}
              </div>
            ) : null}
            {insufficientSpace ? (
              <div role="alert" className="mt-4 rounded-xl border border-rose-400/20 bg-rose-950/20 px-4 py-3 text-xs leading-5 text-rose-200">
                Free at least {formatBytes(plan.requiredWorkingBytes - (plan.availableBytes ?? 0))} on the Media Studio volume before installing.
              </div>
            ) : null}

            {!job ? (
              <label className="mt-4 flex cursor-pointer items-start gap-3 rounded-xl border border-slate-800 bg-slate-900/35 p-4 text-xs leading-5 text-slate-300">
                <input
                  type="checkbox"
                  checked={licenseAccepted}
                  onChange={(event) => setLicenseAccepted(event.currentTarget.checked)}
                  className="mt-0.5 h-4 w-4 rounded border-slate-700 bg-slate-950 accent-violet-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/60"
                />
                <span>
                  I reviewed and accept the{" "}
                  <a
                    href={plan.license.sourceUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-violet-300 underline decoration-violet-400/40 underline-offset-2 hover:text-violet-200"
                  >
                    {plan.license.name}
                  </a>{" "}
                  for revision <span className="font-mono text-slate-400">{plan.revision.slice(0, 12)}</span>.
                </span>
              </label>
            ) : null}
          </div>

          <DialogFooter className="border-t border-slate-800 bg-slate-950/95 px-6 py-4">
            {job && active && job.status !== "activating" ? (
              <Button
                type="button"
                variant="outline"
                disabled={loading || job.status === "canceling"}
                onClick={() => onCancel(job.id)}
                className="border-rose-400/25 text-rose-200 hover:bg-rose-950/30"
              >
                {job.status === "canceling" ? "Canceling at checkpoint…" : "Cancel download"}
              </Button>
            ) : null}
            {!job ? (
              <Button
                type="button"
                disabled={loading || !licenseAccepted || insufficientSpace || plan.alreadyInstalled}
                onClick={() =>
                  onStart({
                    modelId: plan.modelId,
                    reviewToken: plan.reviewToken,
                    manifestDigest: plan.manifestDigest,
                    licenseDigest: plan.licenseDigest,
                    acceptLicense: licenseAccepted,
                  })
                }
                className="bg-violet-500 text-white hover:bg-violet-400"
              >
                {loading ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                {plan.alreadyInstalled ? "Revision already installed" : "Install verified package"}
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      ) : null}
    </Dialog>
  );
};

const LOCAL_MODEL_ARCHITECTURES = [
  ["stable-diffusion-1", "Stable Diffusion 1.x"],
  ["stable-diffusion-2", "Stable Diffusion 2.x"],
  ["stable-diffusion-xl", "Stable Diffusion XL"],
  ["stable-diffusion-3", "Stable Diffusion 3"],
  ["flux-1", "FLUX.1"],
  ["flux-2", "FLUX.2"],
] as const;

const ModelImportDialog = ({
  inspection,
  result,
  loading,
  error,
  onImport,
  onDismiss,
}: {
  inspection: MediaLocalModelImportInspection | null;
  result: MediaLocalModelImportResult | null;
  loading: boolean;
  error: string | null;
  onImport: (request: ImportMediaLocalModelRequest) => void;
  onDismiss: () => void;
}): JSX.Element => {
  const [displayName, setDisplayName] = useState("");
  const [architecture, setArchitecture] =
    useState<ImportMediaLocalModelRequest["architecture"]>("stable-diffusion-xl");
  const [sourceUrl, setSourceUrl] = useState("");
  const [licenseName, setLicenseName] = useState("Custom / community model terms");
  const [commercialUse, setCommercialUse] =
    useState<ImportMediaLocalModelRequest["commercialUse"]>("review-required");
  const [confirmRights, setConfirmRights] = useState(false);

  useEffect(() => {
    if (!inspection) return;
    setDisplayName(inspection.suggestedDisplayName);
    setArchitecture(inspection.detectedArchitecture ?? "stable-diffusion-xl");
    setSourceUrl("");
    setLicenseName("Custom / community model terms");
    setCommercialUse("review-required");
    setConfirmRights(false);
  }, [inspection?.reviewToken]);

  const canSubmit =
    inspection?.canImport === true &&
    !result &&
    displayName.trim().length > 0 &&
    licenseName.trim().length > 0 &&
    confirmRights &&
    !loading;
  const fieldClassName =
    "mt-1.5 h-10 w-full rounded-lg border border-slate-800 bg-slate-950/80 px-3 text-xs text-slate-200 outline-none placeholder:text-slate-700 focus:border-violet-400/50 focus:ring-2 focus:ring-violet-400/10";

  return (
    <Dialog open={inspection !== null} onOpenChange={(open) => !open && onDismiss()}>
      {inspection ? (
        <DialogContent
          className="max-h-[min(880px,calc(100vh-32px))] w-[min(760px,calc(100vw-32px))] max-w-none gap-0 overflow-hidden border-violet-400/20 bg-slate-950 p-0 text-slate-100 sm:max-w-none"
          confirmOnInteractOutside={
            confirmRights && !result
              ? {
                  title: "Discard this model review?",
                  description: "The checkpoint will need to be inspected again.",
                  confirmLabel: "Discard review",
                }
              : false
          }
        >
          <DialogHeader className="border-b border-slate-800 px-6 py-5 pr-12 text-left">
            <div className="flex items-center gap-2 text-[10px] font-semibold tracking-[0.14em] text-violet-300 uppercase">
              <Upload className="h-3.5 w-3.5" /> Import local checkpoint
            </div>
            <DialogTitle className="text-lg text-white">
              Review {inspection.sourceFileName}
            </DialogTitle>
            <DialogDescription className="text-xs leading-5 text-slate-500">
              Machdoch accepts data-only safetensors checkpoints and copies the verified file into its managed model store.
            </DialogDescription>
          </DialogHeader>

          <div className="overflow-y-auto px-6 py-5">
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-3.5">
                <div className="text-[9px] tracking-wider text-slate-600 uppercase">File size</div>
                <div className="mt-1.5 text-sm font-semibold text-slate-200">{formatBytes(inspection.byteSize)}</div>
              </div>
              <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-3.5">
                <div className="text-[9px] tracking-wider text-slate-600 uppercase">Tensor inventory</div>
                <div className="mt-1.5 text-sm font-semibold text-slate-200">{inspection.tensorCount.toLocaleString()}</div>
              </div>
              <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-3.5">
                <div className="text-[9px] tracking-wider text-slate-600 uppercase">Detection</div>
                <div className="mt-1.5 text-sm font-semibold capitalize text-slate-200">{inspection.architectureConfidence}</div>
              </div>
            </div>

            {inspection.blockingReason ? (
              <div role="alert" className="mt-4 rounded-xl border border-amber-400/20 bg-amber-950/20 px-4 py-3 text-xs leading-5 text-amber-100">
                {inspection.blockingReason}
              </div>
            ) : null}

            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <label className="text-[11px] font-medium text-slate-400">
                Display name
                <input
                  value={displayName}
                  maxLength={120}
                  disabled={Boolean(result)}
                  onChange={(event) => setDisplayName(event.currentTarget.value)}
                  className={fieldClassName}
                />
              </label>
              <label className="text-[11px] font-medium text-slate-400">
                Base architecture
                <select
                  value={architecture}
                  disabled={Boolean(result)}
                  onChange={(event) =>
                    setArchitecture(event.currentTarget.value as ImportMediaLocalModelRequest["architecture"])
                  }
                  className={fieldClassName}
                >
                  {LOCAL_MODEL_ARCHITECTURES.map(([value, label]) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </select>
              </label>
              <label className="text-[11px] font-medium text-slate-400 sm:col-span-2">
                Publisher page <span className="font-normal text-slate-600">(optional, HTTPS)</span>
                <input
                  type="url"
                  value={sourceUrl}
                  maxLength={2_048}
                  disabled={Boolean(result)}
                  placeholder="https://civitai.com/models/…"
                  onChange={(event) => setSourceUrl(event.currentTarget.value)}
                  className={fieldClassName}
                />
              </label>
              <label className="text-[11px] font-medium text-slate-400">
                License / usage terms
                <input
                  value={licenseName}
                  maxLength={256}
                  disabled={Boolean(result)}
                  onChange={(event) => setLicenseName(event.currentTarget.value)}
                  className={fieldClassName}
                />
              </label>
              <label className="text-[11px] font-medium text-slate-400">
                Commercial use
                <select
                  value={commercialUse}
                  disabled={Boolean(result)}
                  onChange={(event) =>
                    setCommercialUse(event.currentTarget.value as ImportMediaLocalModelRequest["commercialUse"])
                  }
                  className={fieldClassName}
                >
                  <option value="review-required">Review required / unknown</option>
                  <option value="allowed">Publisher allows it</option>
                </select>
              </label>
            </div>

            {inspection.metadataSummary.length > 0 ? (
              <details className="mt-4 rounded-xl border border-slate-800 bg-slate-900/25">
                <summary className="cursor-pointer px-4 py-3 text-xs font-semibold text-slate-400">
                  Detected checkpoint metadata
                </summary>
                <div className="space-y-1 border-t border-slate-800 px-4 py-3 font-mono text-[10px] break-all text-slate-500">
                  {inspection.metadataSummary.map((item) => <p key={item}>{item}</p>)}
                  <p>header sha256 {compactDigest(inspection.headerDigest)}</p>
                </div>
              </details>
            ) : null}

            <ul className="mt-4 space-y-2 text-[10px] leading-4 text-slate-500">
              {inspection.warnings.map((warning) => (
                <li key={warning} className="flex gap-2">
                  <Shield className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-300/70" />
                  {warning}
                </li>
              ))}
            </ul>

            {error ? (
              <div role="alert" className="mt-4 rounded-xl border border-rose-400/20 bg-rose-950/20 px-4 py-3 text-xs leading-5 text-rose-200">
                {error}
              </div>
            ) : null}
            {result ? (
              <div role="status" className="mt-4 rounded-xl border border-emerald-400/20 bg-emerald-950/20 px-4 py-3 text-xs leading-5 text-emerald-200">
                {result.alreadyInstalled ? "This exact checkpoint was already installed." : "Checkpoint imported and verified."} {formatBytes(result.byteSize)} · sha256 {compactDigest(result.digest)}
              </div>
            ) : inspection.canImport ? (
              <label className="mt-4 flex cursor-pointer items-start gap-3 rounded-xl border border-violet-400/15 bg-violet-950/10 p-4 text-xs leading-5 text-slate-300">
                <input
                  type="checkbox"
                  checked={confirmRights}
                  onChange={(event) => setConfirmRights(event.currentTarget.checked)}
                  className="mt-0.5 h-4 w-4 accent-violet-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/60"
                />
                I reviewed the publisher&apos;s license and model page, have the right to use these weights, and confirmed the selected base architecture.
              </label>
            ) : null}
          </div>

          <DialogFooter className="border-t border-slate-800 px-6 py-4">
            {!result && inspection.canImport ? (
              <Button
                type="button"
                disabled={!canSubmit}
                onClick={() =>
                  onImport({
                    sourcePath: inspection.sourcePath,
                    reviewToken: inspection.reviewToken,
                    displayName: displayName.trim(),
                    architecture,
                    sourceUrl: sourceUrl.trim() || null,
                    licenseName: licenseName.trim(),
                    commercialUse,
                    confirmRights,
                  })
                }
                className="bg-violet-500 text-white hover:bg-violet-400"
              >
                {loading ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                Copy and verify checkpoint
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      ) : null}
    </Dialog>
  );
};

const CivitaiAddonImportDialog = ({
  open,
  inspection,
  loading,
  error,
  onInspect,
  onDownload,
  onDismiss,
}: {
  open: boolean;
  inspection: MediaCivitaiModelAddonInspection | null;
  loading: boolean;
  error: string | null;
  onInspect: (source: string) => void;
  onDownload: (request: DownloadMediaCivitaiModelAddonRequest) => void;
  onDismiss: () => void;
}): JSX.Element => {
  const [source, setSource] = useState("");
  useEffect(() => {
    if (!open) setSource("");
  }, [open]);

  const fieldClassName =
    "mt-1.5 h-10 w-full rounded-lg border border-slate-800 bg-slate-950/80 px-3 text-xs text-slate-200 outline-none placeholder:text-slate-700 focus:border-cyan-400/50 focus:ring-2 focus:ring-cyan-400/10";
  const commercialClaims =
    inspection?.licenseClaims.allowCommercialUse?.join(", ") ?? "Not reported";

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && onDismiss()}>
      <DialogContent className="max-h-[min(880px,calc(100vh-32px))] w-[min(720px,calc(100vw-32px))] max-w-none gap-0 overflow-hidden border-cyan-400/20 bg-slate-950 p-0 text-slate-100 sm:max-w-none">
        <DialogHeader className="border-b border-slate-800 px-6 py-5 pr-12 text-left">
          <div className="flex items-center gap-2 text-[10px] font-semibold tracking-[0.14em] text-cyan-300 uppercase">
            <Cloud className="h-3.5 w-3.5" /> Reviewed Civitai import
          </div>
          <DialogTitle className="text-lg text-white">
            {inspection ? `Review ${inspection.modelName}` : "Import LoRA or embedding from Civitai"}
          </DialogTitle>
          <DialogDescription className="text-xs leading-5 text-slate-500">
            Paste a Civitai model URL, modelId@versionId, or full AIR identifier. Metadata is reviewed before any model bytes are downloaded.
          </DialogDescription>
        </DialogHeader>

        <div className="overflow-y-auto px-6 py-5">
          {!inspection ? (
            <label className="text-[11px] font-medium text-slate-400">
              Civitai URL or AIR
              <input
                value={source}
                maxLength={2_048}
                disabled={loading}
                placeholder="https://civitai.com/models/… or urn:air:…"
                onChange={(event) => setSource(event.currentTarget.value)}
                className={fieldClassName}
              />
            </label>
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-3.5">
                  <div className="text-[9px] tracking-wider text-slate-600 uppercase">Publisher</div>
                  <div className="mt-1.5 text-sm font-semibold text-slate-200">
                    {inspection.creator ?? "Not reported"}
                  </div>
                </div>
                <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-3.5">
                  <div className="text-[9px] tracking-wider text-slate-600 uppercase">Type</div>
                  <div className="mt-1.5 text-sm font-semibold text-slate-200">
                    {inspection.kind === "lora"
                      ? "LoRA"
                      : inspection.kind === "textual-inversion"
                        ? "Embedding"
                        : "Unsupported"}
                  </div>
                </div>
                <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-3.5">
                  <div className="text-[9px] tracking-wider text-slate-600 uppercase">Base model</div>
                  <div className="mt-1.5 text-sm font-semibold text-slate-200">
                    {inspection.baseModel ?? "Not reported"}
                  </div>
                </div>
              </div>

              <div className="mt-4 rounded-xl border border-slate-800 bg-slate-900/25 px-4 py-3 text-xs leading-5 text-slate-400">
                <div className="font-semibold text-slate-200">{inspection.versionName}</div>
                <div className="mt-1">
                  Version {inspection.versionId} · {inspection.availability ?? "unknown availability"} · {inspection.status ?? "unknown status"}
                </div>
                {inspection.file ? (
                  <div className="mt-2 break-all font-mono text-[10px] text-slate-500">
                    {inspection.file.name} · {formatFileBytes(inspection.file.byteSize)} · sha256 {compactDigest(inspection.file.sha256)}
                  </div>
                ) : null}
              </div>

              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <div className="rounded-xl border border-slate-800 bg-slate-900/30 px-4 py-3 text-[11px] leading-5 text-slate-400">
                  <div className="font-semibold text-slate-300">Civitai scan claims</div>
                  <div>Pickle: {inspection.file?.pickleScanResult ?? "Not reported"}</div>
                  <div>Virus: {inspection.file?.virusScanResult ?? "Not reported"}</div>
                </div>
                <div className="rounded-xl border border-slate-800 bg-slate-900/30 px-4 py-3 text-[11px] leading-5 text-slate-400">
                  <div className="font-semibold text-slate-300">Publisher permission claims</div>
                  <div>Commercial use: {commercialClaims}</div>
                  <div>Derivatives: {inspection.licenseClaims.allowDerivatives === null ? "Not reported" : inspection.licenseClaims.allowDerivatives ? "Allowed" : "Not allowed"}</div>
                </div>
              </div>

              {inspection.trainedWords.length > 0 ? (
                <div className="mt-4 rounded-xl border border-cyan-400/15 bg-cyan-950/10 px-4 py-3 text-xs leading-5 text-cyan-100">
                  Publisher trigger words: {inspection.trainedWords.join(", ")}
                </div>
              ) : null}
              {inspection.blockingReason ? (
                <div role="alert" className="mt-4 rounded-xl border border-amber-400/20 bg-amber-950/20 px-4 py-3 text-xs leading-5 text-amber-100">
                  {inspection.blockingReason}
                </div>
              ) : null}
              <ul className="mt-4 space-y-2 text-[10px] leading-4 text-slate-500">
                {inspection.warnings.map((warning) => (
                  <li key={warning} className="flex gap-2">
                    <Shield className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-300/70" />
                    {warning}
                  </li>
                ))}
              </ul>
              <a
                href={inspection.sourceUrl}
                target="_blank"
                rel="noreferrer"
                className="mt-4 inline-flex items-center gap-1.5 text-xs text-cyan-300 hover:text-cyan-200"
              >
                Review publisher page <ExternalLink className="h-3.5 w-3.5" />
              </a>
            </>
          )}
          {error ? (
            <div role="alert" className="mt-4 rounded-xl border border-rose-400/20 bg-rose-950/20 px-4 py-3 text-xs leading-5 text-rose-200">
              {error}
            </div>
          ) : null}
        </div>

        <DialogFooter className="border-t border-slate-800 px-6 py-4">
          {!inspection ? (
            <Button
              type="button"
              disabled={source.trim().length === 0 || loading}
              onClick={() => onInspect(source.trim())}
              className="bg-cyan-500 text-slate-950 hover:bg-cyan-400"
            >
              {loading ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <FileCheck2 className="h-4 w-4" />}
              Review Civitai add-on
            </Button>
          ) : (
            <Button
              type="button"
              disabled={!inspection.canDownload || loading}
              onClick={() => onDownload({
                source: inspection.sourceUrl,
                reviewToken: inspection.reviewToken,
              })}
              className="bg-cyan-500 text-slate-950 hover:bg-cyan-400"
            >
              {loading ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
              Download and inspect safetensors
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

const ModelAddonImportDialog = ({
  inspection,
  civitaiSource,
  result,
  loading,
  error,
  onImport,
  onDismiss,
}: {
  inspection: MediaModelAddonImportInspection | null;
  civitaiSource: MediaCivitaiModelAddonInspection | null;
  result: MediaModelAddonImportResult | null;
  loading: boolean;
  error: string | null;
  onImport: (request: ImportMediaModelAddonRequest) => void;
  onDismiss: () => void;
}): JSX.Element => {
  const [displayName, setDisplayName] = useState("");
  const [architecture, setArchitecture] =
    useState<ImportMediaModelAddonRequest["architecture"]>("stable-diffusion-xl");
  const [triggerWords, setTriggerWords] = useState("");
  const [token, setToken] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [licenseName, setLicenseName] = useState("Custom / community model terms");
  const [commercialUse, setCommercialUse] =
    useState<ImportMediaModelAddonRequest["commercialUse"]>("review-required");
  const [confirmRights, setConfirmRights] = useState(false);

  useEffect(() => {
    if (!inspection) return;
    setDisplayName(civitaiSource?.modelName ?? inspection.suggestedDisplayName);
    setArchitecture(
      inspection.detectedArchitecture ??
        civitaiSource?.suggestedArchitecture ??
        "stable-diffusion-xl",
    );
    setTriggerWords(
      [...inspection.suggestedTriggerWords, ...(civitaiSource?.trainedWords ?? [])]
        .filter((word, index, words) => words.indexOf(word) === index)
        .join(", "),
    );
    setToken(
      inspection.suggestedToken ??
        (inspection.detectedKind === "textual-inversion"
          ? (civitaiSource?.trainedWords[0] ?? "")
          : ""),
    );
    setSourceUrl(civitaiSource?.sourceUrl ?? "");
    setLicenseName(
      civitaiSource
        ? "Civitai publisher terms (review required)"
        : "Custom / community model terms",
    );
    setCommercialUse("review-required");
    setConfirmRights(false);
  }, [inspection?.reviewToken, civitaiSource?.reviewToken]);

  const kind = inspection?.detectedKind ?? null;
  const canSubmit =
    inspection?.canImport === true &&
    kind !== null &&
    !result &&
    displayName.trim().length > 0 &&
    licenseName.trim().length > 0 &&
    (kind !== "textual-inversion" || token.trim().length > 0) &&
    confirmRights &&
    !loading;
  const fieldClassName =
    "mt-1.5 h-10 w-full rounded-lg border border-slate-800 bg-slate-950/80 px-3 text-xs text-slate-200 outline-none placeholder:text-slate-700 focus:border-violet-400/50 focus:ring-2 focus:ring-violet-400/10";

  return (
    <Dialog open={inspection !== null} onOpenChange={(open) => !open && onDismiss()}>
      {inspection ? (
        <DialogContent className="max-h-[min(880px,calc(100vh-32px))] w-[min(760px,calc(100vw-32px))] max-w-none gap-0 overflow-hidden border-violet-400/20 bg-slate-950 p-0 text-slate-100 sm:max-w-none">
          <DialogHeader className="border-b border-slate-800 px-6 py-5 pr-12 text-left">
            <div className="flex items-center gap-2 text-[10px] font-semibold tracking-[0.14em] text-violet-300 uppercase">
              <Layers3 className="h-3.5 w-3.5" /> Import model add-on
            </div>
            <DialogTitle className="text-lg text-white">Review {inspection.sourceFileName}</DialogTitle>
            <DialogDescription className="text-xs leading-5 text-slate-500">
              Only the safetensors header and tensor inventory are inspected. No model code or pickle data is executed.
            </DialogDescription>
          </DialogHeader>

          <div className="overflow-y-auto px-6 py-5">
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-3.5">
                <div className="text-[9px] tracking-wider text-slate-600 uppercase">Detected type</div>
                <div className="mt-1.5 text-sm font-semibold text-slate-200">
                  {kind === "lora" ? "LoRA" : kind === "textual-inversion" ? "Embedding" : "Unknown"}
                </div>
              </div>
              <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-3.5">
                <div className="text-[9px] tracking-wider text-slate-600 uppercase">File size</div>
                <div className="mt-1.5 text-sm font-semibold text-slate-200">{formatFileBytes(inspection.byteSize)}</div>
              </div>
              <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-3.5">
                <div className="text-[9px] tracking-wider text-slate-600 uppercase">Targets</div>
                <div className="mt-1.5 text-xs font-semibold text-slate-200">
                  {inspection.targetComponents.map((component) => component.replaceAll("-", " ")).join(" · ") || "Unknown"}
                </div>
              </div>
            </div>

            {inspection.embeddingVectors.length > 0 ? (
              <div className="mt-4 rounded-xl border border-violet-400/15 bg-violet-950/10 px-4 py-3">
                <div className="text-[9px] font-semibold tracking-wider text-violet-300 uppercase">Verified embedding layout</div>
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  {inspection.embeddingVectors.map((profile) => (
                    <div key={`${profile.component}:${profile.tensorKey}`} className="rounded-lg border border-slate-800/80 bg-slate-950/50 px-3 py-2">
                      <div className="text-[10px] font-medium text-slate-300">
                        {profile.component.replaceAll("-", " ")} · {profile.vectorCount} {profile.vectorCount === 1 ? "vector" : "vectors"} × {profile.dimension}
                      </div>
                      <div className="mt-1 truncate font-mono text-[9px] text-slate-600" title={profile.tensorKey}>{profile.tensorKey}</div>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {inspection.loraProfile ? (
              <div className="mt-4 rounded-xl border border-cyan-400/15 bg-cyan-950/10 px-4 py-3">
                <div className="text-[9px] font-semibold tracking-wider text-cyan-300 uppercase">Verified LoRA tensor profile</div>
                <div className="mt-2 grid gap-2 text-[10px] text-slate-300 sm:grid-cols-3">
                  <div className="rounded-lg border border-slate-800/80 bg-slate-950/50 px-3 py-2">
                    <span className="block text-[9px] text-slate-600 uppercase">Algorithm</span>
                    {inspection.loraProfile.algorithm === "locon" ? "LoCon" : inspection.loraProfile.algorithm === "dora" ? "DoRA" : "LoRA"} · {inspection.loraProfile.dialect.replaceAll("-", " ")}
                  </div>
                  <div className="rounded-lg border border-slate-800/80 bg-slate-950/50 px-3 py-2">
                    <span className="block text-[9px] text-slate-600 uppercase">Rank</span>
                    {inspection.loraProfile.rankMinimum === inspection.loraProfile.rankMaximum ? inspection.loraProfile.rankMinimum : `${inspection.loraProfile.rankMinimum}–${inspection.loraProfile.rankMaximum}`} · {inspection.loraProfile.targetModuleCount} modules
                  </div>
                  <div className="rounded-lg border border-slate-800/80 bg-slate-950/50 px-3 py-2">
                    <span className="block text-[9px] text-slate-600 uppercase">Advanced tensors</span>
                    {inspection.loraProfile.convolutionTargetCount} convolution · {inspection.loraProfile.magnitudeVectorCount} magnitude · {inspection.loraProfile.networkAlphaCount} alpha
                  </div>
                </div>
              </div>
            ) : null}

            {inspection.blockingReason ? (
              <div role="alert" className="mt-4 rounded-xl border border-amber-400/20 bg-amber-950/20 px-4 py-3 text-xs leading-5 text-amber-100">
                {inspection.blockingReason}
              </div>
            ) : null}

            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <label className="text-[11px] font-medium text-slate-400">
                Display name
                <input value={displayName} maxLength={120} disabled={Boolean(result)} onChange={(event) => setDisplayName(event.currentTarget.value)} className={fieldClassName} />
              </label>
              <label className="text-[11px] font-medium text-slate-400">
                Base architecture {kind === "textual-inversion" && inspection.detectedArchitecture ? <span className="font-normal text-slate-600">(locked to tensor dimensions)</span> : null}
                <select value={architecture} disabled={Boolean(result) || (kind === "textual-inversion" && inspection.detectedArchitecture !== null)} onChange={(event) => setArchitecture(event.currentTarget.value as ImportMediaModelAddonRequest["architecture"])} className={fieldClassName}>
                  {LOCAL_MODEL_ARCHITECTURES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
              </label>
              {kind === "lora" ? (
                <label className="text-[11px] font-medium text-slate-400 sm:col-span-2">
                  Trigger words <span className="font-normal text-slate-600">(comma separated, optional)</span>
                  <input value={triggerWords} maxLength={1_024} disabled={Boolean(result)} onChange={(event) => setTriggerWords(event.currentTarget.value)} className={fieldClassName} />
                </label>
              ) : null}
              {kind === "textual-inversion" ? (
                <label className="text-[11px] font-medium text-slate-400 sm:col-span-2">
                  Prompt token
                  <input value={token} maxLength={128} disabled={Boolean(result)} onChange={(event) => setToken(event.currentTarget.value)} className={fieldClassName} />
                </label>
              ) : null}
              <label className="text-[11px] font-medium text-slate-400 sm:col-span-2">
                Publisher page <span className="font-normal text-slate-600">(optional, HTTPS)</span>
                <input type="url" value={sourceUrl} maxLength={2_048} disabled={Boolean(result)} placeholder="https://civitai.com/models/…" onChange={(event) => setSourceUrl(event.currentTarget.value)} className={fieldClassName} />
              </label>
              <label className="text-[11px] font-medium text-slate-400">
                License / usage terms
                <input value={licenseName} maxLength={256} disabled={Boolean(result)} onChange={(event) => setLicenseName(event.currentTarget.value)} className={fieldClassName} />
              </label>
              <label className="text-[11px] font-medium text-slate-400">
                Commercial use
                <select value={commercialUse} disabled={Boolean(result)} onChange={(event) => setCommercialUse(event.currentTarget.value as ImportMediaModelAddonRequest["commercialUse"])} className={fieldClassName}>
                  <option value="review-required">Review required / unknown</option>
                  <option value="allowed">Publisher allows it</option>
                </select>
              </label>
            </div>

            {inspection.baseModelHint ? (
              <div className="mt-4 rounded-xl border border-cyan-400/15 bg-cyan-950/10 px-4 py-3 text-xs text-cyan-100">
                Publisher base-model hint: {inspection.baseModelHint}
              </div>
            ) : null}
            {civitaiSource ? (
              <div className="mt-4 rounded-xl border border-violet-400/15 bg-violet-950/10 px-4 py-3 text-xs leading-5 text-violet-100">
                Downloaded from Civitai: {civitaiSource.modelName} · {civitaiSource.versionName}
                {civitaiSource.baseModel ? ` · publisher base ${civitaiSource.baseModel}` : ""}.
                The tensor inspection above remains authoritative for the file type; confirm the exact checkpoint family and publisher terms before copying it into the managed library.
              </div>
            ) : null}
            <ul className="mt-4 space-y-2 text-[10px] leading-4 text-slate-500">
              {inspection.warnings.map((warning) => <li key={warning} className="flex gap-2"><Shield className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-300/70" />{warning}</li>)}
            </ul>
            {error ? <div role="alert" className="mt-4 rounded-xl border border-rose-400/20 bg-rose-950/20 px-4 py-3 text-xs text-rose-200">{error}</div> : null}
            {result ? (
              <div role="status" className="mt-4 rounded-xl border border-emerald-400/20 bg-emerald-950/20 px-4 py-3 text-xs text-emerald-200">
                {result.alreadyInstalled ? "This exact add-on was already installed." : "Add-on imported and verified."} {formatFileBytes(result.byteSize)} · sha256 {compactDigest(result.digest)}
              </div>
            ) : inspection.canImport ? (
              <label className="mt-4 flex cursor-pointer items-start gap-3 rounded-xl border border-violet-400/15 bg-violet-950/10 p-4 text-xs leading-5 text-slate-300">
                <input type="checkbox" checked={confirmRights} onChange={(event) => setConfirmRights(event.currentTarget.checked)} className="mt-0.5 h-4 w-4 accent-violet-500" />
                I reviewed the publisher&apos;s license, have the right to use these weights, and confirmed the selected base architecture.
              </label>
            ) : null}
          </div>

          <DialogFooter className="border-t border-slate-800 px-6 py-4">
            {!result && kind ? (
              <Button type="button" disabled={!canSubmit} onClick={() => onImport({
                sourcePath: inspection.sourcePath,
                reviewToken: inspection.reviewToken,
                displayName: displayName.trim(),
                kind,
                architecture,
                triggerWords: triggerWords.split(",").map((word) => word.trim()).filter(Boolean),
                token: kind === "textual-inversion" ? token.trim() : null,
                sourceUrl: sourceUrl.trim() || null,
                licenseName: licenseName.trim(),
                commercialUse,
                confirmRights,
              })} className="bg-violet-500 text-white hover:bg-violet-400">
                {loading ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                Copy and verify add-on
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      ) : null}
    </Dialog>
  );
};

const ModelAddonRemovalDialog = ({
  plan,
  result,
  loading,
  error,
  onConfirm,
  onDismiss,
}: {
  plan: MediaModelAddonRemovalPlan | null;
  result: MediaModelAddonRemovalResult | null;
  loading: boolean;
  error: string | null;
  onConfirm: (request: RemoveMediaModelAddonRequest) => void;
  onDismiss: () => void;
}): JSX.Element => {
  const [confirmed, setConfirmed] = useState(false);
  useEffect(() => setConfirmed(false), [plan?.confirmationToken]);

  return (
    <Dialog open={plan !== null} onOpenChange={(open) => !open && onDismiss()}>
      {plan ? (
        <DialogContent className="w-[min(660px,calc(100vw-32px))] max-w-none gap-0 overflow-hidden border-rose-400/20 bg-slate-950 p-0 text-slate-100 sm:max-w-none">
          <DialogHeader className="border-b border-slate-800 px-6 py-5 pr-12 text-left">
            <div className="flex items-center gap-2 text-[10px] font-semibold tracking-[0.14em] text-rose-300 uppercase">
              <Trash2 className="h-3.5 w-3.5" /> Reviewed add-on removal
            </div>
            <DialogTitle className="text-lg text-white">Remove {plan.displayName}</DialogTitle>
            <DialogDescription className="text-xs leading-5 text-slate-500">
              The immutable {plan.kind === "lora" ? "LoRA" : "embedding"} bytes are detached from the managed library. Historical provenance is preserved.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 px-6 py-5">
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-3.5">
                <div className="text-[9px] tracking-wider text-slate-600 uppercase">Installed</div>
                <div className="mt-1.5 text-sm font-semibold text-slate-200">{formatFileBytes(plan.installedBytes)}</div>
              </div>
              <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-3.5">
                <div className="text-[9px] tracking-wider text-slate-600 uppercase">Saved flows</div>
                <div className="mt-1.5 text-sm font-semibold text-slate-200">{plan.savedFlowCount}</div>
              </div>
              <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-3.5">
                <div className="text-[9px] tracking-wider text-slate-600 uppercase">Historical runs</div>
                <div className="mt-1.5 text-sm font-semibold text-slate-200">{plan.historicalRunCount}</div>
              </div>
            </div>
            <div className="rounded-xl border border-slate-800 bg-slate-900/25 px-4 py-3 font-mono text-[10px] break-all text-slate-500">
              {plan.targetLabel} · sha256 {compactDigest(plan.digest)}
            </div>
            <ul className="space-y-2 text-[11px] leading-5 text-amber-100/70">
              {plan.warnings.map((warning) => (
                <li key={warning} className="flex gap-2">
                  <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  {warning}
                </li>
              ))}
            </ul>
            {!plan.canRemove ? (
              <div role="alert" className="rounded-xl border border-amber-400/20 bg-amber-950/20 px-4 py-3 text-xs leading-5 text-amber-200">
                {plan.blockingRunCount} active run(s) still reference this add-on. Finish or cancel them before removing it.
              </div>
            ) : null}
            {error ? (
              <div role="alert" className="rounded-xl border border-rose-400/20 bg-rose-950/20 px-4 py-3 text-xs text-rose-200">{error}</div>
            ) : null}
            {result ? (
              <div role="status" className="rounded-xl border border-emerald-400/20 bg-emerald-950/20 px-4 py-3 text-xs leading-5 text-emerald-200">
                Add-on removed. {result.cleanupPending
                  ? "Byte cleanup will resume on next startup."
                  : `${formatFileBytes(result.reclaimedBytes)} reclaimed.`}
              </div>
            ) : plan.canRemove ? (
              <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-rose-400/15 bg-rose-950/10 p-4 text-xs leading-5 text-slate-300">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(event) => setConfirmed(event.currentTarget.checked)}
                  className="mt-0.5 h-4 w-4 accent-rose-500"
                />
                I understand saved flows keep this exact add-on reference and will fail preflight until the same digest is imported again.
              </label>
            ) : null}
          </div>
          <DialogFooter className="border-t border-slate-800 px-6 py-4">
            {!result ? (
              <Button
                type="button"
                disabled={!plan.canRemove || !confirmed || loading}
                onClick={() => onConfirm({
                  addonId: plan.addonId,
                  confirmationToken: plan.confirmationToken,
                  confirmRemoval: true,
                })}
                className="bg-rose-500 text-white hover:bg-rose-400"
              >
                {loading ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                Remove add-on
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      ) : null}
    </Dialog>
  );
};

const ModelRemovalDialog = ({
  plan,
  result,
  loading,
  error,
  onConfirm,
  onDismiss,
}: {
  plan: MediaModelRemovalPlan | null;
  result: MediaModelRemovalResult | null;
  loading: boolean;
  error: string | null;
  onConfirm: (request: RemoveMediaModelRequest) => void;
  onDismiss: () => void;
}): JSX.Element => {
  const [confirmed, setConfirmed] = useState(false);
  useEffect(() => setConfirmed(false), [plan?.confirmationToken]);

  return (
    <Dialog open={plan !== null} onOpenChange={(open) => !open && onDismiss()}>
      {plan ? (
        <DialogContent className="w-[min(620px,calc(100vw-32px))] max-w-none gap-0 overflow-hidden border-rose-400/20 bg-slate-950 p-0 text-slate-100 sm:max-w-none">
          <DialogHeader className="border-b border-slate-800 px-6 py-5 pr-12 text-left">
            <div className="flex items-center gap-2 text-[10px] font-semibold tracking-[0.14em] text-rose-300 uppercase">
              <Trash2 className="h-3.5 w-3.5" /> Reviewed destructive action
            </div>
            <DialogTitle className="text-lg text-white">
              Remove {plan.displayName}
            </DialogTitle>
            <DialogDescription className="text-xs leading-5 text-slate-500">
              The active revision is detached atomically before its bytes are cleaned from the managed model store.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 px-6 py-5">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-4">
                <div className="text-[9px] tracking-wider text-slate-600 uppercase">Revision</div>
                <div className="mt-1.5 break-all font-mono text-[10px] text-slate-300">{plan.revision}</div>
              </div>
              <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-4">
                <div className="text-[9px] tracking-wider text-slate-600 uppercase">Installed bytes</div>
                <div className="mt-1.5 text-sm font-semibold text-slate-200">{formatBytes(plan.installedBytes)}</div>
              </div>
            </div>
            <div className="rounded-xl border border-slate-800 bg-slate-900/25 px-4 py-3 font-mono text-[10px] break-all text-slate-500">
              {plan.targetLabel}
            </div>
            <ul className="space-y-2 text-[11px] leading-5 text-amber-100/70">
              {plan.warnings.map((warning) => (
                <li key={warning} className="flex gap-2">
                  <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  {warning}
                </li>
              ))}
            </ul>
            {!plan.canRemove ? (
              <div role="alert" className="rounded-xl border border-amber-400/20 bg-amber-950/20 px-4 py-3 text-xs text-amber-200">
                Finish or cancel installation job <span className="font-mono">{plan.blockingJobId}</span> first.
              </div>
            ) : null}
            {error ? (
              <div role="alert" className="rounded-xl border border-rose-400/20 bg-rose-950/20 px-4 py-3 text-xs text-rose-200">{error}</div>
            ) : null}
            {result ? (
              <div role="status" className="rounded-xl border border-emerald-400/20 bg-emerald-950/20 px-4 py-3 text-xs leading-5 text-emerald-200">
                Revision removed. {result.cleanupPending
                  ? "Byte cleanup will resume on next startup."
                  : `${formatBytes(result.reclaimedBytes)} reclaimed.`}
              </div>
            ) : (
              <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-rose-400/15 bg-rose-950/10 p-4 text-xs leading-5 text-slate-300">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(event) => setConfirmed(event.currentTarget.checked)}
                  className="mt-0.5 h-4 w-4 accent-rose-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400/60"
                />
                I understand saved flows will be blocked until this exact local model revision is installed again.
              </label>
            )}
          </div>
          <DialogFooter className="border-t border-slate-800 px-6 py-4">
            {!result ? (
              <Button
                type="button"
                disabled={loading || !confirmed || !plan.canRemove}
                onClick={() =>
                  onConfirm({
                    modelId: plan.modelId,
                    confirmationToken: plan.confirmationToken,
                    confirmRemoval: confirmed,
                  })
                }
                className="bg-rose-600 text-white hover:bg-rose-500"
              >
                {loading ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                Remove installed revision
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      ) : null}
    </Dialog>
  );
};

const CatalogInspection = ({
  catalog,
  loading,
  error,
  onRefresh,
}: {
  catalog: MediaModelCatalogSnapshot;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
}): JSX.Element => (
  <section
    aria-labelledby="media-catalog-heading"
    className="mt-6 rounded-2xl border border-slate-800 bg-slate-900/25 p-5"
  >
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div>
        <h2
          id="media-catalog-heading"
          className="flex items-center gap-2 text-sm font-semibold text-slate-100"
        >
          <Database className="h-4 w-4 text-violet-300" /> Durable catalog snapshot
        </h2>
        <p className="mt-1 text-xs leading-5 text-slate-500">
          Capability and lifecycle data is versioned independently from saved flows.
        </p>
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={loading}
        onClick={onRefresh}
        className="border-slate-800 bg-slate-950/40 text-slate-400 hover:bg-slate-900"
      >
        {loading ? (
          <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <RefreshCw className="h-3.5 w-3.5" />
        )}
        Refresh catalog
      </Button>
    </div>

    {error ? (
      <div className="mt-4 rounded-xl border border-rose-500/20 bg-rose-500/8 px-4 py-3 text-xs text-rose-200">
        Catalog refresh failed. The last valid built-in snapshot remains active. {error}
      </div>
    ) : null}

    <div className="mt-5 grid gap-3 sm:grid-cols-3">
      <div className="rounded-xl border border-slate-800/70 bg-slate-950/45 p-3.5">
        <div className="text-[10px] font-semibold tracking-[0.12em] text-slate-600 uppercase">
          Revision
        </div>
        <div className="mt-2 truncate font-mono text-[11px] text-violet-200">
          {catalog.catalogRevision}
        </div>
      </div>
      <div className="rounded-xl border border-slate-800/70 bg-slate-950/45 p-3.5">
        <div className="text-[10px] font-semibold tracking-[0.12em] text-slate-600 uppercase">
          Inventory
        </div>
        <div className="mt-2 text-[11px] text-slate-300">
          {catalog.providers.length} providers · {catalog.models.length} models
        </div>
      </div>
      <div className="rounded-xl border border-slate-800/70 bg-slate-950/45 p-3.5">
        <div className="text-[10px] font-semibold tracking-[0.12em] text-slate-600 uppercase">
          Observed
        </div>
        <div className="mt-2 text-[11px] text-slate-300">
          {formatObservedAt(catalog.observedAt)}
        </div>
      </div>
    </div>

    <div className="mt-3 flex flex-wrap gap-2">
      {catalog.providers.map((provider) => (
        <div
          key={provider.id}
          className="flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-950/35 px-3 py-2 text-[10px]"
        >
          <span className="text-slate-300">{provider.displayName}</span>
          <span
            className={provider.configured ? "text-emerald-300" : "text-amber-300"}
          >
            {provider.configured ? "ready" : "configuration required"}
          </span>
          {provider.lifecycle !== "active" && provider.lifecycle !== "preview" ? (
            <span className="text-slate-700">{provider.lifecycle}</span>
          ) : null}
        </div>
      ))}
    </div>
  </section>
);

const getPythonRequirementState = (
  pythonVersion: string | null,
): RuntimeRequirementState => {
  if (pythonVersion === null) return "missing";
  const [majorText, minorText] = pythonVersion.split(".");
  const major = Number.parseInt(majorText ?? "", 10);
  const minor = Number.parseInt(minorText ?? "", 10);
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return "unknown";
  return major > 3 || (major === 3 && minor >= 10) ? "ready" : "mismatch";
};

const getPackageRequirementState = (
  observedVersion: string | null | undefined,
  expectedVersion: string,
  runtimeReady: boolean,
): RuntimeRequirementState => {
  if (observedVersion === null) return "missing";
  if (observedVersion === undefined) return runtimeReady ? "unknown" : "missing";
  return observedVersion === expectedVersion ? "ready" : "mismatch";
};

const RuntimeRequirementBadge = ({
  state,
  observedVersion,
}: {
  state: RuntimeRequirementState;
  observedVersion: string | null | undefined;
}): JSX.Element => {
  const label = state === "ready"
    ? `Installed ${observedVersion ?? ""}`.trim()
    : state === "missing"
      ? "Not detected"
      : state === "mismatch"
        ? `Installed ${observedVersion ?? "unknown"}`
        : "Not reported";

  return (
    <span
      className={cn(
        "rounded-full border px-2 py-0.5 text-[9px] font-medium",
        state === "ready"
          ? "border-emerald-400/20 bg-emerald-950/20 text-emerald-300"
          : state === "unknown"
            ? "border-slate-700 bg-slate-900/40 text-slate-500"
            : "border-amber-400/25 bg-amber-950/25 text-amber-200",
      )}
    >
      {label}
    </span>
  );
};

const LocalDiffusersRequirements = ({
  runtime,
  onOpenInstallGuide,
}: {
  runtime: MediaLocalDiffusersRuntimeStatus;
  onOpenInstallGuide: () => void;
}): JSX.Element => {
  const pythonState = getPythonRequirementState(runtime.pythonVersion);

  return (
    <section
      aria-labelledby="local-diffusers-requirements-heading"
      className={cn(
        "mt-2 rounded-2xl border p-5",
        runtime.ready
          ? "border-emerald-400/15 bg-emerald-950/10"
          : "border-amber-400/25 bg-amber-950/15",
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2
            id="local-diffusers-requirements-heading"
            className="flex items-center gap-2 text-sm font-semibold text-slate-100"
          >
            {runtime.ready ? (
              <FileCheck2 className="h-4 w-4 text-emerald-300" />
            ) : (
              <TriangleAlert className="h-4 w-4 text-amber-300" />
            )}
            Local Diffusers requirements
          </h2>
          <p className="mt-1 max-w-3xl text-xs leading-5 text-slate-500">
            {runtime.diagnostic}
          </p>
          {runtime.deviceLabel ? (
            <p className="mt-1 text-[10px] text-slate-600">
              Execution device: <span className="text-slate-400">{runtime.deviceLabel}</span>
            </p>
          ) : null}
        </div>
        <Badge
          variant="outline"
          className={runtime.ready
            ? "border-emerald-400/25 text-emerald-300"
            : "border-amber-400/25 text-amber-300"}
        >
          {runtime.ready ? "Ready" : "Action required"}
        </Badge>
      </div>

      <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-xl border border-slate-800/70 bg-slate-950/40 p-3">
          <div className="flex items-start justify-between gap-2">
            <div>
              <div className="text-[11px] font-semibold text-slate-300">Python</div>
              <div className="mt-0.5 text-[9px] text-slate-600">
                Required {LOCAL_DIFFUSERS_PYTHON_REQUIREMENT}
              </div>
            </div>
            <RuntimeRequirementBadge
              state={pythonState}
              observedVersion={runtime.pythonVersion}
            />
          </div>
        </div>
        {LOCAL_DIFFUSERS_PACKAGE_REQUIREMENTS.map((requirement) => {
          const observedVersion = runtime.packages[requirement.id];
          const state = getPackageRequirementState(
            observedVersion,
            requirement.version,
            runtime.ready,
          );
          return (
            <div
              key={requirement.id}
              className="rounded-xl border border-slate-800/70 bg-slate-950/40 p-3"
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="text-[11px] font-semibold text-slate-300">
                    {requirement.name}
                  </div>
                  <div className="mt-0.5 text-[9px] text-slate-600">
                    Required {requirement.version}
                  </div>
                </div>
                <RuntimeRequirementBadge
                  state={state}
                  observedVersion={observedVersion}
                />
              </div>
            </div>
          );
        })}
      </div>

      {!runtime.ready ? (
        <div className="mt-4 flex flex-wrap gap-2 border-t border-amber-400/15 pt-4">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onOpenInstallGuide}
            className="border-amber-400/25 bg-amber-950/20 text-amber-100 hover:bg-amber-950/40"
          >
            <Download className="h-3.5 w-3.5" /> Install guide
          </Button>
          {runtime.pythonVersion === null ? (
            <Button
              asChild
              variant="outline"
              size="sm"
              className="border-slate-700 bg-slate-950/40 text-slate-300 hover:bg-slate-900"
            >
              <a href={PYTHON_DOWNLOAD_URL} target="_blank" rel="noreferrer">
                Download Python <ExternalLink className="h-3.5 w-3.5" />
              </a>
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
};

const LocalDiffusersInstallGuideDialog = ({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): JSX.Element => (
  <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="max-h-[calc(100vh-32px)] w-[min(680px,calc(100vw-32px))] max-w-none overflow-y-auto border-slate-800 bg-slate-950 text-slate-100 sm:max-w-none">
      <DialogHeader className="text-left">
        <DialogTitle className="flex items-center gap-2 text-base text-white">
          <Download className="h-4 w-4 text-amber-300" /> Install Local Diffusers requirements
        </DialogTitle>
        <DialogDescription className="text-xs leading-5 text-slate-500">
          The desktop app checks its bundled Python runtime first, then a supported Python executable on PATH. Install into the runtime machdoch can discover.
        </DialogDescription>
      </DialogHeader>

      <ol className="space-y-4 text-xs leading-5 text-slate-300">
        <li className="rounded-xl border border-slate-800 bg-slate-900/30 p-4">
          <div className="font-semibold text-slate-100">1. Install Python {LOCAL_DIFFUSERS_PYTHON_REQUIREMENT}</div>
          <p className="mt-1 text-slate-500">
            Ensure <code className="font-mono text-slate-300">python</code> or <code className="font-mono text-slate-300">python3</code> is available on PATH.
          </p>
          <a
            href={PYTHON_DOWNLOAD_URL}
            target="_blank"
            rel="noreferrer"
            className="mt-2 inline-flex items-center gap-1 font-medium text-cyan-300 hover:text-cyan-200"
          >
            Open official Python downloads <ExternalLink className="h-3 w-3" />
          </a>
        </li>
        <li className="rounded-xl border border-slate-800 bg-slate-900/30 p-4">
          <div className="font-semibold text-slate-100">2. Install PyTorch 2.13.0 for your hardware</div>
          <p className="mt-1 text-slate-500">
            PyTorch wheels depend on the operating system and CPU, CUDA, or ROCm target. Use the official installation command for version 2.13.0.
          </p>
          <a
            href={PYTORCH_INSTALL_URL}
            target="_blank"
            rel="noreferrer"
            className="mt-2 inline-flex items-center gap-1 font-medium text-cyan-300 hover:text-cyan-200"
          >
            Open PyTorch install options <ExternalLink className="h-3 w-3" />
          </a>
        </li>
        <li className="rounded-xl border border-slate-800 bg-slate-900/30 p-4">
          <div className="font-semibold text-slate-100">3. Install the remaining pinned packages</div>
          <p className="mt-1 text-slate-500">
            Run this with the same Python command. Use <code className="font-mono text-slate-300">python3</code> instead when required by your system.
          </p>
          <code className="mt-3 block overflow-x-auto rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 font-mono text-[10px] leading-5 text-slate-300 select-all">
            {LOCAL_DIFFUSERS_PACKAGE_INSTALL_COMMAND}
          </code>
        </li>
      </ol>

      <p className="text-[10px] leading-4 text-slate-600">
        Restart the desktop app after installation so the isolated worker can run its readiness probe again.
      </p>
      <DialogFooter>
        <Button type="button" onClick={() => onOpenChange(false)}>
          Done
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
);

const ProbeBadge = ({ probe }: { probe: MediaToolProbe }): JSX.Element => (
  <Badge
    variant="outline"
    className={cn(
      "capitalize",
      probe.status === "available"
        ? "border-emerald-400/25 text-emerald-300"
        : probe.status === "timed-out"
          ? "border-amber-400/25 text-amber-300"
          : "border-slate-700 text-slate-500",
    )}
  >
    {probe.status}
  </Badge>
);

const HardwareInspection = ({
  hardware,
  loading,
  error,
  onRefresh,
}: {
  hardware: MediaHardwareInspection | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
}): JSX.Element => (
  <section
    aria-labelledby="media-hardware-heading"
    className="mt-6 rounded-2xl border border-slate-800 bg-slate-900/25 p-5"
  >
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div>
        <h2
          id="media-hardware-heading"
          className="flex items-center gap-2 text-sm font-semibold text-slate-100"
        >
          <ServerCog className="h-4 w-4 text-cyan-300" /> Local runtime inspection
        </h2>
        <p className="mt-1 text-xs leading-5 text-slate-500">
          Executable and driver visibility is reported separately from validated model compatibility.
        </p>
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={loading}
        onClick={onRefresh}
        className="border-slate-800 bg-slate-950/40 text-slate-400 hover:bg-slate-900"
      >
        {loading ? (
          <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <RefreshCw className="h-3.5 w-3.5" />
        )}
        Re-run probes
      </Button>
    </div>

    {error ? (
      <div className="mt-4 rounded-xl border border-rose-500/20 bg-rose-500/8 px-4 py-3 text-xs text-rose-200">
        {error}
      </div>
    ) : null}

    {hardware ? (
      <>
        <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <div className="rounded-xl border border-slate-800/70 bg-slate-950/45 p-3.5">
            <Cpu className="h-4 w-4 text-cyan-300" />
            <div className="mt-3 text-[10px] font-semibold tracking-[0.12em] text-slate-600 uppercase">
              CPU
            </div>
            <div className="mt-1 line-clamp-2 text-xs leading-5 text-slate-300">
              {hardware.cpuLabel}
            </div>
            <div className="mt-1 text-[10px] text-slate-600">
              {hardware.logicalCpuCount} logical · {hardware.architecture}
            </div>
          </div>
          <div className="rounded-xl border border-slate-800/70 bg-slate-950/45 p-3.5">
            <MemoryStick className="h-4 w-4 text-violet-300" />
            <div className="mt-3 text-[10px] font-semibold tracking-[0.12em] text-slate-600 uppercase">
              Memory
            </div>
            <div className="mt-1 text-xs text-slate-300">
              {formatBytesWithSuffix(hardware.availableMemoryBytes, "available")}
            </div>
            <div className="mt-1 text-[10px] text-slate-600">
              {formatBytesWithSuffix(hardware.totalMemoryBytes, "total")}
            </div>
          </div>
          <div className="rounded-xl border border-slate-800/70 bg-slate-950/45 p-3.5">
            <HardDrive className="h-4 w-4 text-emerald-300" />
            <div className="mt-3 text-[10px] font-semibold tracking-[0.12em] text-slate-600 uppercase">
              Media storage
            </div>
            <div className="mt-1 text-xs text-slate-300">
              {formatBytesWithSuffix(hardware.storageFreeBytes, "free")}
            </div>
            <div className="mt-1 text-[10px] text-slate-600">
              SQLite WAL + sharded CAS
            </div>
          </div>
          <div className="rounded-xl border border-slate-800/70 bg-slate-950/45 p-3.5">
            <Gauge className="h-4 w-4 text-amber-300" />
            <div className="mt-3 text-[10px] font-semibold tracking-[0.12em] text-slate-600 uppercase">
              Utility runtime
            </div>
            <div className="mt-1 text-xs text-slate-300">
              CPU: {hardware.runtimeSupport.cpuUtilities.replaceAll("-", " ")}
            </div>
            <div className="mt-1 text-[10px] text-slate-600">
              {hardware.operatingSystem}
            </div>
          </div>
        </div>

        <div className="mt-3 grid gap-3 lg:grid-cols-2">
          <div className="rounded-xl border border-slate-800/70 bg-slate-950/35 p-4">
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs font-semibold text-slate-300">FFmpeg toolchain</span>
              <ProbeBadge probe={hardware.ffmpeg} />
            </div>
            <p className="mt-2 line-clamp-2 text-[10px] leading-4 text-slate-600">
              {hardware.ffmpeg.version ?? hardware.ffmpeg.diagnostic}
            </p>
            <div className="mt-3 flex items-center justify-between gap-3 border-t border-slate-800/70 pt-3">
              <span className="text-[10px] font-semibold text-slate-500">ffprobe verification</span>
              <ProbeBadge probe={hardware.ffprobe} />
            </div>
            <p className="mt-2 line-clamp-2 text-[10px] leading-4 text-slate-600">
              {hardware.ffprobe.version ?? hardware.ffprobe.diagnostic}
            </p>
            {hardware.ffmpeg.status !== "available" || hardware.ffprobe.status !== "available" ? (
              <Button
                asChild
                variant="outline"
                size="xs"
                className="mt-3 w-full border-cyan-400/25 bg-cyan-950/10 text-cyan-200 hover:bg-cyan-950/30"
              >
                <a href={FFMPEG_DOWNLOAD_URL} target="_blank" rel="noreferrer">
                  Download FFmpeg <ExternalLink className="h-3 w-3" />
                </a>
              </Button>
            ) : null}
          </div>
          <div className="rounded-xl border border-slate-800/70 bg-slate-950/35 p-4">
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs font-semibold text-slate-300">NVIDIA driver probe</span>
              <ProbeBadge probe={hardware.nvidiaSmi} />
            </div>
            {hardware.nvidiaGpus.length > 0 ? (
              <div className="mt-2 space-y-1 text-[10px] text-slate-500">
                {hardware.nvidiaGpus.map((gpu, index) => (
                  <div key={`${gpu.name}-${index}`}>
                    {gpu.name} · {gpu.memoryTotalMb === null ? "VRAM unknown" : `${Math.round(gpu.memoryTotalMb / 1_024)} GB VRAM`} · driver {gpu.driverVersion}
                  </div>
                ))}
              </div>
            ) : (
              <p className="mt-2 text-[10px] leading-4 text-slate-600">
                {hardware.nvidiaSmi.diagnostic}
              </p>
            )}
          </div>
        </div>

      </>
    ) : loading ? (
      <div className="mt-5 flex h-28 items-center justify-center text-xs text-slate-600">
        <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> Inspecting local runtime…
      </div>
    ) : null}
  </section>
);

export const MediaModelsView = ({
  catalog,
  catalogLoading,
  catalogError,
  hardware,
  hardwareLoading,
  hardwareError,
  installPlan,
  installJob,
  installLoading,
  installError,
  removalPlan,
  removalResult,
  removalLoading,
  removalError,
  modelImportInspection,
  modelImportResult,
  modelImportSupported,
  modelImportLoading,
  modelImportError,
  modelProbeSupported,
  modelProbeLoadingId,
  modelProbeError,
  addonImportInspection,
  addonImportResult,
  addonImportSupported,
  addonImportLoading,
  addonImportError,
  civitaiAddonInspection,
  addonImportCivitaiSource,
  civitaiAddonLoading,
  civitaiAddonError,
  addonRemovalPlan,
  addonRemovalResult,
  addonRemovalLoading,
  addonRemovalError,
  localDiffusers,
  onRefreshHardware,
  onRefreshCatalog,
  onReviewInstall,
  onStartInstall,
  onCancelInstall,
  onDismissInstall,
  onReviewRemoval,
  onConfirmRemoval,
  onDismissRemoval,
  onChooseModelImport,
  onImportModel,
  onDismissModelImport,
  onProbeModel,
  onChooseAddonImport,
  onInspectCivitaiAddon,
  onDownloadCivitaiAddon,
  onDismissCivitaiAddon,
  onReviewAddonRemoval,
  onConfirmAddonRemoval,
  onDismissAddonRemoval,
  onImportAddon,
  onDismissAddonImport,
  onOpenProviderSettings,
}: MediaModelsViewProps): JSX.Element => {
  const [civitaiDialogOpen, setCivitaiDialogOpen] = useState(false);
  const [localDiffusersGuideOpen, setLocalDiffusersGuideOpen] = useState(false);
  useEffect(() => {
    if (addonImportInspection) setCivitaiDialogOpen(false);
  }, [addonImportInspection?.reviewToken]);

  const modelGroups = MEDIA_MODEL_PURPOSE_GROUPS.map((group) => ({
    ...group,
    models: catalog.models.filter(
      (model) => getMediaModelPurpose(model) === group.id,
    ),
  })).filter((group) => group.models.length > 0);

  return (
    <div className="h-full overflow-y-auto bg-slate-950 px-5 py-6 sm:px-7 sm:py-7">
      <ModelInstallDialog
        plan={installPlan}
        job={installJob}
        loading={installLoading}
        error={installError}
        onStart={onStartInstall}
        onCancel={onCancelInstall}
        onDismiss={onDismissInstall}
      />
      <ModelRemovalDialog
        plan={removalPlan}
        result={removalResult}
        loading={removalLoading}
        error={removalError}
        onConfirm={onConfirmRemoval}
        onDismiss={onDismissRemoval}
      />
      <ModelAddonRemovalDialog
        plan={addonRemovalPlan}
        result={addonRemovalResult}
        loading={addonRemovalLoading}
        error={addonRemovalError}
        onConfirm={onConfirmAddonRemoval}
        onDismiss={onDismissAddonRemoval}
      />
      <ModelImportDialog
        inspection={modelImportInspection}
        result={modelImportResult}
        loading={modelImportLoading}
        error={modelImportError}
        onImport={onImportModel}
        onDismiss={onDismissModelImport}
      />
      <ModelAddonImportDialog
        inspection={addonImportInspection}
        civitaiSource={addonImportCivitaiSource}
        result={addonImportResult}
        loading={addonImportLoading}
        error={addonImportError}
        onImport={onImportAddon}
        onDismiss={onDismissAddonImport}
      />
      <CivitaiAddonImportDialog
        open={civitaiDialogOpen}
        inspection={civitaiAddonInspection}
        loading={civitaiAddonLoading}
        error={civitaiAddonError}
        onInspect={onInspectCivitaiAddon}
        onDownload={onDownloadCivitaiAddon}
        onDismiss={() => {
          setCivitaiDialogOpen(false);
          onDismissCivitaiAddon();
        }}
      />
      <LocalDiffusersInstallGuideDialog
        open={localDiffusersGuideOpen}
        onOpenChange={setLocalDiffusersGuideOpen}
      />
      <div className="mx-auto max-w-6xl">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="flex items-center gap-2 text-sm font-semibold text-slate-100">
            <Gauge className="h-4 w-4 text-violet-300" /> Models
          </h1>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={!addonImportSupported || civitaiAddonLoading}
              title={addonImportSupported ? undefined : "Available in the native desktop app"}
              onClick={() => setCivitaiDialogOpen(true)}
              className="border-cyan-400/25 bg-cyan-950/10 text-cyan-200 hover:bg-cyan-950/30"
            >
              {civitaiAddonLoading ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Cloud className="h-4 w-4" />}
              Import from Civitai
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={!addonImportSupported || addonImportLoading}
              title={addonImportSupported ? undefined : "Available in the native desktop app"}
              onClick={onChooseAddonImport}
              className="border-cyan-400/25 bg-cyan-950/10 text-cyan-200 hover:bg-cyan-950/30"
            >
              {addonImportLoading ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Layers3 className="h-4 w-4" />}
              Import LoRA / embedding
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={!modelImportSupported || modelImportLoading}
              title={modelImportSupported ? undefined : "Available in the native desktop app"}
              onClick={onChooseModelImport}
              className="border-violet-400/25 bg-violet-950/10 text-violet-200 hover:bg-violet-950/30"
            >
              {modelImportLoading ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
              Import checkpoint
            </Button>
          </div>
        </div>

        {modelImportError && !modelImportInspection ? (
          <div role="alert" className="mt-4 rounded-xl border border-rose-400/20 bg-rose-950/20 px-4 py-3 text-xs leading-5 text-rose-200">
            {modelImportError}
          </div>
        ) : null}
        {addonImportError && !addonImportInspection ? (
          <div role="alert" className="mt-4 rounded-xl border border-rose-400/20 bg-rose-950/20 px-4 py-3 text-xs leading-5 text-rose-200">
            {addonImportError}
          </div>
        ) : null}
        {addonRemovalError && !addonRemovalPlan ? (
          <div role="alert" className="mt-4 rounded-xl border border-rose-400/20 bg-rose-950/20 px-4 py-3 text-xs leading-5 text-rose-200">
            {addonRemovalError}
          </div>
        ) : null}
        {modelProbeError ? (
          <div role="alert" className="mt-4 rounded-xl border border-rose-400/20 bg-rose-950/20 px-4 py-3 text-xs leading-5 text-rose-200">
            {modelProbeError}
          </div>
        ) : null}

        <details
          className={cn(
            "group mt-5 border-y",
            localDiffusers?.ready === false
              ? "border-amber-400/30 bg-amber-950/10"
              : "border-slate-800/70",
          )}
        >
          <summary
            className={cn(
              "flex cursor-pointer list-none items-center gap-2 px-1 py-3 text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-violet-400/40",
              localDiffusers?.ready === false
                ? "text-amber-200 hover:text-amber-100"
                : "text-slate-400 hover:text-slate-200",
            )}
          >
            {localDiffusers?.ready === false ? (
              <TriangleAlert className="h-4 w-4 shrink-0 text-amber-300" aria-hidden="true" />
            ) : null}
            <span>System details</span>
            {localDiffusers?.ready === false ? (
              <span className="rounded-full border border-amber-400/20 bg-amber-950/30 px-2 py-0.5 text-[9px] font-semibold text-amber-300">
                Action required
              </span>
            ) : null}
            <span className="text-slate-600">
              {catalog.providers.length} providers · {catalog.models.length} models
            </span>
            <ChevronDown className="ml-auto h-4 w-4 text-slate-600 transition-transform group-open:rotate-180" />
          </summary>
          <div className="pb-6">
            {localDiffusers ? (
              <LocalDiffusersRequirements
                runtime={localDiffusers}
                onOpenInstallGuide={() => setLocalDiffusersGuideOpen(true)}
              />
            ) : null}

            <CatalogInspection
              catalog={catalog}
              loading={catalogLoading}
              error={catalogError}
              onRefresh={onRefreshCatalog}
            />

            <HardwareInspection
              hardware={hardware}
              loading={hardwareLoading}
              error={hardwareError}
              onRefresh={onRefreshHardware}
            />
          </div>
        </details>

        <section aria-labelledby="media-addons-heading" className="mt-5 rounded-xl border border-slate-800 bg-slate-900/20 p-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 id="media-addons-heading" className="flex items-center gap-2 text-sm font-semibold text-slate-100">
                <Layers3 className="h-4 w-4 text-cyan-300" /> Looks &amp; concepts
              </h2>
              <p className="mt-1 text-[11px] leading-5 text-slate-500">
                Reusable LoRA adapters and textual-inversion embeddings. Compatibility is checked against the chosen provider and model before a run.
              </p>
            </div>
            <Badge variant="outline" className="border-cyan-400/20 text-[9px] text-cyan-300">{catalog.addons.length}</Badge>
          </div>
          {catalog.addons.length === 0 ? (
            <div className="mt-4 rounded-lg border border-dashed border-slate-800 px-4 py-5 text-center text-[11px] text-slate-600">
              No LoRAs or embeddings imported yet.
            </div>
          ) : (
            <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {catalog.addons.map((addon) => (
                <article key={addon.id} className="rounded-lg border border-slate-800 bg-slate-950/35 p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <h3 className="truncate text-xs font-semibold text-slate-200">{addon.displayName}</h3>
                      <p className="mt-1 text-[9px] text-slate-600">{addon.architecture.replaceAll("-", " ")} · {formatFileBytes(addon.byteSize)}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <Badge variant="outline" className="border-violet-400/20 text-[8px] text-violet-300">
                        {addon.kind === "lora" ? "LoRA" : "Embedding"}
                      </Badge>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        disabled={addonRemovalLoading}
                        aria-label={`Remove ${addon.displayName}`}
                        onClick={() => onReviewAddonRemoval(addon.id)}
                        className="h-7 w-7 text-slate-600 hover:bg-rose-950/30 hover:text-rose-300"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                  <p className="mt-2 text-[9px] text-slate-500">
                    {addon.targetComponents.map((component) => component.replaceAll("-", " ")).join(" · ")}
                  </p>
                  {addon.embeddingVectors.length > 0 ? (
                    <p className="mt-1 text-[9px] text-violet-300/70">
                      {addon.embeddingVectors.map((profile) => `${profile.vectorCount}×${profile.dimension}`).join(" · ")}
                    </p>
                  ) : null}
                  {addon.loraProfile ? (
                    <p className="mt-1 text-[9px] text-cyan-300/70">
                      {addon.loraProfile.algorithm === "locon" ? "LoCon" : addon.loraProfile.algorithm === "dora" ? "DoRA" : "LoRA"} · rank {addon.loraProfile.rankMinimum === addon.loraProfile.rankMaximum ? addon.loraProfile.rankMinimum : `${addon.loraProfile.rankMinimum}–${addon.loraProfile.rankMaximum}`} · {addon.loraProfile.targetModuleCount} modules
                    </p>
                  ) : null}
                  {addon.triggerWords.length > 0 ? <p className="mt-2 truncate font-mono text-[9px] text-cyan-300/70">{addon.triggerWords.join(", ")}</p> : null}
                  {addon.defaultToken ? <p className="mt-2 truncate font-mono text-[9px] text-cyan-300/70">{addon.defaultToken}</p> : null}
                </article>
              ))}
            </div>
          )}
        </section>

        <div className="mt-5 space-y-6">
          {modelGroups.map((group) => {
            const GroupIcon = group.icon;

            return (
              <section key={group.id} aria-labelledby={`media-${group.id}-models-heading`}>
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h2
                    id={`media-${group.id}-models-heading`}
                    className="flex items-center gap-2 text-sm font-semibold text-slate-100"
                  >
                    <GroupIcon className={cn("h-4 w-4", group.iconClassName)} />
                    {group.title}
                  </h2>
                  <p className="mt-1 text-[11px] leading-5 text-slate-500">
                    {group.description}
                  </p>
                </div>
                <Badge variant="outline" className="border-slate-700 text-[9px] text-slate-400">
                  {group.models.length}
                </Badge>
              </div>

              <div className="mt-3 grid gap-3 lg:grid-cols-2">
                {group.models.map((model) => {
                  const ready = isReady(model);
                  const TargetIcon = model.target === "remote" ? Cloud : Cpu;
                  const modelInstallJob =
                    installJob?.modelId === model.id ? installJob : null;
                  return (
              <article
                key={model.id}
                className="flex flex-col rounded-xl border border-slate-800 bg-slate-900/25 p-4"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="flex min-w-0 items-start gap-3">
                    <div
                      className={cn(
                        "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg",
                        model.target === "remote"
                          ? "bg-sky-950/50 text-sky-300"
                          : "bg-violet-950/50 text-violet-300",
                      )}
                    >
                      <TargetIcon className="h-4 w-4" />
                    </div>
                    <div className="min-w-0">
                      <h3 className="truncate text-sm font-semibold text-slate-100">
                        {model.displayName}
                      </h3>
                      <div className="mt-1 text-[10px] text-slate-500">
                        {model.target === "remote"
                          ? "Remote"
                          : model.bundled
                            ? "Built in"
                            : model.userImported
                              ? "Imported"
                              : "Local"} · {model.family}
                      </div>
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <span
                      className={cn(
                        "inline-flex items-center gap-1.5 text-[11px]",
                        ready ? "text-emerald-300" : "text-amber-300",
                      )}
                    >
                      <span className="h-1.5 w-1.5 rounded-full bg-current" />
                      {readinessLabel(model)}
                    </span>
                    {model.lifecycle !== "active" && model.lifecycle !== "preview" ? (
                      <span className="text-[9px] text-amber-300">
                        {model.lifecycle.replaceAll("-", " ")}
                      </span>
                    ) : null}
                  </div>
                </div>

                {model.target === "local" &&
                (model.minVramGb != null || model.expectedDownloadGb != null) ? (
                  <dl className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-[11px] text-slate-500">
                    {model.minVramGb != null ? (
                      <div className="flex items-center gap-2 text-slate-500">
                        <HardDrive className="h-3.5 w-3.5" /> {model.minVramGb} GB VRAM
                      </div>
                    ) : null}
                    {model.expectedDownloadGb != null ? (
                      <div className="flex items-center gap-2 text-slate-500">
                        <Download className="h-3.5 w-3.5" /> {model.expectedDownloadGb} GiB download
                      </div>
                    ) : null}
                  </dl>
                ) : null}

                <details className="group/details mt-3 border-t border-slate-800/70 pt-2">
                  <summary className="cursor-pointer list-none text-[10px] text-slate-500 outline-none hover:text-slate-300 focus-visible:ring-2 focus-visible:ring-violet-400/30">
                    Details
                  </summary>
                  <div className="mt-2 space-y-2 text-[10px] leading-4 text-slate-500">
                    <p className="font-mono text-slate-600">{model.id}</p>
                    <p>{model.capabilities.join(" · ")}</p>
                    <p>
                      {model.license.name} · {model.license.commercialUse.replaceAll("-", " ")}
                    </p>
                    <p className="capitalize">
                      {model.installationStatus.replaceAll("-", " ")}
                    </p>
                    {model.runtimeReadinessDiagnostic ? (
                      <p className={model.runtimeReadiness === "failed" ? "text-rose-300/70" : "text-amber-200/60"}>
                        {model.runtimeReadinessDiagnostic}
                      </p>
                    ) : null}
                    {model.limitation ? (
                      <p className="text-amber-200/60">{model.limitation}</p>
                    ) : null}
                  </div>
                </details>

                {model.target === "remote" && !model.configured ? (
                  <div className="mt-auto pt-4">
                    <Button
                      variant="outline"
                      onClick={onOpenProviderSettings}
                      className="w-full border-slate-700 bg-slate-950/40 text-slate-300 hover:bg-slate-900"
                    >
                      Configure provider <ExternalLink className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ) : model.providerId === "local-diffusers" && model.installed && !ready ? (
                  <div className="mt-auto pt-4">
                    <Button
                      type="button"
                      variant="outline"
                      disabled={
                        !modelProbeSupported ||
                        modelProbeLoadingId !== null ||
                        localDiffusers?.ready !== true
                      }
                      title={
                        localDiffusers?.ready === true
                          ? "Load this checkpoint once in the isolated offline worker"
                          : "Install the pinned Local Diffusers runtime before verification"
                      }
                      onClick={() => onProbeModel(model.id)}
                      className="w-full border-violet-400/25 bg-violet-950/10 text-violet-200 hover:bg-violet-950/30"
                    >
                      {modelProbeLoadingId === model.id ? (
                        <LoaderCircle className="h-4 w-4 animate-spin" />
                      ) : (
                        <FileCheck2 className="h-4 w-4" />
                      )}
                      {modelProbeLoadingId === model.id ? "Verifying model…" : "Verify model"}
                    </Button>
                  </div>
                ) : model.target === "local" && model.userImported && !ready ? (
                  <div className="mt-auto pt-4">
                    <Button
                      type="button"
                      variant="outline"
                      disabled={!modelImportSupported || modelImportLoading}
                      onClick={onChooseModelImport}
                      className="w-full border-violet-400/25 bg-violet-950/10 text-violet-200 hover:bg-violet-950/30"
                    >
                      <Upload className="h-4 w-4" /> Import checkpoint again
                    </Button>
                  </div>
                ) : model.target === "local" && !model.bundled && !ready ? (
                  <div className="mt-auto space-y-3 pt-4">
                      {modelInstallJob ? (
                        <div className="rounded-lg border border-violet-400/15 bg-violet-950/10 px-3 py-2.5" aria-live="polite">
                          <div className="flex items-center justify-between gap-3 text-[10px]">
                            <span className="capitalize text-violet-200">{modelInstallJob.status}</span>
                            <span className="font-mono text-violet-300">{Math.round(modelInstallJob.progress * 100)}%</span>
                          </div>
                          <div className="mt-2 h-1 overflow-hidden rounded-full bg-slate-800">
                            <div className="h-full rounded-full bg-violet-400 transition-[width]" style={{ width: `${Math.max(1, modelInstallJob.progress * 100)}%` }} />
                          </div>
                          {modelInstallJob.failure ? (
                            <div className="mt-2 rounded-md border border-rose-300/15 bg-rose-400/5 p-2 text-[9px] leading-4 text-rose-100/75">
                              <span className="font-mono text-[8px] text-rose-200/55">
                                {modelInstallJob.failure.code}
                              </span>
                              <p>{modelInstallJob.failure.message}</p>
                            </div>
                          ) : modelInstallJob.error ? (
                            <p className="mt-2 text-[10px] leading-4 text-rose-200">
                              {modelInstallJob.error}
                            </p>
                          ) : null}
                        </div>
                      ) : null}
                      <Button
                        type="button"
                        variant="outline"
                        disabled={installLoading}
                        onClick={() => onReviewInstall(model.id)}
                        className="w-full border-violet-400/25 bg-violet-950/10 text-violet-200 hover:bg-violet-950/30"
                      >
                        {installLoading ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                        {modelInstallJob ? "Open installation details" : "Review installation"}
                      </Button>
                  </div>
                ) : model.target === "local" && !model.bundled && ready ? (
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={removalLoading}
                    onClick={() => onReviewRemoval(model.id)}
                    className="mt-auto w-full pt-4 text-slate-500 hover:bg-rose-950/20 hover:text-rose-200"
                  >
                    {removalLoading ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                    Review removal
                  </Button>
                ) : null}
              </article>
            );
                })}
              </div>
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
};
