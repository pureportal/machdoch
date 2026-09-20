import { save } from "../media-platform";
import { Check, Download, LoaderCircle } from "lucide-react";
import { useState, type JSX } from "react";
import type { MediaAssetRecord } from "../../../../core/media/contracts.js";
import { exportMediaAsset } from "../media-runtime";
import { Button } from "../../components/ui/button";

export const MediaSaveAssetButton = ({
  asset,
}: {
  asset: MediaAssetRecord;
}): JSX.Element => {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const label =
    asset.kind === "video"
      ? "Save video"
      : asset.kind === "vector"
        ? "Save SVG"
        : asset.kind === "report"
          ? "Save report"
          : "Save image";
  const saveAsset = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const extension = {
        "image/png": "png",
        "image/jpeg": "jpg",
        "image/webp": "webp",
        "image/svg+xml": "svg",
        "video/webm": "webm",
        "application/json": "json",
      }[asset.mimeType];
      const destinationPath = await save({
        title: label,
        defaultPath: `machdoch-${asset.id.replaceAll(/[^a-zA-Z0-9_-]/g, "-")}.${extension}`,
        filters: [{ name: extension.toUpperCase(), extensions: [extension] }],
      });
      if (destinationPath) {
        await exportMediaAsset({
          assetId: asset.id,
          destinationPath,
          mode: "verified-original",
        });
        setSaved(true);
      }
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The file could not be saved. Choose another location and retry.",
      );
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="col-span-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="w-full"
        disabled={saving}
        onClick={() => void saveAsset()}
      >
        {saving ? (
          <LoaderCircle className="h-4 w-4 animate-spin" />
        ) : saved ? (
          <Check className="h-4 w-4" />
        ) : (
          <Download className="h-4 w-4" />
        )}
        <span aria-live="polite">{saved ? "Saved" : label}</span>
      </Button>
      {error ? (
        <p role="alert" className="mt-2 text-xs text-rose-300">
          {error}
        </p>
      ) : null}
    </div>
  );
};
