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
} from "lucide-react";
import type { MediaAssetImportResult } from "../../../../core/media/contracts.js";
import {
  civitaiFileSize,
  civitaiModelUrl,
  civitaiVisibleImages,
  type CivitaiStorage,
  type CivitaiInspection,
  type CivitaiModel,
} from "../../../../core/media/civitai.js";
import { SearchableSelect } from "../../components/ui/searchable-select";
import { Button } from "../../components/ui/button";
import { copyText } from "../../lib/clipboard";
import { civitaiRuntime } from "../civitai-runtime";
import { enqueueCivitaiDownload } from "../civitai-download-queue";
import { mediaImportQueue } from "../media-import-queue";

export interface CivitaiImportActions {
  onImportSampleUrl: (url: string) => Promise<MediaAssetImportResult | null>;
}

export function CivitaiModelDetail({
  model,
  initialVersionId,
  mature,
  installedHashes,
  onBack,
  onOpenSettings,
  connectionRevision,
  onImportSampleUrl,
}: CivitaiImportActions & {
  model: CivitaiModel;
  initialVersionId: number | null;
  mature: boolean;
  installedHashes: ReadonlySet<string>;
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
  const [inspection, setInspection] = useState<CivitaiInspection | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [storage, setStorage] = useState<CivitaiStorage | null>(null);
  const jobs = useSyncExternalStore(
    mediaImportQueue.subscribe,
    mediaImportQueue.getSnapshot,
  );
  const queued = jobs.some(
    (job) =>
      job.downloadKey === file?.hashes?.SHA256?.toLowerCase() &&
      job.downloadKey &&
      !["failed", "cancelled"].includes(job.status),
  );
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
  const installed = file?.hashes?.SHA256
    ? installedHashes.has(file.hashes.SHA256.toLowerCase())
    : false;

  useEffect(() => {
    let active = true;
    setInspection(null);
    setStorage(null);
    setError(null);
    if (!file) {
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
  }, [source, file?.id, retry, connectionRevision]);

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
      queued ||
      !storage ||
      storage.blockingReason ||
      inspection.file?.id !== file.id ||
      inspection.versionId !== version?.id
    )
      return;
    enqueueCivitaiDownload({
      label: `${model.name} · ${version?.name ?? inspection.versionName}`,
      source,
      inspection,
      images,
    });
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
      <div className="grid min-w-0 gap-6 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="min-w-0 space-y-3">
          <div className="flex aspect-[4/3] max-h-[34vh] md:aspect-[4/5] md:max-h-[52vh] items-center justify-center overflow-hidden rounded-xl bg-slate-900">
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
              ) : (
                <Download className="h-4 w-4" />
              )}
              {savedPreviews.includes(preview.url)
                ? "Preview saved"
                : "Save preview"}
            </Button>
          )}
          {preview?.meta?.prompt && (
            <details className="rounded-lg border border-slate-800 p-3 text-sm">
              <summary className="cursor-pointer text-slate-300">
                Preview prompt
              </summary>
              <p className="mt-3 max-h-40 overflow-y-auto whitespace-pre-wrap text-slate-400">
                {preview.meta.prompt}
              </p>
              <Button
                variant="ghost"
                size="sm"
                className="mt-2"
                onClick={() => void copy(preview.meta!.prompt!, "prompt")}
              >
                {copied === "prompt" ? (
                  <Check className="h-4 w-4" />
                ) : (
                  <Copy className="h-4 w-4" />
                )}{" "}
                Copy prompt
              </Button>
            </details>
          )}
        </div>
        <div className="min-w-0 space-y-4">
          <div>
            <h2 className="text-xl font-semibold text-slate-100">
              {model.name}
            </h2>
            <p className="mt-1 text-sm text-slate-400">
              {[
                model.type === "TextualInversion" ? "Embedding" : model.type,
                model.creator?.username,
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
          </div>
          <label className="grid gap-1.5 text-xs text-slate-400">
            Version
            <SearchableSelect
              label="Version"
              value={String(version?.id ?? "")}

              options={model.modelVersions.map((item) => ({
                value: String(item.id),
                label: item.name,
              }))}
              onChange={(value) => {
                setVersionId(Number(value));
                setFileId(null);
                setPreviewIndex(0);
              }}
            />
          </label>
          {files.length > 0 && (
            <label className="grid gap-1.5 text-xs text-slate-400">
              File
              <SearchableSelect
                label="File"
                value={String(file?.id ?? "")}

                options={files.map((item) => ({
                  value: String(item.id),
                  label: `${item.name} \u00b7 ${civitaiFileSize(item.sizeKB * 1024)}`,
                }))}
                onChange={(value) => setFileId(Number(value))}
              />
            </label>
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
          {description && (
            <details className="text-sm text-slate-400">
              <summary className="cursor-pointer">About this model</summary>
              <p className="mt-3 max-h-56 overflow-y-auto whitespace-pre-line">
                {description}
              </p>
            </details>
          )}
          {model.tags.length > 0 && (
            <p className="text-xs leading-6 text-slate-400">
              {model.tags.slice(0, 12).join(" · ")}
            </p>
          )}
          {file && (
            <details className="text-xs text-slate-400">
              <summary className="cursor-pointer">File details</summary>
              <dl className="mt-3 space-y-2">
                <div>
                  <dt>Format</dt>
                  <dd className="text-slate-200">
                    {[
                      file.metadata?.format,
                      file.metadata?.fp,
                      file.metadata?.size,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </dd>
                </div>
                <div>
                  <dt>SHA-256</dt>
                  <dd className="break-all font-mono text-[11px]">
                    {file.hashes?.SHA256 ?? "Not provided"}
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
                )}{" "}
                Copy link
              </Button>
            </details>
          )}
          {model.type === "Checkpoint" &&
            version?.baseModel === "Wan Video 2.2 TI2V-5B" && (
              <p className="text-sm text-slate-400">
                Also downloads 13.2 GB of model components.
              </p>
            )}
          {inspection?.licenseClaims && (
            <details className="text-xs text-slate-400">
              <summary className="cursor-pointer">
                Publisher permissions
              </summary>
              <dl className="mt-3 grid grid-cols-2 gap-2">
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
          {error && (
            <div
              role="alert"
              className="space-y-2 rounded-lg border border-rose-500/25 bg-rose-500/5 p-3 text-sm text-rose-200"
            >
              <p>{error}</p>
              {/API key|access|401|403/i.test(error) && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={onOpenSettings}
                >
                  Open settings
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={() => setRetry((value) => value + 1)}
              >
                Retry
              </Button>
            </div>
          )}
          {!files.length ? (
            <p className="text-sm text-slate-400">
              No downloadable files in this version.
            </p>
          ) : inspection && !inspection.canDownload ? (
            <p className="text-sm text-amber-200">
              {inspection.blockingReason}
              {/API key|access/i.test(inspection.blockingReason ?? "") && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={onOpenSettings}
                >
                  Open settings
                </Button>
              )}
            </p>
          ) : null}
        </div>
      </div>
      <div className="sticky -bottom-4 -mx-4 border-t border-slate-800 bg-slate-950 px-4 py-3 sm:-bottom-5 sm:-mx-5 sm:px-5">
        {!queued && storage?.blockingReason ? (
          <div className="mb-3 space-y-2">
            <p role="alert" className="text-sm text-rose-300">
              {storage.blockingReason}
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setRetry((value) => value + 1)}
            >
              Check space again
            </Button>
          </div>
        ) : !queued && storage?.warning ? (
          <p role="status" className="mb-3 text-sm text-amber-200">
            {storage.warning}
          </p>
        ) : null}
        <Button
          className="w-full"
          disabled={
            installed ||
            queued ||
            inspecting ||
            !inspection?.canDownload ||
            !storage ||
            Boolean(storage.blockingReason)
          }
          onClick={download}
        >
          {inspecting ? (
            <LoaderCircle className="h-4 w-4 animate-spin" />
          ) : installed ? (
            <Check className="h-4 w-4" />
          ) : (
            <Download className="h-4 w-4" />
          )}
          {installed
            ? "In library"
            : inspecting
              ? "Checking file…"
              : queued
                ? "In download queue"
                : `Download & import${file ? ` · ${civitaiFileSize(file.sizeKB * 1024)}` : ""}`}
        </Button>
      </div>
    </div>
  );
}
