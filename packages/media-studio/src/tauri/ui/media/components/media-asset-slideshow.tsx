import { useEffect, useState, type JSX } from "react";
import { ChevronLeft, ChevronRight, Pause, Play } from "lucide-react";
import type { MediaAssetRecord } from "../../../../core/media/contracts.js";
import { mediaAssetLabel } from "../../../../core/media/asset-label.js";
import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import { MediaAssetPreview } from "./media-visual-preview";

export const MediaAssetSlideshow = ({
  assets,
  onClose,
}: {
  assets: readonly MediaAssetRecord[];
  onClose: () => void;
}): JSX.Element | null => {
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(true);
  const count = assets.length;
  const asset = assets[index % count];
  useEffect(() => {
    if (!playing || count < 2) return;
    const timer = window.setInterval(
      () => setIndex((current) => (current + 1) % count),
      5000,
    );
    return () => window.clearInterval(timer);
  }, [count, playing]);
  if (!asset) return null;
  const move = (offset: number): void => {
    setPlaying(false);
    setIndex((current) => (current + offset + count) % count);
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        className="flex h-[90vh] max-w-[95vw] flex-col"
        aria-describedby={undefined}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
            event.preventDefault();
            move(event.key === "ArrowLeft" ? -1 : 1);
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>{mediaAssetLabel(asset)}</DialogTitle>
        </DialogHeader>
        <MediaAssetPreview
          key={asset.id}
          asset={asset}
          fit="contain"
          maxEdge={2048}
          className="min-h-0 flex-1 rounded-lg"
        />
        <div className="flex items-center justify-center gap-3">
          <Button
            variant="outline"
            aria-label="Previous image"
            onClick={() => move(-1)}
            disabled={count < 2}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="text-sm tabular-nums text-slate-400">
            {(index % count) + 1} / {count}
          </span>
          <Button
            variant="outline"
            aria-label={playing ? "Pause slideshow" : "Play slideshow"}
            onClick={() => setPlaying((current) => !current)}
            disabled={count < 2}
          >
            {playing ? (
              <Pause className="h-4 w-4" />
            ) : (
              <Play className="h-4 w-4" />
            )}
          </Button>
          <Button
            variant="outline"
            aria-label="Next image"
            onClick={() => move(1)}
            disabled={count < 2}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};
