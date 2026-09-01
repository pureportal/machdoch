import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Check, ImagePlus, Link, LoaderCircle, X } from "lucide-react";
import { useState, type ClipboardEvent, type DragEvent, type JSX } from "react";
import { normalizeMediaExternalLink } from "../../../../core/media/asset-metadata.js";
import type {
  MediaAssetRecord,
  MediaCivitaiSampleImage,
} from "../../../../core/media/contracts.js";
import { saveClipboardImageAttachment } from "../../runtime";
import { Button } from "../../components/ui/button";
import { cn } from "../../lib/utils";
import { MediaAssetPreview } from "./media-visual-preview";

const MAX_SAMPLE_IMAGES = 12;
const SAMPLE_IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp"];

interface MediaSampleImagesInputProps {
  assets: readonly MediaAssetRecord[];
  sampleAssetIds: string[];
  sampleImages: MediaCivitaiSampleImage[];
  disabled: boolean;
  onChange: (
    sampleAssetIds: string[],
    sampleImages: MediaCivitaiSampleImage[],
  ) => void;
  onImportPaths: (paths: string[]) => Promise<string[]>;
  onDownloadUrl: (url: string) => Promise<string | null>;
}

const uniqueLimited = (values: readonly string[]): string[] =>
  [...new Set(values)].slice(0, MAX_SAMPLE_IMAGES);

const droppedUrl = (dataTransfer: DataTransfer): string | null => {
  const candidate =
    dataTransfer
      .getData("text/uri-list")
      .split(/\r?\n/u)
      .map((value) => value.trim())
      .find((value) => value && !value.startsWith("#")) ??
    dataTransfer.getData("text/plain");
  return normalizeMediaExternalLink(candidate.trim());
};

export const MediaSampleImagesInput = ({
  assets,
  sampleAssetIds,
  sampleImages,
  disabled,
  onChange,
  onImportPaths,
  onDownloadUrl,
}: MediaSampleImagesInputProps): JSX.Element => {
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");
  const [pending, setPending] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const imageAssets = assets.filter(
    (asset) => asset.kind === "image" || asset.kind === "vector",
  );
  const selectedAssets = sampleAssetIds.flatMap((assetId) => {
    const asset = imageAssets.find((candidate) => candidate.id === assetId);
    return asset ? [asset] : [];
  });
  const sampleCount = sampleAssetIds.length + sampleImages.length;

  const addImportedIds = (assetIds: string[]): void => {
    const maximumAssetIds = Math.max(
      0,
      MAX_SAMPLE_IMAGES - sampleImages.length,
    );
    const nextIds = uniqueLimited([...sampleAssetIds, ...assetIds]).slice(
      0,
      maximumAssetIds,
    );
    onChange(nextIds, sampleImages);
  };

  const importPaths = async (paths: string[]): Promise<void> => {
    const availablePaths = paths.slice(
      0,
      Math.max(0, MAX_SAMPLE_IMAGES - sampleCount),
    );
    if (availablePaths.length === 0 || disabled || pending) return;
    setPending(true);
    setError(null);
    try {
      addImportedIds(await onImportPaths(availablePaths));
    } catch (importError: unknown) {
      setError(
        importError instanceof Error
          ? importError.message
          : "The sample images could not be added.",
      );
    } finally {
      setPending(false);
    }
  };

  const importFiles = async (files: File[]): Promise<void> => {
    if (disabled || pending) return;
    const remaining = MAX_SAMPLE_IMAGES - sampleCount;
    const images = files
      .filter((file) => file.type.startsWith("image/"))
      .slice(0, remaining);
    if (images.length === 0) {
      if (remaining > 0) {
        setError("Drop or paste PNG, JPEG, or WebP images.");
      }
      return;
    }
    setPending(true);
    setError(null);
    try {
      const paths = await Promise.all(
        images.map((file) =>
          saveClipboardImageAttachment({ blob: file, fileName: file.name }),
        ),
      );
      addImportedIds(await onImportPaths(paths));
    } catch (importError: unknown) {
      setError(
        importError instanceof Error
          ? importError.message
          : "The sample images could not be added.",
      );
    } finally {
      setPending(false);
    }
  };

  const chooseImages = async (): Promise<void> => {
    setError(null);
    try {
      const selected = await openDialog({
        title: "Add sample images",
        multiple: true,
        directory: false,
        filters: [{ name: "Images", extensions: SAMPLE_IMAGE_EXTENSIONS }],
      });
      const paths = Array.isArray(selected)
        ? selected
        : typeof selected === "string"
          ? [selected]
          : [];
      await importPaths(paths);
    } catch (pickerError: unknown) {
      setError(
        pickerError instanceof Error
          ? pickerError.message
          : "The image picker could not be opened.",
      );
    }
  };

  const downloadUrl = async (url: string): Promise<void> => {
    if (disabled || pending || sampleCount >= MAX_SAMPLE_IMAGES) return;
    const normalized = normalizeMediaExternalLink(url);
    if (!normalized) {
      setError("Enter an HTTPS image URL.");
      return;
    }
    setPending(true);
    setError(null);
    try {
      const assetId = await onDownloadUrl(normalized);
      if (!assetId) throw new Error("The image could not be downloaded.");
      addImportedIds([assetId]);
      setLinkUrl("");
    } catch (downloadError: unknown) {
      setError(
        downloadError instanceof Error
          ? downloadError.message
          : "The image could not be downloaded.",
      );
    } finally {
      setPending(false);
    }
  };

  const handlePaste = (event: ClipboardEvent<HTMLDivElement>): void => {
    const files = Array.from(event.clipboardData.files);
    if (files.length > 0) {
      event.preventDefault();
      void importFiles(files);
      return;
    }
    const url = droppedUrl(event.clipboardData);
    if (!url) return;
    event.preventDefault();
    void downloadUrl(url);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault();
    setDragActive(false);
    const files = Array.from(event.dataTransfer.files);
    if (files.length > 0) {
      void importFiles(files);
      return;
    }
    const url = droppedUrl(event.dataTransfer);
    if (url) void downloadUrl(url);
  };

  return (
    <div className="space-y-2 sm:col-span-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-slate-400">Sample images</span>
        <div className="flex gap-1">
          {imageAssets.length > 0 ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setLibraryOpen((open) => !open)}
              disabled={disabled || pending}
            >
              Library
            </Button>
          ) : null}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void chooseImages()}
            disabled={disabled || pending || sampleCount >= MAX_SAMPLE_IMAGES}
          >
            <ImagePlus className="h-4 w-4" /> Add images
          </Button>
        </div>
      </div>

      <div
        role="group"
        tabIndex={0}
        aria-label="Drop or paste sample images"
        onPaste={handlePaste}
        onDragEnter={(event) => {
          event.preventDefault();
          setDragActive(true);
        }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={() => setDragActive(false)}
        onDrop={handleDrop}
        className={cn(
          "min-h-24 rounded-xl border border-dashed p-2 outline-none focus:border-sky-500",
          dragActive ? "border-sky-400 bg-sky-500/10" : "border-slate-700",
        )}
      >
        {sampleCount === 0 ? (
          <div className="flex min-h-20 items-center justify-center text-xs text-slate-500">
            Drop or paste images
          </div>
        ) : (
          <div className="grid grid-cols-4 gap-2 sm:grid-cols-6">
            {selectedAssets.map((asset) => (
              <div
                key={asset.id}
                className="group relative aspect-square overflow-hidden rounded-lg border border-slate-700"
              >
                <MediaAssetPreview asset={asset} className="h-full w-full" />
                <button
                  type="button"
                  aria-label="Remove sample image"
                  onClick={() =>
                    onChange(
                      sampleAssetIds.filter((assetId) => assetId !== asset.id),
                      sampleImages,
                    )
                  }
                  className="absolute right-1 top-1 rounded-full bg-slate-950/85 p-1 text-slate-200 opacity-0 group-hover:opacity-100 focus:opacity-100"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
            {sampleImages.map((sample) => (
              <div
                key={sample.url}
                className="group relative aspect-square overflow-hidden rounded-lg border border-slate-700"
              >
                <img
                  src={sample.url}
                  alt=""
                  referrerPolicy="no-referrer"
                  className="h-full w-full object-cover"
                />
                <button
                  type="button"
                  aria-label="Remove linked sample image"
                  onClick={() =>
                    onChange(
                      sampleAssetIds,
                      sampleImages.filter((item) => item.url !== sample.url),
                    )
                  }
                  className="absolute right-1 top-1 rounded-full bg-slate-950/85 p-1 text-slate-200 opacity-0 group-hover:opacity-100 focus:opacity-100"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
            {pending ? (
              <div className="flex aspect-square items-center justify-center rounded-lg border border-slate-700">
                <LoaderCircle className="h-5 w-5 animate-spin text-slate-400" />
              </div>
            ) : null}
          </div>
        )}
      </div>

      <div className="flex gap-2">
        <div className="relative min-w-0 flex-1">
          <Link className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-slate-500" />
          <input
            type="url"
            aria-label="Sample image URL"
            value={linkUrl}
            disabled={disabled || pending || sampleCount >= MAX_SAMPLE_IMAGES}
            onChange={(event) => {
              setLinkUrl(event.target.value);
              setError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void downloadUrl(linkUrl);
              }
            }}
            placeholder="Image URL"
            className="h-10 w-full rounded-xl border border-slate-700 bg-slate-900 pl-9 pr-3 text-xs text-slate-100 outline-none focus:border-sky-500"
          />
        </div>
        <Button
          type="button"
          variant="outline"
          onClick={() => void downloadUrl(linkUrl)}
          disabled={
            disabled ||
            pending ||
            sampleCount >= MAX_SAMPLE_IMAGES ||
            !linkUrl.trim()
          }
        >
          Download
        </Button>
      </div>

      {libraryOpen ? (
        <div className="grid max-h-40 grid-cols-6 gap-2 overflow-y-auto rounded-xl border border-slate-800 p-2">
          {imageAssets.map((asset) => {
            const selected = sampleAssetIds.includes(asset.id);
            return (
              <button
                key={asset.id}
                type="button"
                aria-label={`Use ${asset.id} as a sample image`}
                aria-pressed={selected}
                disabled={
                  disabled ||
                  pending ||
                  (!selected && sampleCount >= MAX_SAMPLE_IMAGES)
                }
                onClick={() =>
                  onChange(
                    selected
                      ? sampleAssetIds.filter((assetId) => assetId !== asset.id)
                      : uniqueLimited([...sampleAssetIds, asset.id]).slice(
                          0,
                          MAX_SAMPLE_IMAGES - sampleImages.length,
                        ),
                    sampleImages,
                  )
                }
                className={cn(
                  "relative aspect-square overflow-hidden rounded-lg border",
                  selected ? "border-sky-400" : "border-slate-700",
                )}
              >
                <MediaAssetPreview asset={asset} className="h-full w-full" />
                {selected ? (
                  <Check className="absolute right-1 top-1 h-4 w-4 rounded-full bg-sky-500 p-0.5 text-white" />
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}
      {error ? <p className="text-xs text-rose-300">{error}</p> : null}
    </div>
  );
};
