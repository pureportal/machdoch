import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { openUrl } from "../media-platform";
import {
  ArrowLeft,
  Check,
  Copy,
  Download,
  ExternalLink,
  ImageOff,
  LoaderCircle,
  ThumbsUp,
} from "lucide-react";
import type {
  MediaAssetImportResult,
  MediaModelDescriptor,
} from "../../../../core/media/contracts.js";
import {
  civitaiFileSize,
  civitaiModelUrl,
  civitaiTypeLabel,
  civitaiVisibleImages,
  type CivitaiFile,
  type CivitaiInspection,
  type CivitaiModel,
  type CivitaiOptions,
  type CivitaiStorage,
} from "../../../../core/media/civitai.js";
import { mediaModelAcceptsAddonArchitecture } from "../../../../core/media/model-addons.js";
import { SearchableSelect } from "../../components/ui/searchable-select";
import { Button } from "../../components/ui/button";
import { copyText } from "../../lib/clipboard";
import { civitaiRuntime } from "../civitai-runtime";
import { enqueueCivitaiDownload } from "../civitai-download-queue";
import { mediaImportQueue } from "../media-import-queue";
import { CivitaiDownloadAction } from "./civitai-download-action";

export interface CivitaiImportActions {
  onImportSampleUrl: (url: string) => Promise<MediaAssetImportResult | null>;
}

const numberFormat = new Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumFractionDigits: 1,
});

const fileLabel = (file: CivitaiFile): string =>
  [
    file.name,
    file.metadata?.fp,
    file.metadata?.size,
    civitaiFileSize(file.sizeKB * 1024),
  ]
    .filter(Boolean)
    .join(" · ");

export function CivitaiModelDetail({
  model,
  initialVersionId,
  mature,
  options,
  installedHashes,
  installedModels,
  onBack,
  onOpenSettings,
  connectionRevision,
  onImportSampleUrl,
}: CivitaiImportActions & {
  model: CivitaiModel;
  initialVersionId: number | null;
  mature: boolean;
  options: CivitaiOptions;
  installedHashes: ReadonlySet<string>;
  installedModels: readonly MediaModelDescriptor[];
  onBack: () => void;
  onOpenSettings: () => void;
  connectionRevision: number;
}) {
  const [versionId, setVersionId] = useState(
    initialVersionId ?? model.modelVersions[0]?.id,
  );
  const version =
    model.modelVersions.find((item) => item.id === versionId) ??
    model.modelVersions[0];
  const [fileId, setFileId] = useState<number | null>(null);
  const files = version?.files ?? [];
  const file =
    files.find((item) => item.id === fileId) ??
    files.find((item) => item.primary) ??
    files[0];
  const sha256 = file?.hashes?.SHA256?.toLowerCase() ?? null;
  const [inspection, setInspection] = useState<CivitaiInspection | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [storage, setStorage] = useState<CivitaiStorage | null>(null);
  const jobs = useSyncExternalStore(
    mediaImportQueue.subscribe,
    mediaImportQueue.getSnapshot,
  );
  const job = sha256
    ? jobs
        .filter(
          (candidate) =>
            candidate.downloadKey === sha256 &&
            candidate.status !== "cancelled",
        )
        .at(-1)
    : undefined;
  const [previewIndex, setPreviewIndex] = useState(0);
  const [savingPreview, setSavingPreview] = useState(false);
  const [savedPreviews, setSavedPreviews] = useState<string[]>([]);
  const [copied, setCopied] = useState<string | null>(null);
  const images = civitaiVisibleImages(model, version, mature);
  const preview = images[previewIndex] ?? images[0];
  const source = civitaiModelUrl(model, version?.id);
  const description = useMemo(() => {
    const template = document.createElement("template");
    template.innerHTML = model.description ?? "";
    template.content
      .querySelectorAll("script, style, iframe")
      .forEach((element) => element.remove());
    return template.content.textContent?.trim() ?? "";
  }, [model.description]);
  const installed = sha256 ? installedHashes.has(sha256) : false;
  const typeLabel = civitaiTypeLabel(model.type);
  const addonKind =
    model.type === "Checkpoint"
      ? null
      : model.type === "TextualInversion"
        ? "textual-inversion"
        : "lora";
  const addonArchitecture = version?.baseModel
    ? options.baseModelArchitectures[version.baseModel]
    : undefined;
  const usable =
    !addonKind ||
    !addonArchitecture ||
    installedModels.some(
      (candidate) =>
        candidate.addonCapabilities.some(
          (capability) => capability.kind === addonKind,
        ) && mediaModelAcceptsAddonArchitecture(candidate, addonArchitecture),
    );
  const showsBaseModels =
    new Set(model.modelVersions.map((item) => item.baseModel)).size > 1;

  useEffect(() => {
    let active = true;
    setInspection(null);
    setStorage(null);
    setError(null);
    if (!file || installed) {
      setInspecting(false);
      return;
    }
    setInspecting(true);
    void civitaiRuntime
      .inspect(source, file.id)
      .then(async (value) => {
        if (active) setInspection(value);
        if (value.canDownload && value.file) {
          const available = await civitaiRuntime.storage(value.file.byteSize);
          if (active) setStorage(available);
        }
      })
      .catch((failure: Error) => {
        if (active) setError(failure.message);
      })
      .finally(() => {
        if (active) setInspecting(false);
      });
    return () => {
      active = false;
    };
  }, [source, file?.id, installed, retry, connectionRevision]);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(null), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copy = async (value: string, label: string) => {
    try {
      await copyText(value);
      setCopied(label);
    } catch (failure) {
      setError((failure as Error).message);
    }
  };

  const download = () => {
    if (
      !inspection?.canDownload ||
      !file ||
      !storage ||
      storage.blockingReason ||
      inspection.file?.id !== file.id ||
      inspection.versionId !== version?.id
    )
      return;
    try {
      enqueueCivitaiDownload({
        label: `${model.name} · ${version?.name ?? inspection.versionName}`,
        source,
        inspection,
        images,
      });
    } catch (failure) {
      setError((failure as Error).message);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft className="h-4 w-4" /> Results
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            void openUrl(source).catch((failure: Error) =>
              setError(failure.message),
            )
          }
        >
          <ExternalLink className="h-4 w-4" /> View on Civitai
        </Button>
      </div>
      <div className="grid min-w-0 gap-x-6 gap-y-4 md:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] md:grid-rows-[auto_1fr]">
        <div className="min-w-0 space-y-1.5 md:col-start-2 md:row-start-1">
          <h2 className="text-xl font-semibold text-slate-100">{model.name}</h2>
          <p className="text-sm text-slate-400">
            {[typeLabel, version?.baseModel, model.creator?.username]
              .filter(Boolean)
              .join(" · ")}
          </p>
          {model.stats && (
            <p className="flex items-center gap-3 text-xs text-slate-400">
              {model.stats.downloadCount != null && (
                <span className="flex items-center gap-1">
                  <Download className="h-3 w-3" />
                  {numberFormat.format(model.stats.downloadCount)}
                </span>
              )}
              {model.stats.thumbsUpCount != null && (
                <span className="flex items-center gap-1">
                  <ThumbsUp className="h-3 w-3" />
                  {numberFormat.format(model.stats.thumbsUpCount)}
                </span>
              )}
            </p>
          )}
        </div>
        <div className="min-w-0 space-y-3 md:col-start-1 md:row-span-2 md:row-start-1">
          <div className="flex h-[38vh] w-full items-center justify-center overflow-hidden rounded-xl bg-slate-900 md:h-[min(56vh,36rem)]">
            {preview ? (
              <img
                key={preview.url}
                src={preview.url}
                alt={`${model.name} preview ${previewIndex + 1}`}
                className="h-full w-full object-contain"
                referrerPolicy="no-referrer"
              />
            ) : (
              <ImageOff
                className="h-10 w-10 text-slate-600"
                aria-label="No preview"
              />
            )}
          </div>
          {images.length > 1 && (
            <div
              className="flex gap-2 overflow-x-auto pb-1"
              aria-label="Previews"
            >
              {images.map((image, index) => (
                <button
                  key={image.url}
                  type="button"
                  aria-label={`Preview ${index + 1}`}
                  aria-pressed={index === previewIndex}
                  onClick={() => setPreviewIndex(index)}
                  className={`h-16 w-16 shrink-0 overflow-hidden rounded-lg border-2 ${index === previewIndex ? "border-sky-400" : "border-transparent"}`}
                >
                  <img
                    src={image.url}
                    alt=""
                    loading="lazy"
                    referrerPolicy="no-referrer"
                    className="h-full w-full object-cover"
                  />
                </button>
              ))}
            </div>
          )}
          {preview && (
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={savingPreview || savedPreviews.includes(preview.url)}
                onClick={async () => {
                  setSavingPreview(true);
                  setError(null);
                  try {
                    const result = await onImportSampleUrl(preview.url);
                    if (!result)
                      throw new Error("Preview could not be saved. Try again.");
                    setSavedPreviews((values) => [...values, preview.url]);
                  } catch (failure) {
                    setError((failure as Error).message);
                  } finally {
                    setSavingPreview(false);
                  }
                }}
              >
                {savingPreview ? (
                  <LoaderCircle className="h-4 w-4 animate-spin" />
                ) : savedPreviews.includes(preview.url) ? (
                  <Check className="h-4 w-4" />
                ) : (
                  <Download className="h-4 w-4" />
                )}
                {savedPreviews.includes(preview.url)
                  ? "Preview saved"
                  : "Save preview"}
              </Button>
              {preview.meta?.prompt && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void copy(preview.meta!.prompt!, "prompt")}
                >
                  {copied === "prompt" ? (
                    <Check className="h-4 w-4" />
                  ) : (
                    <Copy className="h-4 w-4" />
                  )}
                  Copy prompt
                </Button>
              )}
            </div>
          )}
          {preview?.meta?.prompt && (
            <details className="rounded-lg border border-slate-800 p-3 text-sm">
              <summary className="cursor-pointer text-slate-300">
                Preview prompt
              </summary>
              <p className="mt-3 max-h-40 overflow-y-auto whitespace-pre-wrap text-slate-400">
                {preview.meta.prompt}
              </p>
              {preview.meta.negativePrompt && (
                <p className="mt-3 max-h-24 overflow-y-auto whitespace-pre-wrap text-slate-500">
                  {preview.meta.negativePrompt}
                </p>
              )}
            </details>
          )}
        </div>
        <div className="min-w-0 space-y-4 md:col-start-2 md:row-start-2">
          {model.modelVersions.length > 1 && (
            <label className="grid gap-1.5 text-xs text-slate-400">
              Version
              <SearchableSelect
                label="Version"
                value={String(version?.id ?? "")}
                options={model.modelVersions.map((item) => ({
                  value: String(item.id),
                  label:
                    showsBaseModels && item.baseModel
                      ? `${item.name} · ${item.baseModel}`
                      : item.name,
                }))}
                onChange={(value) => {
                  setVersionId(Number(value));
                  setFileId(null);
                  setPreviewIndex(0);
                }}
              />
            </label>
          )}
          {files.length > 1 && (
            <label className="grid gap-1.5 text-xs text-slate-400">
              File
              <SearchableSelect
                label="File"
                value={String(file?.id ?? "")}
                options={files.map((item) => ({
                  value: String(item.id),
                  label: fileLabel(item),
                }))}
                onChange={(value) => setFileId(Number(value))}
              />
            </label>
          )}
          {!usable && (
            <p role="status" className="text-sm text-amber-200">
              None of your installed models can use this {typeLabel}.
            </p>
          )}
          {version?.trainedWords.length ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <h3 className="text-xs text-slate-400">Trigger words</h3>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label="Copy trigger words"
                  onClick={() =>
                    void copy(version.trainedWords.join(", "), "triggers")
                  }
                >
                  {copied === "triggers" ? (
                    <Check className="h-4 w-4" />
                  ) : (
                    <Copy className="h-4 w-4" />
                  )}
                </Button>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {version.trainedWords.map((word) => (
                  <button
                    key={word}
                    type="button"
                    className="rounded-md bg-sky-400/10 px-2.5 py-1.5 text-left text-xs text-sky-200 hover:bg-sky-400/20"
                    title="Copy trigger word"
                    onClick={() => void copy(word, word)}
                  >
                    {word}
                    {copied === word ? " ✓" : ""}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          {model.type === "Checkpoint" &&
            version?.baseModel === "Wan Video 2.2 TI2V-5B" && (
              <p className="text-sm text-slate-400">
                Also downloads 13.2 GB of model components.
              </p>
            )}
          {model.tags.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {model.tags.slice(0, 12).map((tag) => (
                <span
                  key={tag}
                  className="rounded-md bg-slate-800/70 px-2 py-0.5 text-xs text-slate-300"
                >
                  {tag}
                </span>
              ))}
            </div>
          )}
          <div className="divide-y divide-slate-800 border-y border-slate-800">
            {description && (
              <details className="py-2.5 text-sm text-slate-400">
                <summary className="cursor-pointer hover:text-slate-200">
                  About this model
                </summary>
                <p className="mt-3 max-h-56 overflow-y-auto whitespace-pre-line">
                  {description}
                </p>
              </details>
            )}
            {file && (
              <details className="py-2.5 text-sm text-slate-400">
                <summary className="cursor-pointer hover:text-slate-200">
                  File details
                </summary>
                <dl className="mt-3 space-y-2 text-xs">
                  <div>
                    <dt>File</dt>
                    <dd className="break-all text-slate-200">
                      {fileLabel(file)}
                    </dd>
                  </div>
                  <div>
                    <dt>SHA-256</dt>
                    <dd className="break-all font-mono text-[11px]">
                      {file.hashes?.SHA256}
                    </dd>
                  </div>
                </dl>
                <Button
                  variant="ghost"
                  size="sm"
                  className="mt-2"
                  onClick={() => void copy(source, "link")}
                >
                  {copied === "link" ? (
                    <Check className="h-4 w-4" />
                  ) : (
                    <Copy className="h-4 w-4" />
                  )}
                  Copy link
                </Button>
              </details>
            )}
            {inspection?.licenseClaims && (
              <details className="py-2.5 text-sm text-slate-400">
                <summary className="cursor-pointer hover:text-slate-200">
                  Publisher permissions
                </summary>
                <dl className="mt-3 grid grid-cols-2 gap-2 text-xs">
                  <dt>Commercial use</dt>
                  <dd>
                    {inspection.licenseClaims.allowCommercialUse?.join(", ") ??
                      "Not specified"}
                  </dd>
                  <dt>Derivatives</dt>
                  <dd>
                    {inspection.licenseClaims.allowDerivatives === null
                      ? "Not specified"
                      : inspection.licenseClaims.allowDerivatives
                        ? "Yes"
                        : "No"}
                  </dd>
                  <dt>Credit required</dt>
                  <dd>
                    {inspection.licenseClaims.allowNoCredit === null
                      ? "Not specified"
                      : inspection.licenseClaims.allowNoCredit
                        ? "No"
                        : "Yes"}
                  </dd>
                </dl>
              </details>
            )}
          </div>
        </div>
      </div>
      <CivitaiDownloadAction
        fileSize={file ? file.sizeKB * 1024 : null}
        installed={installed}
        inspecting={inspecting}
        inspection={inspection}
        storage={storage}
        error={error}
        job={job}
        onDownload={download}
        onRetry={() => setRetry((value) => value + 1)}
        onOpenSettings={onOpenSettings}
      />
    </div>
  );
}
