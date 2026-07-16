import {
  AlertTriangle,
  Boxes,
  Crop,
  Download,
  Ellipsis,
  FileJson,
  FileImage,
  FolderOpen,
  Image as ImageIcon,
  LayoutGrid,
  LoaderCircle,
  Maximize2,
  MessageCircle,
  PanelRightOpen,
  Plus,
  ScanSearch,
  Search,
  ShieldCheck,
  Tags,
  Upload,
  WandSparkles,
  X,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useState,
  type JSX,
  type ReactElement,
} from "react";
import { ContextMenu as ContextMenuPrimitive } from "radix-ui";
import type {
  MediaAssetRecord,
  MediaAssetDeletionImpact,
  MediaAssetDeletionMode,
  MediaAssetDeletionRequest,
  MediaAssetDeletionResult,
  MediaAssetExportMode,
  MediaAssetTagUpdate,
  MediaImageOutputFormat,
  MediaImageResizeFit,
  MediaImageTransformOperation,
  MediaImageTransformRequest,
  MediaQualityReport,
  MediaQualityVerdict,
  MediaRuntimeStatus,
} from "../../../../core/media/contracts.js";
import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../../components/ui/popover";
import { cn } from "../../lib/utils";
import { readMediaAssetReferencePreview } from "../media-runtime";

interface MediaLibraryViewProps {
  assets: readonly MediaAssetRecord[];
  runtimeStatus: MediaRuntimeStatus | null;
  runtimeError: string | null;
  importSupported: boolean;
  importLoading: boolean;
  transformLoading: boolean;
  exportSupported: boolean;
  exportLoading: boolean;
  exportNotice: string | null;
  deletionNotice: string | null;
  qualityLoadingAssetId: string | null;
  qualityReports: Readonly<Record<string, MediaQualityReport>>;
  tagLoadingAssetId: string | null;
  chatWorkspaceAvailable: boolean;
  openAssetId?: string | null;
  onOpenAssetHandled?: () => void;
  onImport: () => void;
  onTransform: (request: MediaImageTransformRequest) => void;
  onExport: (asset: MediaAssetRecord, mode: MediaAssetExportMode) => void;
  onAnalyzeQuality: (asset: MediaAssetRecord) => void;
  onLoadQualityReport: (reportAssetId: string) => void;
  onUpdateTags: (update: MediaAssetTagUpdate) => void;
  onAutoTag: (assetId: string) => void;
  onSendToChat: (asset: MediaAssetRecord) => void;
  onOpenAsFlow: (asset: MediaAssetRecord) => void;
  onOpenBackgroundRemovalAsFlow: (asset: MediaAssetRecord) => void;
  onOpenAlphaMatteAsFlow: (asset: MediaAssetRecord) => void;
  onOpenCompositeAsFlow: (
    foreground: MediaAssetRecord,
    background: MediaAssetRecord,
  ) => void;
  onOpenContactSheetAsFlow: (assets: readonly MediaAssetRecord[]) => void;
  onOpenTransformAsFlow: (request: MediaImageTransformRequest) => void;
  onPlanDeletion: (assetId: string) => Promise<MediaAssetDeletionImpact>;
  onDeleteAsset: (
    request: MediaAssetDeletionRequest,
  ) => Promise<MediaAssetDeletionResult>;
}

type OperationKind = MediaImageTransformOperation["kind"];

const formatBytes = (bytes: number): string => {
  if (bytes < 1_024) {
    return `${bytes} B`;
  }
  if (bytes < 1_024 * 1_024) {
    return `${(bytes / 1_024).toFixed(1)} KB`;
  }
  return `${(bytes / 1_024 / 1_024).toFixed(1)} MB`;
};

const formatMediaType = (mimeType: MediaAssetRecord["mimeType"]): string => {
  switch (mimeType) {
    case "image/jpeg":
      return "JPEG";
    case "image/png":
      return "PNG";
    case "image/webp":
      return "WebP";
    case "image/svg+xml":
      return "SVG";
    case "application/json":
      return "JSON";
  }
};

const COMMON_ASPECT_RATIOS = [
  ["9:16", 9 / 16],
  ["2:3", 2 / 3],
  ["3:4", 3 / 4],
  ["4:5", 4 / 5],
  ["1:1", 1],
  ["5:4", 5 / 4],
  ["4:3", 4 / 3],
  ["3:2", 3 / 2],
  ["16:10", 16 / 10],
  ["16:9", 16 / 9],
  ["21:9", 21 / 9],
] as const;

const greatestCommonDivisor = (left: number, right: number): number => {
  let currentLeft = Math.abs(left);
  let currentRight = Math.abs(right);
  while (currentRight !== 0) {
    [currentLeft, currentRight] = [currentRight, currentLeft % currentRight];
  }
  return currentLeft;
};

const formatAspectRatio = (width: number, height: number): string => {
  if (width <= 0 || height <= 0) {
    return "Unknown";
  }

  const ratio = width / height;
  const closestCommonRatio = COMMON_ASPECT_RATIOS.reduce((closest, candidate) =>
    Math.abs(candidate[1] - ratio) < Math.abs(closest[1] - ratio)
      ? candidate
      : closest,
  );
  if (Math.abs(closestCommonRatio[1] - ratio) / closestCommonRatio[1] <= 0.01) {
    return closestCommonRatio[0];
  }

  const divisor = greatestCommonDivisor(width, height);
  return `${width / divisor}:${height / divisor}`;
};

const outputFormatForAsset = (
  asset: MediaAssetRecord,
): MediaImageOutputFormat => {
  switch (asset.mimeType) {
    case "image/jpeg":
      return "jpeg";
    case "image/webp":
      return "webp";
    default:
      return "png";
  }
};

const assetProvenance = (asset: MediaAssetRecord): string => {
  if (asset.kind === "report") {
    return "analysis";
  }
  if (asset.operation) {
    if (asset.operation.kind === "remote-image-generation") {
      return "generated";
    }
    if (asset.operation.kind === "remote-image-edit") {
      return "edited";
    }
    if (asset.operation.kind === "rasterize-svg") {
      return "safe-svg";
    }
    return "derived";
  }
  return asset.fixture ? "fixture" : "imported";
};

const assetDisplayName = (asset: MediaAssetRecord): string => {
  if (asset.kind === "report") return "Technical quality report";
  if (asset.operation?.kind === "rasterize-svg") return "Safe SVG raster";
  if (asset.operation?.kind === "local-image-flow") {
    if (asset.operation.assetRole === "alpha-matte") return "Alpha matte";
    if (asset.operation.assetRole === "cutout") return "Transparent cutout";
    if (asset.operation.composite) return "Composite";
    if (asset.operation.contactSheet) return "Contact sheet";
  }
  return asset.operation
    ? `${asset.operation.kind} output`
    : `Output ${asset.outputIndex + 1}`;
};

const isAlphaMatteAsset = (asset: MediaAssetRecord): boolean =>
  asset.operation?.kind === "local-image-flow" &&
  asset.operation.assetRole === "alpha-matte";

const integerValue = (
  value: string,
  label: string,
  minimum: number,
): number => {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum) {
    throw new Error(`${label} must be a whole number of at least ${minimum}.`);
  }
  return number;
};

const verdictClassName = (verdict: MediaQualityVerdict): string => {
  switch (verdict) {
    case "pass":
      return "text-emerald-300";
    case "fail":
      return "text-rose-300";
    default:
      return "text-amber-300";
  }
};

const qualityOperation = (asset: MediaAssetRecord) =>
  asset.operation?.kind === "analyze-quality" ? asset.operation : null;

const formatObservationValue = (
  value: MediaQualityReport["observations"][number]["value"],
): string => {
  if (value === undefined) {
    return "Unknown";
  }
  if (typeof value === "number") {
    return Number.isInteger(value) ? String(value) : value.toFixed(4);
  }
  if (typeof value === "object") {
    return Object.entries(value)
      .map(([key, entry]) => `${key} ${entry}`)
      .join(" · ");
  }
  return String(value);
};

const AssetPreview = ({
  asset,
  maxEdge = 512,
  fit = "cover",
}: {
  asset: MediaAssetRecord;
  maxEdge?: number;
  fit?: "contain" | "cover";
}): JSX.Element => {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const assetId = asset.id;

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    setUrl(null);
    setFailed(false);
    void readMediaAssetReferencePreview(assetId, maxEdge)
      .then((blob) => {
        if (cancelled || typeof URL.createObjectURL !== "function") {
          return;
        }
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => {
        if (!cancelled) {
          setFailed(true);
        }
      });
    return () => {
      cancelled = true;
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [assetId, maxEdge]);

  if (url) {
    return (
      <img
        src={url}
        alt={`Preview of ${asset.width} by ${asset.height} media asset`}
        className={cn(
          "h-full w-full",
          fit === "contain" ? "object-contain" : "object-cover",
        )}
      />
    );
  }

  return (
    <div className="flex h-full w-full items-center justify-center text-center">
      {failed ? (
        <div>
          <FileImage className="mx-auto h-7 w-7 text-rose-400/70" />
          <span className="mt-2 block text-[9px] font-medium tracking-[0.14em] text-rose-300/60 uppercase">
            Preview unavailable
          </span>
        </div>
      ) : (
        <LoaderCircle className="h-5 w-5 animate-spin text-slate-600" />
      )}
    </div>
  );
};

const AssetPreviewDialog = ({
  asset,
  onOpenChange,
}: {
  asset: MediaAssetRecord | null;
  onOpenChange: (open: boolean) => void;
}): JSX.Element => (
  <Dialog open={asset !== null} onOpenChange={onOpenChange}>
    {asset ? (
      <DialogContent className="flex h-[min(860px,calc(100vh-32px))] w-[min(1120px,calc(100vw-32px))] max-w-none flex-col gap-0 overflow-hidden rounded-xl border-slate-800 bg-slate-950 p-0 text-slate-100 shadow-2xl sm:max-w-none">
        <DialogHeader className="border-b border-slate-800/80 px-5 py-4 pr-12 text-left">
          <DialogTitle className="truncate text-base font-semibold text-white">
            Preview {assetDisplayName(asset)}
          </DialogTitle>
          <DialogDescription className="text-xs text-slate-500">
            {asset.width} × {asset.height} · {formatAspectRatio(asset.width, asset.height)} · {formatBytes(asset.byteSize)} · {formatMediaType(asset.mimeType)}
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 bg-[repeating-conic-gradient(rgba(148,163,184,0.055)_0_25%,transparent_0_50%)] bg-[length:24px_24px] p-4">
          <AssetPreview asset={asset} maxEdge={2_048} fit="contain" />
        </div>
      </DialogContent>
    ) : null}
  </Dialog>
);

const ASSET_CONTEXT_MENU_ITEM_CLASS_NAME =
  "flex h-8 cursor-default items-center gap-2 rounded-md px-2 text-xs font-medium text-slate-300 outline-none select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-40 data-[highlighted]:bg-slate-800 data-[highlighted]:text-slate-100 [&_svg]:h-3.5 [&_svg]:w-3.5 [&_svg]:shrink-0";

interface AssetCardContextMenuProps {
  asset: MediaAssetRecord;
  children: ReactElement;
  chatWorkspaceAvailable: boolean;
  exportLoading: boolean;
  qualityLoading: boolean;
  onPreview: (assetId: string) => void;
  onInspect: (assetId: string) => void;
  onSendToChat: (asset: MediaAssetRecord) => void;
  onOpenAsFlow: (asset: MediaAssetRecord) => void;
  onAnalyzeQuality: (asset: MediaAssetRecord) => void;
  onExport: (asset: MediaAssetRecord) => void;
  onRequestDeletion: (asset: MediaAssetRecord) => void;
}

const AssetCardContextMenu = ({
  asset,
  children,
  chatWorkspaceAvailable,
  exportLoading,
  qualityLoading,
  onPreview,
  onInspect,
  onSendToChat,
  onOpenAsFlow,
  onAnalyzeQuality,
  onExport,
  onRequestDeletion,
}: AssetCardContextMenuProps): JSX.Element => {
  const isImage = asset.kind === "image";
  const isVisual = isImage || asset.kind === "vector";

  return (
    <ContextMenuPrimitive.Root>
      <ContextMenuPrimitive.Trigger asChild>{children}</ContextMenuPrimitive.Trigger>
      <ContextMenuPrimitive.Portal>
        <ContextMenuPrimitive.Content
          aria-label={`Actions for ${assetDisplayName(asset)}`}
          collisionPadding={8}
          className="z-[120] min-w-56 overflow-hidden rounded-lg border border-slate-700 bg-slate-950 p-1.5 text-slate-100 shadow-2xl shadow-black/45"
        >
          <ContextMenuPrimitive.Label className="max-w-64 truncate px-2 py-1.5 text-[10px] font-semibold tracking-[0.08em] text-slate-500 uppercase">
            {assetDisplayName(asset)}
          </ContextMenuPrimitive.Label>
          {isVisual ? (
            <ContextMenuPrimitive.Item
              className={ASSET_CONTEXT_MENU_ITEM_CLASS_NAME}
              onSelect={() => onPreview(asset.id)}
            >
              <Maximize2 className="text-sky-300" /> Preview
            </ContextMenuPrimitive.Item>
          ) : null}
          <ContextMenuPrimitive.Item
            className={ASSET_CONTEXT_MENU_ITEM_CLASS_NAME}
            onSelect={() => onInspect(asset.id)}
          >
            <PanelRightOpen className="text-slate-300" /> Inspect details
          </ContextMenuPrimitive.Item>
          {isImage ? (
            <ContextMenuPrimitive.Item
              disabled={!chatWorkspaceAvailable}
              title={
                chatWorkspaceAvailable
                  ? "Attach this asset to the active Chat composer"
                  : "Choose a Chat workspace before attaching Media Studio assets"
              }
              className={ASSET_CONTEXT_MENU_ITEM_CLASS_NAME}
              onSelect={() => onSendToChat(asset)}
            >
              <MessageCircle className="text-violet-300" /> Send to Chat
            </ContextMenuPrimitive.Item>
          ) : null}
          {isImage ? (
            <ContextMenuPrimitive.Separator className="my-1 h-px bg-slate-800" />
          ) : null}
          {isImage && !isAlphaMatteAsset(asset) ? (
            <ContextMenuPrimitive.Item
              className={ASSET_CONTEXT_MENU_ITEM_CLASS_NAME}
              onSelect={() => onOpenAsFlow(asset)}
            >
              <WandSparkles className="text-orange-300" /> Open text-guided edit as Flow
            </ContextMenuPrimitive.Item>
          ) : null}
          {isImage ? (
            <>
              <ContextMenuPrimitive.Item
                disabled={qualityLoading}
                className={ASSET_CONTEXT_MENU_ITEM_CLASS_NAME}
                onSelect={() => onAnalyzeQuality(asset)}
              >
                <ShieldCheck className="text-amber-300" /> Analyze technical quality
              </ContextMenuPrimitive.Item>
              <ContextMenuPrimitive.Item
                disabled={exportLoading}
                className={ASSET_CONTEXT_MENU_ITEM_CLASS_NAME}
                onSelect={() => onExport(asset)}
              >
                <Download className="text-emerald-300" /> Review export options
              </ContextMenuPrimitive.Item>
            </>
          ) : null}
          <ContextMenuPrimitive.Separator className="my-1 h-px bg-slate-800" />
          <ContextMenuPrimitive.Item
            className={cn(
              ASSET_CONTEXT_MENU_ITEM_CLASS_NAME,
              "text-rose-300 data-[highlighted]:bg-rose-500/10 data-[highlighted]:text-rose-200",
            )}
            onSelect={() => onRequestDeletion(asset)}
          >
            <Trash2 /> Review deletion impact
          </ContextMenuPrimitive.Item>
        </ContextMenuPrimitive.Content>
      </ContextMenuPrimitive.Portal>
    </ContextMenuPrimitive.Root>
  );
};

const AssetTagEditor = ({
  asset,
  loading,
  onUpdate,
  onAutoTag,
}: {
  asset: MediaAssetRecord;
  loading: boolean;
  onUpdate: (update: MediaAssetTagUpdate) => void;
  onAutoTag: (assetId: string) => void;
}): JSX.Element => {
  const [draft, setDraft] = useState("");
  const userTags = asset.tags.filter((tag) => tag.source === "user");
  const technicalTags = asset.tags.filter((tag) => tag.source === "technical");

  const addTag = (): void => {
    const value = draft.trim();
    if (!value) {
      return;
    }
    onUpdate({
      assetId: asset.id,
      tags: [...userTags.map((tag) => tag.label), value],
    });
    setDraft("");
  };

  return (
    <section className="mt-4 border-t border-slate-800 pt-4" aria-label="Asset tags">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-[10px] font-semibold tracking-[0.1em] text-slate-500 uppercase">
          <Tags className="h-3.5 w-3.5" /> Asset tags
        </div>
      </div>

      {asset.tags.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {asset.tags.map((tag) => (
            <span
              key={`${tag.source}:${tag.value}`}
              title={
                tag.source === "technical"
                  ? `Technical tag · confidence ${tag.confidence ?? "unknown"}`
                  : "User tag"
              }
              className={cn(
                "inline-flex min-w-0 items-center gap-1 border-b py-0.5 text-[9px]",
                tag.source === "technical"
                  ? "border-violet-400/25 text-violet-300"
                  : "border-sky-400/25 text-sky-300",
              )}
            >
              <span className="max-w-32 truncate">{tag.label}</span>
              {tag.source === "user" ? (
                <button
                  type="button"
                  aria-label={`Remove tag ${tag.label}`}
                  disabled={loading}
                  onClick={() =>
                    onUpdate({
                      assetId: asset.id,
                      tags: userTags
                        .filter((candidate) => candidate.value !== tag.value)
                        .map((candidate) => candidate.label),
                    })
                  }
                  className="rounded-sm text-sky-400/60 outline-none hover:text-sky-100 focus-visible:ring-1 focus-visible:ring-sky-300"
                >
                  <X className="h-2.5 w-2.5" />
                </button>
              ) : null}
            </span>
          ))}
        </div>
      ) : null}

      <div className="mt-3 flex gap-1.5">
        <Input
          aria-label="New asset tag"
          value={draft}
          maxLength={48}
          placeholder="product hero"
          disabled={loading || userTags.length >= 32}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              addTag();
            }
          }}
          className="h-8 min-w-0 border-slate-800 bg-slate-950 text-[10px] text-slate-300"
        />
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          aria-label="Add asset tag"
          disabled={loading || !draft.trim() || userTags.length >= 32}
          onClick={addTag}
          className="shrink-0 border-sky-400/20 text-sky-300"
        >
          {loading ? <LoaderCircle className="animate-spin" /> : <Plus />}
        </Button>
      </div>
      <Button
        type="button"
        variant="ghost"
        disabled={loading}
        onClick={() => onAutoTag(asset.id)}
        className="mt-2 h-8 w-full justify-start text-[10px] text-violet-300 hover:bg-violet-400/5 hover:text-violet-200"
      >
        {loading ? <LoaderCircle className="animate-spin" /> : <ScanSearch />}
        {technicalTags.length > 0 ? "Refresh technical tags" : "Generate technical tags"}
      </Button>
    </section>
  );
};

const AssetDeletionDialog = ({
  asset,
  impact,
  loading,
  onOpenChange,
  onConfirm,
}: {
  asset: MediaAssetRecord | null;
  impact: MediaAssetDeletionImpact | null;
  loading: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (
    mode: MediaAssetDeletionMode,
    confirmDependencies: boolean,
  ) => void;
}): JSX.Element => {
  const [mode, setMode] = useState<MediaAssetDeletionMode>("metadata-only");
  const [confirmDependencies, setConfirmDependencies] = useState(false);

  useEffect(() => {
    if (asset) {
      setMode("metadata-only");
      setConfirmDependencies(false);
    }
  }, [asset]);

  const hasDependencies = (impact?.dependentAssetIds.length ?? 0) > 0;
  const blocked = (impact?.activeExportCount ?? 0) > 0;
  const canConfirm =
    Boolean(asset && impact) &&
    !loading &&
    !blocked &&
    (!hasDependencies || confirmDependencies);

  return (
    <Dialog open={asset !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[min(720px,calc(100vh-28px))] w-[min(620px,calc(100vw-28px))] max-w-none gap-0 overflow-hidden border-slate-700 bg-slate-950 p-0 text-slate-100 sm:max-w-none">
        <DialogHeader className="border-b border-slate-800 px-5 py-4 pr-12 text-left">
          <DialogTitle className="flex items-center gap-2 text-base font-semibold text-white">
            <Trash2 className="h-4 w-4 text-rose-300" /> Delete asset safely
          </DialogTitle>
          <DialogDescription className="text-xs leading-5 text-slate-500">
            Review live lineage and byte references before creating a durable tombstone.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 overflow-y-auto px-5 py-5">
          {!impact || !asset ? (
            <div className="flex min-h-52 items-center justify-center gap-2 text-xs text-slate-500">
              <LoaderCircle className="h-4 w-4 animate-spin" /> Inspecting dependencies…
            </div>
          ) : (
            <>
              <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-3">
                <div className="text-[10px] text-slate-600">Selected asset</div>
                <div className="mt-1 truncate font-mono text-[10px] text-slate-300">
                  sha256:{asset.digest}
                </div>
              </div>

              <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
                {[
                  [impact.dependentAssetIds.length, "Dependents"],
                  [impact.sharedBlobAssetIds.length, "Shared blobs"],
                  [impact.exportCount, "Exports"],
                  [impact.renditionCount, "Renditions"],
                ].map(([value, label]) => (
                  <div
                    key={String(label)}
                    className="rounded-lg border border-slate-800 bg-slate-900/25 px-3 py-2"
                  >
                    <div className="text-sm font-semibold text-slate-200">{value}</div>
                    <div className="text-[9px] text-slate-600">{label}</div>
                  </div>
                ))}
              </div>

              <fieldset className="mt-5">
                <legend className="text-[10px] font-semibold tracking-[0.12em] text-slate-500 uppercase">
                  Deletion scope
                </legend>
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  <button
                    type="button"
                    aria-pressed={mode === "metadata-only"}
                    onClick={() => setMode("metadata-only")}
                    className={cn(
                      "rounded-xl border p-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-sky-400/60",
                      mode === "metadata-only"
                        ? "border-sky-400/35 bg-sky-400/8"
                        : "border-slate-800 bg-slate-900/25",
                    )}
                  >
                    <span className="block text-xs font-semibold text-slate-200">
                      Metadata only
                    </span>
                    <span className="mt-1 block text-[10px] leading-4 text-slate-500">
                      Hide the asset and preserve {formatBytes(
                        impact.originalByteSize + impact.renditionByteSize,
                      )} of cataloged bytes.
                    </span>
                  </button>
                  <button
                    type="button"
                    aria-pressed={mode === "metadata-and-unreferenced-bytes"}
                    onClick={() => setMode("metadata-and-unreferenced-bytes")}
                    className={cn(
                      "rounded-xl border p-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-rose-400/60",
                      mode === "metadata-and-unreferenced-bytes"
                        ? "border-rose-400/35 bg-rose-400/8"
                        : "border-slate-800 bg-slate-900/25",
                    )}
                  >
                    <span className="block text-xs font-semibold text-slate-200">
                      Metadata and safe bytes
                    </span>
                    <span className="mt-1 block text-[10px] leading-4 text-slate-500">
                      Reclaim up to {formatBytes(impact.reclaimableByteSize)}; retain {formatBytes(
                        impact.retainedSharedByteSize,
                      )} still in use.
                    </span>
                  </button>
                </div>
              </fieldset>

              {impact.warnings.length > 0 ? (
                <section className="mt-5" aria-label="Deletion warnings">
                  <h3 className="text-[10px] font-semibold tracking-[0.12em] text-slate-500 uppercase">
                    Impact review
                  </h3>
                  <ul className="mt-2 space-y-2">
                    {impact.warnings.map((warning) => (
                      <li
                        key={warning}
                        className="flex gap-2 rounded-lg border border-amber-400/15 bg-amber-400/5 px-3 py-2 text-[10px] leading-4 text-amber-100/80"
                      >
                        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        {warning}
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}

              {hasDependencies ? (
                <label className="mt-5 flex cursor-pointer items-start gap-3 rounded-xl border border-rose-400/20 bg-rose-400/5 p-3">
                  <input
                    type="checkbox"
                    checked={confirmDependencies}
                    onChange={(event) => setConfirmDependencies(event.target.checked)}
                    className="mt-0.5 h-4 w-4 accent-rose-400"
                  />
                  <span>
                    <span className="block text-xs font-semibold text-rose-100">
                      Preserve dependent lineage with a tombstone
                    </span>
                    <span className="mt-1 block text-[10px] leading-4 text-rose-200/60">
                      I reviewed {impact.dependentAssetIds.length} dependent asset
                      {impact.dependentAssetIds.length === 1 ? "" : "s"} and understand their source will be marked deleted.
                    </span>
                  </span>
                </label>
              ) : null}
            </>
          )}
        </div>

        <DialogFooter className="border-t border-slate-800 px-5 py-3 sm:flex-row sm:items-center sm:justify-between">
          <span className="text-[9px] text-slate-600">
            Review token prevents stale dependency confirmation.
          </span>
          <div className="flex justify-end gap-2">
            <DialogClose asChild>
              <Button type="button" variant="ghost" disabled={loading}>
                Cancel
              </Button>
            </DialogClose>
            <Button
              type="button"
              disabled={!canConfirm}
              onClick={() => onConfirm(mode, confirmDependencies)}
              className="bg-rose-500 text-white hover:bg-rose-400"
            >
              {loading ? <LoaderCircle className="animate-spin" /> : <Trash2 />}
              {mode === "metadata-only" ? "Create tombstone" : "Delete safe bytes"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

interface AssetExportDialogProps {
  asset: MediaAssetRecord | null;
  supported: boolean;
  loading: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (mode: MediaAssetExportMode) => void;
}

const AssetExportDialog = ({
  asset,
  supported,
  loading,
  onOpenChange,
  onConfirm,
}: AssetExportDialogProps): JSX.Element => {
  const [mode, setMode] = useState<MediaAssetExportMode>("metadata-stripped");

  useEffect(() => {
    if (asset) {
      setMode("metadata-stripped");
    }
  }, [asset]);

  return (
    <Dialog open={asset !== null} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(620px,calc(100vw-28px))] max-w-none gap-0 overflow-hidden border-slate-700 bg-slate-950 p-0 text-slate-100 sm:max-w-none">
        <DialogHeader className="border-b border-slate-800 px-5 py-4 pr-12 text-left">
          <DialogTitle className="flex items-center gap-2 text-base font-semibold text-white">
            <Download className="h-4 w-4 text-sky-300" /> Review image export
          </DialogTitle>
          <DialogDescription className="text-xs leading-5 text-slate-500">
            Choose whether the destination receives the immutable source bytes or a privacy-clean image. Media Studio keeps local provenance in either case.
          </DialogDescription>
        </DialogHeader>

        <fieldset className="space-y-3 px-5 py-5">
          <legend className="sr-only">Export mode</legend>
          <label
            className={cn(
              "block cursor-pointer rounded-2xl border p-4 transition-colors",
              mode === "metadata-stripped"
                ? "border-emerald-400/50 bg-emerald-400/8"
                : "border-slate-800 bg-slate-900/40 hover:border-slate-700",
            )}
          >
            <span className="flex items-start gap-3">
              <input
                type="radio"
                name="media-export-mode"
                value="metadata-stripped"
                checked={mode === "metadata-stripped"}
                onChange={() => setMode("metadata-stripped")}
                className="mt-1 accent-emerald-400"
              />
              <span>
                <span className="flex items-center gap-2 text-sm font-medium text-slate-100">
                  <ScanSearch className="h-4 w-4 text-emerald-300" /> Privacy-clean image
                  <span className="text-[9px] font-semibold text-emerald-300">
                    Recommended
                  </span>
                </span>
                <span className="mt-1 block text-[11px] leading-5 text-slate-500">
                  Applies EXIF orientation, then re-encodes decoded pixels without EXIF, XMP, IPTC, or embedded container metadata. PNG and WebP remain lossless; JPEG is re-encoded at quality 95.
                </span>
              </span>
            </span>
          </label>

          <label
            className={cn(
              "block cursor-pointer rounded-2xl border p-4 transition-colors",
              mode === "verified-original"
                ? "border-sky-400/50 bg-sky-400/8"
                : "border-slate-800 bg-slate-900/40 hover:border-slate-700",
            )}
          >
            <span className="flex items-start gap-3">
              <input
                type="radio"
                name="media-export-mode"
                value="verified-original"
                checked={mode === "verified-original"}
                onChange={() => setMode("verified-original")}
                className="mt-1 accent-sky-400"
              />
              <span>
                <span className="flex items-center gap-2 text-sm font-medium text-slate-100">
                  <ShieldCheck className="h-4 w-4 text-sky-300" /> Verified original bytes
                </span>
                <span className="mt-1 block text-[11px] leading-5 text-slate-500">
                  Copies the exact content-addressed source and verifies its SHA-256 digest after writing. Embedded camera, location, authoring, and color metadata are preserved.
                </span>
              </span>
            </span>
          </label>

          {asset ? (
            <div className="rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2 text-[10px] text-slate-600">
              Source <span className="font-mono text-slate-400">{asset.digest}</span>
            </div>
          ) : null}
          {!supported ? (
            <div role="note" className="rounded-xl border border-amber-400/20 bg-amber-400/5 px-3 py-2 text-[10px] leading-4 text-amber-200/80">
              Export review is available here, but writing a user-selected file requires the native desktop app.
            </div>
          ) : null}
        </fieldset>

        <DialogFooter className="border-t border-slate-800 px-5 py-3 sm:flex-row sm:items-center sm:justify-end">
          <DialogClose asChild>
            <Button type="button" variant="ghost" disabled={loading} className="text-slate-400">
              Cancel
            </Button>
          </DialogClose>
          <Button
            type="button"
            disabled={!supported || loading}
            onClick={() => onConfirm(mode)}
            className="bg-sky-500 text-slate-950 hover:bg-sky-400"
          >
            {loading ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
            {loading
              ? "Preparing verified export…"
              : supported
                ? mode === "metadata-stripped"
                  ? "Export privacy-clean image"
                  : "Export verified original"
                : "Native app required"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

interface TransformInspectorProps {
  asset: MediaAssetRecord;
  runtimeMode: MediaRuntimeStatus["mode"] | null;
  loading: boolean;
  exportLoading: boolean;
  qualityLoading: boolean;
  qualityReportAssetId: string | null;
  qualityReport: MediaQualityReport | null;
  tagLoading: boolean;
  missingSourceAssetIds: readonly string[];
  onSelectSource: (assetId: string) => void;
  onTransform: (request: MediaImageTransformRequest) => void;
  onExport: (asset: MediaAssetRecord) => void;
  onAnalyzeQuality: (asset: MediaAssetRecord) => void;
  onLoadQualityReport: (reportAssetId: string) => void;
  onUpdateTags: (update: MediaAssetTagUpdate) => void;
  onAutoTag: (assetId: string) => void;
  onRequestDeletion: (asset: MediaAssetRecord) => void;
  chatWorkspaceAvailable: boolean;
  onSendToChat: (asset: MediaAssetRecord) => void;
  onOpenAsFlow: (asset: MediaAssetRecord) => void;
  onOpenBackgroundRemovalAsFlow: (asset: MediaAssetRecord) => void;
  onOpenAlphaMatteAsFlow: (asset: MediaAssetRecord) => void;
  onRequestCompositeBackground: (asset: MediaAssetRecord) => void;
  onOpenTransformAsFlow: (request: MediaImageTransformRequest) => void;
}

interface FollowUpActionProps {
  label: string;
  icon: LucideIcon;
  disabled?: boolean;
  danger?: boolean;
  onClick: () => void;
}

const FollowUpAction = ({
  label,
  icon: Icon,
  disabled = false,
  danger = false,
  onClick,
}: FollowUpActionProps): JSX.Element => (
  <button
    type="button"
    disabled={disabled}
    onClick={onClick}
    className={cn(
      "flex h-9 w-full items-center gap-2 rounded-md px-2.5 text-left text-xs font-medium outline-none transition-colors disabled:cursor-not-allowed disabled:opacity-40",
      danger
        ? "text-rose-300 hover:bg-rose-500/10 focus-visible:bg-rose-500/10"
        : "text-slate-300 hover:bg-slate-800 focus-visible:bg-slate-800 focus-visible:text-slate-100",
    )}
  >
    <Icon className="h-3.5 w-3.5 shrink-0" />
    <span className="truncate">{label}</span>
  </button>
);

const TransformInspector = ({
  asset,
  runtimeMode,
  loading,
  exportLoading,
  qualityLoading,
  qualityReportAssetId,
  qualityReport,
  tagLoading,
  missingSourceAssetIds,
  onSelectSource,
  onTransform,
  onExport,
  onAnalyzeQuality,
  onLoadQualityReport,
  onUpdateTags,
  onAutoTag,
  onRequestDeletion,
  chatWorkspaceAvailable,
  onSendToChat,
  onOpenAsFlow,
  onOpenBackgroundRemovalAsFlow,
  onOpenAlphaMatteAsFlow,
  onRequestCompositeBackground,
  onOpenTransformAsFlow,
}: TransformInspectorProps): JSX.Element => {
  const isAlphaMatte = isAlphaMatteAsset(asset);
  const [operationKind, setOperationKind] = useState<OperationKind>("resize");
  const [x, setX] = useState("0");
  const [y, setY] = useState("0");
  const [width, setWidth] = useState(String(asset.width));
  const [height, setHeight] = useState(String(asset.height));
  const [fit, setFit] = useState<MediaImageResizeFit>("contain");
  const [outputFormat, setOutputFormat] = useState<MediaImageOutputFormat>(() =>
    outputFormatForAsset(asset),
  );
  const [quality, setQuality] = useState("90");
  const [jpegBackground, setJpegBackground] = useState("#ffffff");
  const [validationError, setValidationError] = useState<string | null>(null);
  const [followUpOpen, setFollowUpOpen] = useState(false);

  useEffect(() => {
    setOperationKind("resize");
    setX("0");
    setY("0");
    setWidth(String(asset.width));
    setHeight(String(asset.height));
    setFit("contain");
    setOutputFormat(outputFormatForAsset(asset));
    setQuality("90");
    setJpegBackground("#ffffff");
    setValidationError(null);
    setFollowUpOpen(false);
  }, [asset.height, asset.id, asset.mimeType, asset.width]);

  useEffect(() => {
    if (qualityReportAssetId && !qualityReport) {
      onLoadQualityReport(qualityReportAssetId);
    }
  }, [onLoadQualityReport, qualityReport, qualityReportAssetId]);

  const createTransformRequest = (): MediaImageTransformRequest => {
    let operation: MediaImageTransformOperation;
      if (operationKind === "crop") {
        const cropX = integerValue(x, "Crop X", 0);
        const cropY = integerValue(y, "Crop Y", 0);
        const cropWidth = integerValue(width, "Crop width", 1);
        const cropHeight = integerValue(height, "Crop height", 1);
        if (cropX + cropWidth > asset.width || cropY + cropHeight > asset.height) {
          throw new Error("Crop rectangle must stay inside the source image.");
        }
        operation = {
          kind: "crop",
          x: cropX,
          y: cropY,
          width: cropWidth,
          height: cropHeight,
        };
      } else if (operationKind === "resize") {
        operation = {
          kind: "resize",
          width: integerValue(width, "Resize width", 1),
          height: integerValue(height, "Resize height", 1),
          fit,
        };
      } else {
        operation = { kind: "convert" };
      }
      const request: MediaImageTransformRequest = {
        sourceAssetId: asset.id,
        operation,
        outputFormat,
        ...(outputFormat === "jpeg"
          ? {
              quality: integerValue(quality, "JPEG quality", 1),
              jpegBackground,
            }
          : {}),
      };
      if (isAlphaMatte && request.outputFormat === "jpeg") {
        throw new Error("Alpha mattes must remain lossless PNG or WebP assets.");
      }
      if (request.quality !== undefined && request.quality > 100) {
        throw new Error("JPEG quality cannot exceed 100.");
      }
    return request;
  };

  const useValidatedRequest = (
    action: (request: MediaImageTransformRequest) => void,
  ): void => {
    try {
      const request = createTransformRequest();
      setValidationError(null);
      action(request);
    } catch (error: unknown) {
      setValidationError(
        error instanceof Error ? error.message : "Transform settings are invalid.",
      );
    }
  };

  const submit = (): void => useValidatedRequest(onTransform);

  const runFollowUp = (action: () => void): void => {
    setFollowUpOpen(false);
    action();
  };

  return (
    <aside className="rounded-2xl border border-sky-400/15 bg-slate-900/60 p-4 shadow-2xl shadow-slate-950/40 lg:sticky lg:top-0">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2 text-xs font-semibold text-slate-100">
          <WandSparkles className="h-4 w-4 text-sky-300" /> Derive asset
        </div>
        <span className="shrink-0 text-[9px] text-slate-500">
          {runtimeMode === "native" ? "Native" : "Preview"}
        </span>
      </div>

      {missingSourceAssetIds.length > 0 ? (
        <div className="mt-4 flex gap-2 rounded-xl border border-amber-400/20 bg-amber-400/5 p-3 text-[10px] leading-4 text-amber-100/80">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {missingSourceAssetIds.length} source tombstone
          {missingSourceAssetIds.length === 1 ? "" : "s"} preserved in lineage. The original metadata was deleted after dependency review.
        </div>
      ) : null}

      {asset.sourceAssetIds.length > 0 ? (
        <section
          aria-label="Source lineage"
          className="mt-4 rounded-xl border border-sky-400/15 bg-sky-400/5 p-3"
        >
          <div className="flex items-center gap-2 text-[10px] font-semibold text-sky-100">
            <Boxes className="h-3.5 w-3.5 text-sky-300" /> Source lineage
          </div>
          <ol className="mt-2 space-y-1.5">
            {asset.sourceAssetIds.map((sourceAssetId, index) => {
              const missing = missingSourceAssetIds.includes(sourceAssetId);
              const remoteSource =
                asset.operation?.kind === "remote-image-edit"
                  ? asset.operation.sources.find(
                      (source) => source.assetId === sourceAssetId,
                    )
                  : undefined;
              return (
                <li key={sourceAssetId}>
                  <button
                    type="button"
                    disabled={missing}
                    aria-label={`Open source ${sourceAssetId}`}
                    title={sourceAssetId}
                    onClick={() => onSelectSource(sourceAssetId)}
                    className="flex w-full items-center justify-between gap-3 rounded-lg border border-slate-800/80 bg-slate-950/50 px-2.5 py-2 text-left transition-colors hover:border-sky-400/30 hover:bg-sky-400/5 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <span className="min-w-0 truncate text-[9px] font-medium text-slate-300">
                      {remoteSource
                        ? `${remoteSource.role} · ${Math.round(remoteSource.influence * 100)}% influence`
                        : `Source ${index + 1}`}
                    </span>
                    <span className="shrink-0 text-[8px] uppercase tracking-wide text-slate-600">
                      {missing ? "tombstone" : "inspect"}
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        </section>
      ) : null}

      {asset.operation?.kind === "rasterize-svg" ? (
        <div className="mt-4 rounded-xl border border-violet-400/20 bg-violet-400/5 p-3">
          <div className="flex items-center gap-2 text-[10px] font-semibold text-violet-200">
            <FileImage className="h-3.5 w-3.5" /> Safe SVG raster
            <span className="text-[8px] font-normal text-violet-300">
              No network
            </span>
          </div>
          {asset.operation.hadText ? (
            <p className="mt-2 text-[9px] leading-4 text-amber-300/70">
              Text was flattened with the fonts installed on this machine. The published PNG is stable; rerasterizing the SVG on another system may choose different fonts.
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="mt-4 grid grid-cols-3 rounded-xl border border-slate-800 bg-slate-950/60 p-1">
        {([
          ["crop", Crop, "Crop"],
          ["resize", Maximize2, "Resize"],
          ["convert", FileImage, "Convert"],
        ] as const).map(([kind, Icon, label]) => (
          <button
            key={kind}
            type="button"
            aria-pressed={operationKind === kind}
            onClick={() => {
              setOperationKind(kind);
              setValidationError(null);
            }}
            className={cn(
              "flex items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-[10px] font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-sky-400/60",
              operationKind === kind
                ? "bg-sky-400/10 text-sky-200"
                : "text-slate-600 hover:text-slate-300",
            )}
          >
            <Icon className="h-3.5 w-3.5" /> {label}
          </button>
        ))}
      </div>

      {operationKind !== "convert" ? (
        <fieldset className="mt-4">
          <legend className="text-[10px] font-semibold tracking-[0.1em] text-slate-500 uppercase">
            {operationKind === "crop" ? "Rectangle" : "Target box"}
          </legend>
          <div className="mt-2 grid grid-cols-2 gap-2">
            {operationKind === "crop" ? (
              <>
                <NumberField label="X" value={x} onChange={setX} />
                <NumberField label="Y" value={y} onChange={setY} />
              </>
            ) : null}
            <NumberField label="Width" value={width} onChange={setWidth} />
            <NumberField label="Height" value={height} onChange={setHeight} />
          </div>
          {operationKind === "resize" ? (
            <label className="mt-3 block text-[10px] text-slate-500">
              Fit mode
              <select
                aria-label="Resize fit mode"
                value={fit}
                onChange={(event) => setFit(event.target.value as MediaImageResizeFit)}
                className="mt-1 h-9 w-full rounded-lg border border-slate-800 bg-slate-950 px-2.5 text-xs text-slate-300 outline-none focus:border-sky-400/50"
              >
                <option value="contain">Contain · preserve all pixels</option>
                <option value="cover">Cover · crop to fill</option>
                <option value="stretch">Stretch · exact dimensions</option>
              </select>
            </label>
          ) : null}
        </fieldset>
      ) : null}

      <fieldset className="mt-4 border-t border-slate-800 pt-4">
        <legend className="text-[10px] font-semibold tracking-[0.1em] text-slate-500 uppercase">
          Output
        </legend>
        <label className="mt-2 block text-[10px] text-slate-500">
          Format
          <select
            aria-label="Transform output format"
            value={outputFormat}
            onChange={(event) =>
              setOutputFormat(event.target.value as MediaImageOutputFormat)
            }
            className="mt-1 h-9 w-full rounded-lg border border-slate-800 bg-slate-950 px-2.5 text-xs text-slate-300 outline-none focus:border-sky-400/50"
          >
            <option value="png">PNG · lossless + alpha</option>
            {!isAlphaMatte ? <option value="jpeg">JPEG · compact photo</option> : null}
            <option value="webp">WebP · lossless + alpha</option>
          </select>
        </label>
        {outputFormat === "jpeg" ? (
          <div className="mt-3 grid grid-cols-[1fr_72px] gap-2">
            <NumberField label="Quality" value={quality} onChange={setQuality} />
            <label className="text-[10px] text-slate-500">
              Matte
              <input
                aria-label="JPEG background color"
                type="color"
                value={jpegBackground}
                onChange={(event) => setJpegBackground(event.target.value)}
                className="mt-1 h-9 w-full cursor-pointer rounded-lg border border-slate-800 bg-slate-950 p-1"
              />
            </label>
          </div>
        ) : null}
      </fieldset>

      <section className="mt-4 border-t border-slate-800 pt-4" aria-label="Technical quality">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-[10px] font-semibold tracking-[0.1em] text-slate-500 uppercase">
            <ShieldCheck className="h-3.5 w-3.5" /> Technical quality
          </div>
          {qualityReport ? (
            <span className={cn("text-[9px] font-semibold uppercase", verdictClassName(qualityReport.verdict))}>
              {qualityReport.verdict}
            </span>
          ) : null}
        </div>
        {qualityReport ? (
          <div className="mt-2 rounded-xl border border-slate-800 bg-slate-950/45 p-3">
            <p className="text-[10px] leading-4 text-slate-400">
              {qualityReport.gateReasons[0]}
            </p>
            <div className="mt-2 grid grid-cols-2 gap-2 text-[9px] text-slate-600">
              <span>{qualityReport.observations.filter((item) => item.status === "observed").length} observed</span>
              <span>{qualityReport.observations.filter((item) => item.status === "unknown").length} unknown</span>
            </div>
          </div>
        ) : null}
        <Button
          type="button"
          variant="outline"
          disabled={qualityLoading}
          onClick={() => onAnalyzeQuality(asset)}
          className="mt-3 w-full border-amber-400/20 bg-amber-400/5 text-amber-200 hover:bg-amber-400/10"
        >
          {qualityLoading ? (
            <LoaderCircle className="h-4 w-4 animate-spin" />
          ) : (
            <ShieldCheck className="h-4 w-4" />
          )}
          {qualityLoading
            ? "Analyzing technical quality…"
            : qualityReport
              ? "Run profile again"
              : "Analyze technical quality"}
        </Button>
      </section>

      <AssetTagEditor
        asset={asset}
        loading={tagLoading}
        onUpdate={onUpdateTags}
        onAutoTag={onAutoTag}
      />

      {validationError ? (
        <div role="alert" className="mt-3 text-[10px] leading-4 text-rose-300">
          {validationError}
        </div>
      ) : null}

      {!isAlphaMatte ? (
        <Button
          type="button"
          disabled={loading}
          onClick={submit}
          className="mt-4 w-full bg-sky-500 text-slate-950 hover:bg-sky-400"
        >
          {loading ? (
            <LoaderCircle className="h-4 w-4 animate-spin" />
          ) : (
            <WandSparkles className="h-4 w-4" />
          )}
          {loading
            ? "Publishing derivative…"
            : runtimeMode === "native"
              ? "Create derived asset"
              : "Create preview derivative"}
        </Button>
      ) : null}

      <Popover open={followUpOpen} onOpenChange={setFollowUpOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            className="mt-2 w-full border-slate-700 bg-slate-950/40 text-slate-200 hover:bg-slate-800"
          >
            <Ellipsis className="h-4 w-4" /> Follow Up
          </Button>
        </PopoverTrigger>
        <PopoverContent
          side="left"
          align="end"
          sideOffset={8}
          aria-label="Follow Up actions"
          onCloseAutoFocus={(event) => event.preventDefault()}
          className="max-h-[min(520px,var(--radix-popover-content-available-height))] w-72 overflow-y-auto border-slate-700 bg-slate-950 p-1.5 text-slate-100 shadow-2xl shadow-black/45"
        >
          <div className="px-2 py-1.5 text-[10px] font-semibold tracking-[0.1em] text-slate-500 uppercase">
            Flow
          </div>
          <FollowUpAction
            label="Open current transform as Flow"
            icon={FolderOpen}
            onClick={() =>
              runFollowUp(() => useValidatedRequest(onOpenTransformAsFlow))
            }
          />
          {!isAlphaMatte ? (
            <>
              <FollowUpAction
                label="Open text-guided edit as Flow"
                icon={WandSparkles}
                onClick={() => runFollowUp(() => onOpenAsFlow(asset))}
              />
              <FollowUpAction
                label="Cut out subject as Flow"
                icon={ScanSearch}
                onClick={() =>
                  runFollowUp(() => onOpenBackgroundRemovalAsFlow(asset))
                }
              />
              <FollowUpAction
                label="Extract alpha matte as Flow"
                icon={ImageIcon}
                onClick={() => runFollowUp(() => onOpenAlphaMatteAsFlow(asset))}
              />
              <FollowUpAction
                label="Composite over background as Flow"
                icon={Boxes}
                onClick={() =>
                  runFollowUp(() => onRequestCompositeBackground(asset))
                }
              />
            </>
          ) : null}

          <div className="my-1 h-px bg-slate-800" />
          <FollowUpAction
            label="Send to Chat"
            icon={MessageCircle}
            disabled={!chatWorkspaceAvailable}
            onClick={() => runFollowUp(() => onSendToChat(asset))}
          />
          <FollowUpAction
            label={exportLoading ? "Preparing export…" : "Review export options"}
            icon={exportLoading ? LoaderCircle : Download}
            disabled={exportLoading}
            onClick={() => runFollowUp(() => onExport(asset))}
          />
          <div className="my-1 h-px bg-slate-800" />
          <FollowUpAction
            label="Review deletion impact"
            icon={Trash2}
            danger
            onClick={() => runFollowUp(() => onRequestDeletion(asset))}
          />
        </PopoverContent>
      </Popover>
    </aside>
  );
};

interface QualityReportInspectorProps {
  asset: MediaAssetRecord;
  report: MediaQualityReport | null;
  sourceAsset: MediaAssetRecord | null;
  loading: boolean;
  tagLoading: boolean;
  missingSourceAssetIds: readonly string[];
  onLoad: (reportAssetId: string) => void;
  onAnalyze: (asset: MediaAssetRecord) => void;
  onUpdateTags: (update: MediaAssetTagUpdate) => void;
  onAutoTag: (assetId: string) => void;
  onRequestDeletion: (asset: MediaAssetRecord) => void;
}

const QualityReportInspector = ({
  asset,
  report,
  sourceAsset,
  loading,
  tagLoading,
  missingSourceAssetIds,
  onLoad,
  onAnalyze,
  onUpdateTags,
  onAutoTag,
  onRequestDeletion,
}: QualityReportInspectorProps): JSX.Element => {
  const metadata = qualityOperation(asset);
  useEffect(() => {
    if (!report) {
      onLoad(asset.id);
    }
  }, [asset.id, onLoad, report]);

  return (
    <aside className="rounded-2xl border border-amber-400/15 bg-slate-900/60 p-4 shadow-2xl shadow-slate-950/40 lg:sticky lg:top-0">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-xs font-semibold text-slate-100">
            <FileJson className="h-4 w-4 text-amber-300" /> Quality report
          </div>
          <p className="mt-1 text-[10px] leading-4 text-slate-500">
            Immutable component observations with explicit limitations and source lineage.
          </p>
        </div>
        {metadata ? (
          <span className={cn("text-[9px] font-semibold uppercase", verdictClassName(metadata.verdict))}>
            {metadata.verdict}
          </span>
        ) : null}
      </div>

      {missingSourceAssetIds.length > 0 ? (
        <div className="mt-4 flex gap-2 rounded-xl border border-amber-400/20 bg-amber-400/5 p-3 text-[10px] leading-4 text-amber-100/80">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          Source metadata was deleted after dependency review. The report retains {missingSourceAssetIds.length} tombstone reference{missingSourceAssetIds.length === 1 ? "" : "s"}.
        </div>
      ) : null}

      {loading && !report ? (
        <div className="mt-8 flex items-center justify-center gap-2 py-10 text-xs text-slate-500">
          <LoaderCircle className="h-4 w-4 animate-spin" /> Verifying report…
        </div>
      ) : report ? (
        <>
          <div className="mt-4 rounded-xl border border-slate-800 bg-slate-950/50 p-3">
            <div className="text-[10px] font-semibold text-slate-300">
              {report.profile.id} · {report.profile.version}
            </div>
            <p className="mt-1 text-[9px] leading-4 text-slate-600">
              {report.profile.description}
            </p>
          </div>
          <section className="mt-4" aria-label="Quality gate reasons">
            <h3 className="text-[10px] font-semibold tracking-[0.1em] text-slate-500 uppercase">
              Gate outcome
            </h3>
            <ul className="mt-2 space-y-2">
              {report.gateReasons.map((reason) => (
                <li
                  key={reason}
                  className="rounded-lg border border-slate-800 bg-slate-950/35 px-3 py-2 text-[10px] leading-4 text-slate-400"
                >
                  {reason}
                </li>
              ))}
            </ul>
          </section>
          <section className="mt-4" aria-label="Quality observations">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-[10px] font-semibold tracking-[0.1em] text-slate-500 uppercase">
                Observations
              </h3>
              <span className="text-[9px] text-slate-700">{report.observations.length} retained</span>
            </div>
            <div className="mt-2 max-h-72 space-y-1.5 overflow-y-auto pr-1">
              {report.observations.map((observation) => (
                <div
                  key={observation.metricId}
                  className="rounded-lg border border-slate-800/80 bg-slate-950/35 px-3 py-2"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate font-mono text-[9px] text-slate-400">
                      {observation.metricId}
                    </span>
                    <span
                      className={cn(
                        "shrink-0 text-[8px] font-semibold uppercase",
                        observation.status === "observed" ? "text-emerald-400/70" : "text-amber-400/70",
                      )}
                    >
                      {observation.status}
                    </span>
                  </div>
                  <div className="mt-1 text-[10px] text-slate-500">
                    {formatObservationValue(observation.value)}
                    {observation.unit ? ` ${observation.unit}` : ""}
                  </div>
                  {observation.limitations[0] ? (
                    <p className="mt-1 text-[8px] leading-3 text-slate-700">
                      {observation.limitations[0]}
                    </p>
                  ) : null}
                </div>
              ))}
            </div>
          </section>
        </>
      ) : (
        <div role="alert" className="mt-4 text-[10px] text-rose-300">
          Report content is unavailable.
        </div>
      )}

      <AssetTagEditor
        asset={asset}
        loading={tagLoading}
        onUpdate={onUpdateTags}
        onAutoTag={onAutoTag}
      />

      {sourceAsset ? (
        <Button
          type="button"
          variant="outline"
          disabled={loading}
          onClick={() => onAnalyze(sourceAsset)}
          className="mt-4 w-full border-amber-400/20 bg-amber-400/5 text-amber-200 hover:bg-amber-400/10"
        >
          {loading ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
          Re-run profile on source
        </Button>
      ) : null}
      <Button
        type="button"
        variant="ghost"
        onClick={() => onRequestDeletion(asset)}
        className="mt-2 w-full text-rose-300/80 hover:bg-rose-400/8 hover:text-rose-200"
      >
        <Trash2 className="h-4 w-4" /> Review deletion impact
      </Button>
      <p className="mt-2 text-center text-[9px] text-slate-700">
        sha256:{asset.digest.slice(0, 16)}…
      </p>
    </aside>
  );
};

const NumberField = ({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}): JSX.Element => (
  <label className="text-[10px] text-slate-500">
    {label}
    <Input
      aria-label={label}
      inputMode="numeric"
      type="number"
      min={label === "X" || label === "Y" ? 0 : 1}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className="mt-1 h-9 border-slate-800 bg-slate-950 text-xs text-slate-300"
    />
  </label>
);

export const MediaLibraryView = ({
  assets,
  runtimeStatus,
  runtimeError,
  importSupported,
  importLoading,
  transformLoading,
  exportSupported,
  exportLoading,
  exportNotice,
  deletionNotice,
  qualityLoadingAssetId,
  qualityReports,
  tagLoadingAssetId,
  chatWorkspaceAvailable,
  openAssetId,
  onOpenAssetHandled,
  onImport,
  onTransform,
  onExport,
  onAnalyzeQuality,
  onLoadQualityReport,
  onUpdateTags,
  onAutoTag,
  onSendToChat,
  onOpenAsFlow,
  onOpenBackgroundRemovalAsFlow,
  onOpenAlphaMatteAsFlow,
  onOpenCompositeAsFlow,
  onOpenContactSheetAsFlow,
  onOpenTransformAsFlow,
  onPlanDeletion,
  onDeleteAsset,
}: MediaLibraryViewProps): JSX.Element => {
  const [query, setQuery] = useState("");
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);
  const [previewAssetId, setPreviewAssetId] = useState<string | null>(null);
  const [exportAsset, setExportAsset] = useState<MediaAssetRecord | null>(null);
  const [compositeForeground, setCompositeForeground] =
    useState<MediaAssetRecord | null>(null);
  const [contactSheetOpen, setContactSheetOpen] = useState(false);
  const [contactSheetAssetIds, setContactSheetAssetIds] = useState<string[]>([]);
  const [deletionAsset, setDeletionAsset] = useState<MediaAssetRecord | null>(null);
  const [deletionImpact, setDeletionImpact] =
    useState<MediaAssetDeletionImpact | null>(null);
  const [deletionLoading, setDeletionLoading] = useState(false);
  const activeAssetIds = useMemo(
    () => new Set(assets.map((asset) => asset.id)),
    [assets],
  );
  const compositeBackgrounds = useMemo(
    () =>
      assets.filter(
        (candidate) =>
          candidate.kind === "image" &&
          candidate.id !== compositeForeground?.id &&
          !isAlphaMatteAsset(candidate),
      ),
    [assets, compositeForeground?.id],
  );
  const contactSheetCandidates = useMemo(
    () => assets.filter((candidate) => candidate.kind === "image"),
    [assets],
  );
  const selectedContactSheetAssets = contactSheetAssetIds
    .map((assetId) => contactSheetCandidates.find((asset) => asset.id === assetId))
    .filter((asset): asset is MediaAssetRecord => Boolean(asset));
  const filteredAssets = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) {
      return assets;
    }
    return assets.filter((asset) =>
      [
        asset.id,
        asset.runId,
        asset.digest,
        asset.mimeType,
        asset.operation?.kind ?? "",
        qualityOperation(asset)?.profileId ?? "",
        qualityOperation(asset)?.verdict ?? "",
        assetProvenance(asset),
        ...asset.sourceAssetIds,
        ...asset.tags.flatMap((tag) => [tag.value, tag.label, tag.source]),
      ].some((value) => value.toLowerCase().includes(normalized)),
    );
  }, [assets, query]);
  const selectedAsset =
    assets.find((asset) => asset.id === selectedAssetId) ?? null;
  const previewAsset =
    assets.find(
      (asset) =>
        asset.id === previewAssetId &&
        (asset.kind === "image" || asset.kind === "vector"),
    ) ?? null;
  const selectedMissingSourceAssetIds = selectedAsset
    ? selectedAsset.sourceAssetIds.filter((sourceId) => !activeAssetIds.has(sourceId))
    : [];
  const selectedSourceAsset = selectedAsset?.sourceAssetIds[0]
    ? assets.find((asset) => asset.id === selectedAsset.sourceAssetIds[0]) ?? null
    : null;
  const latestQualityReportAsset = selectedAsset?.kind === "image"
    ? assets.find(
        (asset) =>
          asset.kind === "report" &&
          asset.operation?.kind === "analyze-quality" &&
          asset.sourceAssetIds.includes(selectedAsset.id),
      ) ?? null
    : null;

  useEffect(() => {
    if (!openAssetId || !assets.some((asset) => asset.id === openAssetId)) {
      return;
    }
    setSelectedAssetId(openAssetId);
    onOpenAssetHandled?.();
  }, [assets, onOpenAssetHandled, openAssetId]);

  useEffect(() => {
    if (selectedAssetId && !assets.some((asset) => asset.id === selectedAssetId)) {
      setSelectedAssetId(null);
    }
  }, [assets, selectedAssetId]);

  useEffect(() => {
    if (previewAssetId && !assets.some((asset) => asset.id === previewAssetId)) {
      setPreviewAssetId(null);
    }
  }, [assets, previewAssetId]);

  const requestDeletion = (asset: MediaAssetRecord): void => {
    setDeletionAsset(asset);
    setDeletionImpact(null);
    setDeletionLoading(true);
    void onPlanDeletion(asset.id)
      .then((impact) => setDeletionImpact(impact))
      .catch(() => setDeletionAsset(null))
      .finally(() => setDeletionLoading(false));
  };

  const confirmDeletion = (
    mode: MediaAssetDeletionMode,
    confirmDependencies: boolean,
  ): void => {
    if (!deletionAsset || !deletionImpact || deletionLoading) {
      return;
    }
    setDeletionLoading(true);
    void onDeleteAsset({
      assetId: deletionAsset.id,
      mode,
      confirmationToken: deletionImpact.confirmationToken,
      confirmDependencies,
    })
      .then(() => {
        setSelectedAssetId(null);
        setDeletionAsset(null);
        setDeletionImpact(null);
      })
      .catch(() => {
        void onPlanDeletion(deletionAsset.id)
          .then((impact) => setDeletionImpact(impact))
          .catch(() => setDeletionAsset(null));
      })
      .finally(() => setDeletionLoading(false));
  };

  return (
    <div className="h-full overflow-y-auto bg-slate-950 px-5 py-6 sm:px-7 sm:py-7">
      <div className="mx-auto max-w-7xl">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <h1 className="flex items-center gap-2 text-sm font-semibold text-slate-100">
            <FolderOpen className="h-4 w-4 text-emerald-300" /> Asset library
          </h1>
          <div className="flex w-full flex-wrap items-center justify-end gap-2 sm:w-auto">
            <Button
              type="button"
              variant="outline"
              disabled={contactSheetCandidates.length < 2}
              title={
                contactSheetCandidates.length < 2
                  ? "Add at least two images to build a comparison sheet"
                  : "Choose two to eight images and open an editable local comparison flow"
              }
              onClick={() => {
                setContactSheetAssetIds([]);
                setContactSheetOpen(true);
              }}
              className="border-sky-400/20 bg-sky-400/5 text-sky-200 hover:bg-sky-400/10"
            >
              <LayoutGrid className="h-4 w-4" /> Build contact sheet
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={!importSupported || importLoading}
              title={
                importSupported
                  ? "Validate PNG, JPEG, still WebP, or rasterize a safe no-network SVG"
                  : "Image import is available in the native desktop app"
              }
              onClick={onImport}
              className="border-emerald-400/20 bg-emerald-400/5 text-emerald-200 hover:bg-emerald-400/10"
            >
              {importLoading ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
              {importLoading ? "Validating…" : "Import images / SVG"}
            </Button>
            {assets.length > 0 ? (
              <div className="relative w-full sm:w-72">
                <Search className="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-slate-600" />
                <Input
                  aria-label="Search media assets"
                  placeholder="Search assets…"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  className="border-slate-800 bg-slate-900/50 pl-9 text-slate-300 placeholder:text-slate-600"
                />
              </div>
            ) : null}
          </div>
        </div>

        {runtimeError ? (
          <div className="mt-4 rounded-xl border border-rose-500/20 bg-rose-500/8 px-4 py-3 text-xs text-rose-200">
            {runtimeError}
          </div>
        ) : null}
        {exportNotice ? (
          <div
            role="status"
            className="mt-4 rounded-xl border border-emerald-400/20 bg-emerald-400/8 px-4 py-3 text-xs text-emerald-200"
          >
            {exportNotice}
          </div>
        ) : null}
        {deletionNotice ? (
          <div
            role="status"
            className="mt-4 rounded-xl border border-sky-400/20 bg-sky-400/8 px-4 py-3 text-xs text-sky-200"
          >
            {deletionNotice}
          </div>
        ) : null}

        {assets.length === 0 ? (
          <div className="mt-6 flex min-h-64 flex-col items-center justify-center rounded-2xl border border-dashed border-slate-800 px-6 text-center">
            <ImageIcon className="h-6 w-6 text-slate-600" />
            <h2 className="mt-3 text-sm font-medium text-slate-300">No assets yet</h2>
          </div>
        ) : (
          <section aria-label="Published assets" className="mt-6">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-xs font-semibold text-slate-300">Assets</h2>
              <span aria-live="polite" className="text-[10px] text-slate-600">
                {filteredAssets.length} of {assets.length} records
              </span>
            </div>
            <div className={cn("grid items-start gap-4", selectedAsset && "lg:grid-cols-[minmax(0,1fr)_340px]") }>
              <div className="grid min-w-0 gap-4 sm:grid-cols-2 2xl:grid-cols-3">
                {filteredAssets.map((asset, assetIndex) => {
                  const selected = asset.id === selectedAssetId;
                  const missingSourceCount = asset.sourceAssetIds.filter(
                    (sourceId) => !activeAssetIds.has(sourceId),
                  ).length;
                  return (
                    <AssetCardContextMenu
                      key={asset.id}
                      asset={asset}
                      chatWorkspaceAvailable={chatWorkspaceAvailable}
                      exportLoading={exportLoading}
                      qualityLoading={qualityLoadingAssetId === asset.id}
                      onPreview={setPreviewAssetId}
                      onInspect={setSelectedAssetId}
                      onSendToChat={onSendToChat}
                      onOpenAsFlow={onOpenAsFlow}
                      onAnalyzeQuality={onAnalyzeQuality}
                      onExport={setExportAsset}
                      onRequestDeletion={requestDeletion}
                    >
                      <article
                        data-app-context-menu-trigger=""
                        className={cn(
                          "overflow-hidden rounded-2xl border bg-slate-900/35 transition-colors data-[state=open]:border-sky-400/45 data-[state=open]:ring-1 data-[state=open]:ring-sky-400/15",
                          selected ? "border-sky-400/45 ring-1 ring-sky-400/15" : "border-slate-800 hover:border-slate-700",
                        )}
                      >
                      {asset.kind === "image" || asset.kind === "vector" ? (
                        <button
                          type="button"
                          aria-label={`Preview ${assetDisplayName(asset)}, item ${assetIndex + 1}`}
                          onClick={() => setPreviewAssetId(asset.id)}
                          className="group relative block aspect-[16/9] w-full overflow-hidden border-b border-slate-800 bg-[linear-gradient(135deg,rgba(14,165,233,0.08),rgba(139,92,246,0.08)),repeating-conic-gradient(rgba(148,163,184,0.035)_0_25%,transparent_0_50%)] bg-[length:auto,24px_24px] outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sky-400/60"
                        >
                          <AssetPreview
                            asset={asset}
                            fit={asset.kind === "vector" ? "contain" : "cover"}
                          />
                          <span className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-end gap-1 bg-slate-950/75 px-3 py-2 text-[9px] font-medium text-slate-300 opacity-80 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
                            <Maximize2 className="h-3 w-3" /> Preview
                          </span>
                        </button>
                      ) : (
                        <div className="aspect-[16/9] overflow-hidden border-b border-slate-800 bg-[linear-gradient(135deg,rgba(14,165,233,0.08),rgba(139,92,246,0.08)),repeating-conic-gradient(rgba(148,163,184,0.035)_0_25%,transparent_0_50%)] bg-[length:auto,24px_24px]">
                          <div className="flex h-full flex-col items-center justify-center bg-[radial-gradient(circle_at_center,rgba(251,191,36,0.10),transparent_60%)] text-center">
                            <FileJson className="h-8 w-8 text-amber-300/70" />
                            <span className="mt-2 text-[9px] font-semibold tracking-[0.14em] text-amber-200/60 uppercase">
                              {qualityOperation(asset)?.verdict ?? "quality"} report
                            </span>
                          </div>
                        </div>
                      )}
                      <button
                        type="button"
                        aria-pressed={selected}
                        aria-label={`Select ${assetProvenance(asset)} asset ${assetDisplayName(asset)}, item ${assetIndex + 1}`}
                        onClick={() => setSelectedAssetId(selected ? null : asset.id)}
                        className="block w-full p-4 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sky-400/60"
                      >
                        <div className="truncate text-xs font-semibold text-slate-200">
                          {assetDisplayName(asset)}
                        </div>
                        <dl
                          className={cn(
                            "mt-3 grid gap-x-3 text-[10px]",
                            asset.kind === "image" || asset.kind === "vector"
                              ? "grid-cols-4"
                              : "grid-cols-3",
                          )}
                        >
                          <div className="min-w-0">
                            <dt className="text-slate-600">
                              {asset.kind === "report" ? "Profile" : "Dimensions"}
                            </dt>
                            <dd className="mt-0.5 truncate text-slate-400">
                              {asset.kind === "report"
                                ? qualityOperation(asset)?.profileId ?? "Unknown"
                                : `${asset.width} × ${asset.height}`}
                            </dd>
                          </div>
                          <div className="min-w-0">
                            <dt className="text-slate-600">Size</dt>
                            <dd className="mt-0.5 truncate text-slate-400">
                              {formatBytes(asset.byteSize)}
                            </dd>
                          </div>
                          <div className="min-w-0">
                            <dt className="text-slate-600">Type</dt>
                            <dd className="mt-0.5 truncate text-slate-400">
                              {formatMediaType(asset.mimeType)}
                            </dd>
                          </div>
                          {asset.kind === "image" || asset.kind === "vector" ? (
                            <div className="min-w-0">
                              <dt className="text-slate-600">Aspect ratio</dt>
                              <dd className="mt-0.5 truncate text-slate-400">
                                {formatAspectRatio(asset.width, asset.height)}
                              </dd>
                            </div>
                          ) : null}
                        </dl>
                        {missingSourceCount > 0 ? (
                          <p className="mt-2 flex items-center gap-1 text-[9px] text-amber-300/70">
                            <AlertTriangle className="h-3 w-3" /> {missingSourceCount} deleted source tombstone{missingSourceCount === 1 ? "" : "s"}
                          </p>
                        ) : asset.sourceAssetIds.length > 0 ? (
                          <p className="mt-2 flex items-center gap-1 text-[9px] text-sky-300/60">
                            <Boxes className="h-3 w-3" /> Derived from {asset.sourceAssetIds.length} source
                          </p>
                        ) : null}
                        {asset.tags.length > 0 ? (
                          <p className="mt-2 truncate text-[8px] text-slate-500">
                            {asset.tags.slice(0, 3).map((tag) => tag.label).join(" · ")}
                            {asset.tags.length > 3 ? ` · +${asset.tags.length - 3}` : ""}
                          </p>
                        ) : null}
                      </button>
                      </article>
                    </AssetCardContextMenu>
                  );
                })}
                {filteredAssets.length === 0 ? (
                  <div className="col-span-full rounded-2xl border border-dashed border-slate-800 px-5 py-12 text-center text-xs text-slate-600">
                    No assets match “{query.trim()}”.
                  </div>
                ) : null}
              </div>
              {selectedAsset?.kind === "image" ? (
                <TransformInspector
                  key={selectedAsset.id}
                  asset={selectedAsset}
                  runtimeMode={runtimeStatus?.mode ?? null}
                  loading={transformLoading}
                  exportLoading={exportLoading}
                  qualityLoading={
                    qualityLoadingAssetId === selectedAsset.id ||
                    qualityLoadingAssetId === latestQualityReportAsset?.id
                  }
                  qualityReportAssetId={latestQualityReportAsset?.id ?? null}
                  qualityReport={
                    latestQualityReportAsset
                      ? qualityReports[latestQualityReportAsset.id] ?? null
                      : null
                  }
                  tagLoading={tagLoadingAssetId === selectedAsset.id}
                  missingSourceAssetIds={selectedMissingSourceAssetIds}
                  onSelectSource={setSelectedAssetId}
                  onTransform={onTransform}
                  onExport={setExportAsset}
                  onAnalyzeQuality={onAnalyzeQuality}
                  onLoadQualityReport={onLoadQualityReport}
                  onUpdateTags={onUpdateTags}
                  onAutoTag={onAutoTag}
                  onRequestDeletion={requestDeletion}
                  chatWorkspaceAvailable={chatWorkspaceAvailable}
                  onSendToChat={onSendToChat}
                  onOpenAsFlow={onOpenAsFlow}
                  onOpenBackgroundRemovalAsFlow={onOpenBackgroundRemovalAsFlow}
                  onOpenAlphaMatteAsFlow={onOpenAlphaMatteAsFlow}
                  onRequestCompositeBackground={setCompositeForeground}
                  onOpenTransformAsFlow={onOpenTransformAsFlow}
                />
              ) : selectedAsset ? (
                <QualityReportInspector
                  key={selectedAsset.id}
                  asset={selectedAsset}
                  report={qualityReports[selectedAsset.id] ?? null}
                  sourceAsset={selectedSourceAsset}
                  loading={
                    qualityLoadingAssetId === selectedAsset.id ||
                    qualityLoadingAssetId === selectedSourceAsset?.id
                  }
                  tagLoading={tagLoadingAssetId === selectedAsset.id}
                  missingSourceAssetIds={selectedMissingSourceAssetIds}
                  onLoad={onLoadQualityReport}
                  onAnalyze={onAnalyzeQuality}
                  onUpdateTags={onUpdateTags}
                  onAutoTag={onAutoTag}
                  onRequestDeletion={requestDeletion}
                />
              ) : null}
            </div>
          </section>
        )}
        <AssetPreviewDialog
          asset={previewAsset}
          onOpenChange={(open) => {
            if (!open) {
              setPreviewAssetId(null);
            }
          }}
        />
        <AssetDeletionDialog
          asset={deletionAsset}
          impact={deletionImpact}
          loading={deletionLoading}
          onOpenChange={(open) => {
            if (!open && !deletionLoading) {
              setDeletionAsset(null);
              setDeletionImpact(null);
            }
          }}
          onConfirm={confirmDeletion}
        />
        <AssetExportDialog
          asset={exportAsset}
          supported={exportSupported}
          loading={exportLoading}
          onOpenChange={(open) => {
            if (!open && !exportLoading) {
              setExportAsset(null);
            }
          }}
          onConfirm={(mode) => {
            if (exportAsset && !exportLoading) {
              onExport(exportAsset, mode);
              setExportAsset(null);
            }
          }}
        />
        <Dialog
          open={Boolean(compositeForeground)}
          onOpenChange={(open) => {
            if (!open) setCompositeForeground(null);
          }}
        >
          <DialogContent className="border-slate-800 bg-slate-950 text-slate-100 sm:max-w-xl">
            <DialogHeader>
              <DialogTitle>Choose composite background</DialogTitle>
              <DialogDescription className="text-slate-400">
                The selected foreground keeps its immutable source edge. The background
                defines the output canvas; fit and opacity remain editable in Flow.
              </DialogDescription>
            </DialogHeader>
            <div className="max-h-[50vh] space-y-2 overflow-y-auto pr-1">
              {compositeBackgrounds.length > 0 ? (
                compositeBackgrounds.map((candidate) => (
                  <button
                    key={candidate.id}
                    type="button"
                    aria-label={`Use ${assetDisplayName(candidate)} ${candidate.digest.slice(0, 12)} as composite background`}
                    onClick={() => {
                      if (compositeForeground) {
                        onOpenCompositeAsFlow(compositeForeground, candidate);
                        setCompositeForeground(null);
                      }
                    }}
                    className="flex w-full items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-900/70 px-3 py-2.5 text-left hover:border-fuchsia-400/30 hover:bg-fuchsia-400/5"
                  >
                    <span>
                      <span className="block text-xs font-medium text-slate-200">
                        {assetDisplayName(candidate)}
                      </span>
                      <span className="mt-0.5 block text-[10px] text-slate-500">
                        {candidate.width} × {candidate.height} · {candidate.mimeType}
                      </span>
                    </span>
                    <span className="font-mono text-[9px] text-slate-600">
                      {candidate.digest.slice(0, 12)}
                    </span>
                  </button>
                ))
              ) : (
                <p className="rounded-xl border border-dashed border-slate-800 px-3 py-5 text-center text-xs text-slate-500">
                  Add another image asset to use as the background.
                </p>
              )}
            </div>
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline">
                  Cancel
                </Button>
              </DialogClose>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        <Dialog
          open={contactSheetOpen}
          onOpenChange={(open) => {
            setContactSheetOpen(open);
            if (!open) setContactSheetAssetIds([]);
          }}
        >
          <DialogContent className="border-slate-800 bg-slate-950 text-slate-100 sm:max-w-2xl">
            <DialogHeader>
              <DialogTitle>Build contact sheet</DialogTitle>
              <DialogDescription className="text-slate-400">
                Choose two to eight images in the order they should appear. Cell size,
                columns, labels, gap, and background remain editable in Flow.
              </DialogDescription>
            </DialogHeader>
            <div className="flex items-center justify-between gap-3 text-[10px] text-slate-500">
              <span aria-live="polite">
                {contactSheetAssetIds.length} selected · 2 minimum · 8 maximum
              </span>
              <span>Selection order becomes source lineage order</span>
            </div>
            <div
              className="grid max-h-[50vh] grid-cols-1 gap-2 overflow-y-auto pr-1 sm:grid-cols-2"
              aria-label="Contact sheet images"
            >
              {contactSheetCandidates.map((candidate) => {
                const selectionIndex = contactSheetAssetIds.indexOf(candidate.id);
                const selected = selectionIndex >= 0;
                const atLimit = contactSheetAssetIds.length >= 8;
                return (
                  <button
                    key={candidate.id}
                    type="button"
                    aria-pressed={selected}
                    aria-label={`${selected ? "Remove" : "Select"} ${assetDisplayName(candidate)} ${candidate.digest.slice(0, 12)} ${selected ? "from" : "for"} contact sheet`}
                    disabled={!selected && atLimit}
                    onClick={() => {
                      setContactSheetAssetIds((current) =>
                        current.includes(candidate.id)
                          ? current.filter((assetId) => assetId !== candidate.id)
                          : current.length < 8
                            ? [...current, candidate.id]
                            : current,
                      );
                    }}
                    className={cn(
                      "flex w-full items-center justify-between gap-3 rounded-xl border px-3 py-2.5 text-left outline-none transition focus-visible:ring-2 focus-visible:ring-sky-300/60 disabled:cursor-not-allowed disabled:opacity-40",
                      selected
                        ? "border-sky-300/60 bg-sky-400/10"
                        : "border-slate-800 bg-slate-900/70 hover:border-sky-400/30 hover:bg-sky-400/5",
                    )}
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-xs font-medium text-slate-200">
                        {assetDisplayName(candidate)}
                      </span>
                      <span className="mt-0.5 block text-[10px] text-slate-500">
                        {candidate.width} × {candidate.height} · {candidate.mimeType}
                      </span>
                    </span>
                    <span className="shrink-0 text-right">
                      {selected ? (
                        <span className="block text-[9px] font-semibold text-sky-200">
                          Position {selectionIndex + 1}
                        </span>
                      ) : null}
                      <span className="block font-mono text-[9px] text-slate-600">
                        {candidate.digest.slice(0, 12)}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline">
                  Cancel
                </Button>
              </DialogClose>
              <Button
                type="button"
                disabled={selectedContactSheetAssets.length < 2}
                onClick={() => {
                  onOpenContactSheetAsFlow(selectedContactSheetAssets);
                  setContactSheetOpen(false);
                  setContactSheetAssetIds([]);
                }}
                className="bg-sky-300 text-slate-950 hover:bg-sky-200"
              >
                <LayoutGrid className="h-4 w-4" /> Open {selectedContactSheetAssets.length} images as Flow
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
};
