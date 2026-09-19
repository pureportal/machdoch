import { useEffect, useMemo, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  ArrowLeft,
  Check,
  Copy,
  Download,
  ExternalLink,
  ImageOff,
  LoaderCircle,
} from "lucide-react";
import type {
  MediaAssetImportResult,
  ImportMediaLocalModelRequest,
  ImportMediaModelAddonRequest,
  MediaGenerationAssetMetadata,
} from "../../../../core/media/contracts.js";
import {
  civitaiFileSize,
  civitaiImportMetadata,
  civitaiImportArchitecture,
  civitaiModelUrl,
  civitaiVisibleImages,
  type CivitaiDownloadProgress,
  type CivitaiInspection,
  type CivitaiModel,
} from "../../../../core/media/civitai.js";
import { parseMediaTriggerWords } from "../../../../core/media/asset-metadata.js";
import { Button } from "../../components/ui/button";
import { copyText } from "../../lib/clipboard";
import { civitaiRuntime } from "../civitai-runtime";

export interface CivitaiImportActions {
  onImportSampleUrl: (url: string) => Promise<MediaAssetImportResult | null>;
  onImportModel: (
    request: ImportMediaLocalModelRequest,
    metadata: MediaGenerationAssetMetadata,
  ) => Promise<boolean>;
  onImportAddon: (
    request: ImportMediaModelAddonRequest,
    metadata: MediaGenerationAssetMetadata,
  ) => Promise<boolean>;
}

const fieldClass =
  "h-10 w-full min-w-0 rounded-lg border border-slate-700 bg-slate-900 px-3 text-sm text-slate-100";

export function CivitaiModelDetail({
  model,
  initialVersionId,
  mature,
  installedHashes,
  onBack,
  onBusyChange,
  onImported,
  onImportModel,
  onImportAddon,
  onImportSampleUrl,
}: CivitaiImportActions & {
  model: CivitaiModel;
  initialVersionId: number | null;
  mature: boolean;
  installedHashes: ReadonlySet<string>;
  onBack: () => void;
  onBusyChange: (busy: boolean) => void;
  onImported: () => void;
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
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [progress, setProgress] = useState<CivitaiDownloadProgress | null>(
    null,
  );
  const [previewIndex, setPreviewIndex] = useState(0);
  const [savingPreview, setSavingPreview] = useState(false);
  const [savedPreviews, setSavedPreviews] = useState<string[]>([]);
  const [copied, setCopied] = useState<string | null>(null);
  const operation = useRef<string | null>(null);
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
    setError(null);
    if (!file) {
      setInspecting(false);
      return;
    }
    setInspecting(true);
    void civitaiRuntime
      .inspect(source, file.id)
      .then((value) => {
        if (active) setInspection(value);
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
  }, [source, file?.id, retry]);

  const copy = async (value: string, label: string) => {
    try {
      await copyText(value);
      setCopied(label);
    } catch (failure) {
      setError((failure as Error).message);
    }
  };

  const download = async () => {
    if (
      !inspection?.canDownload ||
      !file ||
      busy ||
      inspection.file?.id !== file.id ||
      inspection.versionId !== version?.id
    )
      return;
    const operationId = crypto.randomUUID();
    operation.current = operationId;
    setBusy(true);
    onBusyChange(true);
    setError(null);
    setProgress(null);
    setCancelling(false);
    let unlisten: (() => void) | undefined;
    try {
      unlisten = await civitaiRuntime.progress((value) => {
        if (value.operationId === operationId) setProgress(value);
      });
      const downloaded = await civitaiRuntime.download(
        source,
        file.id,
        inspection.reviewToken,
        operationId,
      );
      const local = downloaded.model ?? downloaded.addon;
      if (!local?.canImport)
        throw new Error(
          local?.blockingReason ?? "This file cannot be imported.",
        );
      const architecture = civitaiImportArchitecture(
        local.detectedArchitecture,
        downloaded.metadata.suggestedArchitecture,
      );
      if (!architecture)
        throw new Error(
          "The model architecture could not be identified. Import the file locally to choose its architecture.",
        );
      const metadata = civitaiImportMetadata(downloaded.metadata, images);
      const common = {
        sourcePath: local.sourcePath,
        reviewToken: local.reviewToken,
        displayName: `${model.name} · ${version?.name ?? downloaded.metadata.versionName}`,
        architecture,
        sourceUrl: downloaded.metadata.sourceUrl,
        licenseName: null,
        commercialUse: null,
      };
      const words = parseMediaTriggerWords(metadata.triggerWords);
      const accepted = downloaded.model
        ? await onImportModel(common, metadata)
        : await onImportAddon(
            {
              ...common,
              kind: downloaded.addon!.detectedKind!,
              triggerWords: words,
              token:
                downloaded.addon!.detectedKind === "textual-inversion"
                  ? (downloaded.addon!.suggestedToken ?? words[0] ?? null)
                  : null,
            },
            metadata,
          );
      if (accepted) onImported();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      unlisten?.();
      operation.current = null;
      setBusy(false);
      onBusyChange(false);
      setCancelling(false);
    }
  };

  const cancel = async () => {
    if (!operation.current) return;
    setCancelling(true);
    try {
      await civitaiRuntime.cancel(operation.current);
    } catch (failure) {
      setError((failure as Error).message);
      setCancelling(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button variant="ghost" size="sm" onClick={onBack} disabled={busy}>
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
            <select
              className={fieldClass}
              aria-label="Version"
              value={version?.id ?? ""}
              disabled={busy}
              onChange={(event) => {
                setVersionId(Number(event.target.value));
                setFileId(null);
                setPreviewIndex(0);
                setCopied(null);
              }}
            >
              {model.modelVersions.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                  {item.baseModel ? ` · ${item.baseModel}` : ""}
                </option>
              ))}
            </select>
          </label>
          {files.length > 0 && (
            <label className="grid gap-1.5 text-xs text-slate-400">
              File
              <select
                className={fieldClass}
                aria-label="File"
                value={file?.id ?? ""}
                disabled={busy}
                onChange={(event) => setFileId(Number(event.target.value))}
              >
                {files.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name} · {civitaiFileSize(item.sizeKB * 1024)}
                  </option>
                ))}
              </select>
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
              {!busy && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setRetry((value) => value + 1)}
                >
                  Retry
                </Button>
              )}
            </div>
          )}
          {!files.length ? (
            <p className="text-sm text-slate-400">
              No downloadable files in this version.
            </p>
          ) : inspection && !inspection.canDownload ? (
            <p className="text-sm text-amber-200">
              {inspection.blockingReason}
            </p>
          ) : null}
          {busy ? (
            <div className="space-y-2" role="status">
              <div className="flex items-center gap-2 text-sm">
                <LoaderCircle className="h-4 w-4 animate-spin" />
                {cancelling
                  ? "Cancelling…"
                  : progress && progress.received >= progress.total
                    ? "Verifying file…"
                    : "Downloading…"}
              </div>
              <progress
                aria-label="Download progress"
                value={progress?.received ?? 0}
                max={progress?.total || file!.sizeKB * 1024}
                className="h-2 w-full accent-sky-400"
              />
              {progress && (
                <p className="text-xs text-slate-400">
                  {civitaiFileSize(progress.received)} /{" "}
                  {civitaiFileSize(progress.total)}
                </p>
              )}
              <Button
                variant="outline"
                size="sm"
                disabled={cancelling}
                onClick={() => void cancel()}
              >
                Cancel download
              </Button>
            </div>
          ) : (
            <Button
              className="w-full"
              disabled={installed || inspecting || !inspection?.canDownload}
              onClick={() => void download()}
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
                  : `Download & import${file ? ` · ${civitaiFileSize(file.sizeKB * 1024)}` : ""}`}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
