import { Sparkles } from "lucide-react";
import { useEffect, useState, type JSX } from "react";
import type {
  MediaAssetRecord,
  MediaGenerationAssetMetadata,
} from "../../../../core/media/contracts.js";
import { cn } from "../../lib/utils";
import { readMediaAssetReferencePreview } from "../media-runtime";

interface MediaAssetPreviewProps {
  asset: MediaAssetRecord;
  className?: string;
  controls?: boolean;
  fit?: "cover" | "contain";
}

export const MediaAssetPreview = ({
  asset,
  className,
  controls = false,
  fit = "cover",
}: MediaAssetPreviewProps): JSX.Element => {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let objectUrl: string | null = null;
    setUrl(null);
    void readMediaAssetReferencePreview(asset.id, 768)
      .then((blob) => {
        if (!active) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => undefined);
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [asset.id]);

  if (!url) {
    return <div className={cn("animate-pulse bg-slate-900", className)} />;
  }

  const objectFit = fit === "contain" ? "object-contain" : "object-cover";
  return asset.kind === "video" ? (
    <video
      src={url}
      controls={controls}
      muted
      loop
      playsInline
      preload="metadata"
      className={cn(objectFit, className)}
    />
  ) : (
    <img src={url} alt="" className={cn(objectFit, className)} />
  );
};

interface MediaResourcePreviewProps {
  resourceId: string;
  metadata: Readonly<Record<string, MediaGenerationAssetMetadata>>;
  assets: readonly MediaAssetRecord[];
  className?: string;
}

export const MediaResourcePreview = ({
  resourceId,
  metadata,
  assets,
  className,
}: MediaResourcePreviewProps): JSX.Element => {
  const details = metadata[resourceId];
  const localSample = assets.find((asset) =>
    details?.sampleAssetIds.includes(asset.id),
  );

  if (localSample) {
    return <MediaAssetPreview asset={localSample} className={className} />;
  }

  const remoteSample = details?.sampleImages[0]?.url;
  if (remoteSample) {
    return (
      <img
        src={remoteSample}
        alt=""
        referrerPolicy="no-referrer"
        className={cn("bg-slate-900 object-cover", className)}
      />
    );
  }

  return (
    <div
      className={cn(
        "flex items-center justify-center bg-gradient-to-br from-slate-800 to-slate-950 text-slate-600",
        className,
      )}
    >
      <Sparkles className="h-9 w-9" />
    </div>
  );
};
