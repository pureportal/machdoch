import { Brush, Eraser, Redo2, RotateCcw, Trash2, Undo2 } from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type {
  MediaAssetRecord,
  MediaImageMask,
  MediaImageMaskPoint,
  MediaImageMaskStroke,
} from "../../../../core/media/contracts.js";
import {
  MEDIA_IMAGE_MASK_MAX_POINTS,
  MEDIA_IMAGE_MASK_MAX_STROKES,
} from "../../../../core/media/image-mask.js";
import { Button } from "../../components/ui/button";
import { cn } from "../../lib/utils";
import { readMediaAssetReferencePreview } from "../media-runtime";

interface MediaImageMaskEditorProps {
  asset: MediaAssetRecord;
  value: MediaImageMask | null | undefined;
  onChange: (value: MediaImageMask | null) => void;
  className?: string;
}

type MaskTool = "paint" | "erase";
type MaskPreview = "overlay" | "mask";

const createMask = (
  assetId: string,
  inverted: boolean,
  strokes: MediaImageMaskStroke[],
): MediaImageMask => ({
  schemaVersion: 2,
  sourceAssetId: assetId,
  inverted,
  strokes,
});

const drawStroke = (
  context: CanvasRenderingContext2D,
  stroke: MediaImageMaskStroke,
  width: number,
  height: number,
): void => {
  const first = stroke.points[0];
  if (!first) return;
  const strokeCanvas = document.createElement("canvas");
  strokeCanvas.width = width;
  strokeCanvas.height = height;
  const strokeContext = strokeCanvas.getContext("2d");
  if (!strokeContext) return;
  const radius = Math.max(0.5, (stroke.size * Math.min(width, height)) / 2);
  const innerRadius = radius * (1 - stroke.softness);
  const stamp = (x: number, y: number): void => {
    strokeContext.save();
    strokeContext.globalCompositeOperation = "lighten";
    if (stroke.softness === 0) {
      strokeContext.fillStyle = "#ffffff";
    } else {
      const gradient = strokeContext.createRadialGradient(
        x,
        y,
        innerRadius,
        x,
        y,
        radius,
      );
      gradient.addColorStop(0, "rgba(255,255,255,1)");
      gradient.addColorStop(1, "rgba(255,255,255,0)");
      strokeContext.fillStyle = gradient;
    }
    strokeContext.beginPath();
    strokeContext.arc(x, y, radius, 0, Math.PI * 2);
    strokeContext.fill();
    strokeContext.restore();
  };
  let previousX = first.x * (width - 1);
  let previousY = first.y * (height - 1);
  stamp(previousX, previousY);
  for (const point of stroke.points.slice(1)) {
    const nextX = point.x * (width - 1);
    const nextY = point.y * (height - 1);
    const distance = Math.hypot(nextX - previousX, nextY - previousY);
    const sampleCount = Math.max(
      1,
      Math.ceil(distance / Math.max(1, radius / 4)),
    );
    for (let sample = 1; sample <= sampleCount; sample += 1) {
      const progress = sample / sampleCount;
      stamp(
        previousX + (nextX - previousX) * progress,
        previousY + (nextY - previousY) * progress,
      );
    }
    previousX = nextX;
    previousY = nextY;
  }
  context.save();
  context.globalCompositeOperation =
    stroke.mode === "paint" ? "source-over" : "destination-out";
  context.globalAlpha = stroke.opacity;
  context.drawImage(strokeCanvas, 0, 0);
  context.restore();
};

const createSelectionCanvas = (
  width: number,
  height: number,
  strokes: readonly MediaImageMaskStroke[],
  inverted: boolean,
): HTMLCanvasElement => {
  const selection = document.createElement("canvas");
  selection.width = width;
  selection.height = height;
  const context = selection.getContext("2d");
  if (!context) return selection;
  for (const stroke of strokes) drawStroke(context, stroke, width, height);
  if (!inverted) return selection;

  const invertedSelection = document.createElement("canvas");
  invertedSelection.width = width;
  invertedSelection.height = height;
  const invertedContext = invertedSelection.getContext("2d");
  if (!invertedContext) return selection;
  invertedContext.fillStyle = "#ffffff";
  invertedContext.fillRect(0, 0, width, height);
  invertedContext.globalCompositeOperation = "destination-out";
  invertedContext.drawImage(selection, 0, 0);
  return invertedSelection;
};

const pointFromPointer = (
  canvas: HTMLCanvasElement,
  event: ReactPointerEvent<HTMLCanvasElement>,
): MediaImageMaskPoint => {
  const bounds = canvas.getBoundingClientRect();
  return {
    x: Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width)),
    y: Math.min(1, Math.max(0, (event.clientY - bounds.top) / bounds.height)),
  };
};

export const MediaImageMaskEditor = ({
  asset,
  value,
  onChange,
  className,
}: MediaImageMaskEditorProps): JSX.Element => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [imageSize, setImageSize] = useState({ width: 1, height: 1 });
  const [tool, setTool] = useState<MaskTool>("paint");
  const [preview, setPreview] = useState<MaskPreview>("overlay");
  const [brushSize, setBrushSize] = useState(0.075);
  const [brushOpacity, setBrushOpacity] = useState(1);
  const [brushSoftness, setBrushSoftness] = useState(0.35);
  const [draftStroke, setDraftStroke] = useState<MediaImageMaskStroke | null>(
    null,
  );
  const [hoverPoint, setHoverPoint] = useState<MediaImageMaskPoint | null>(
    null,
  );
  const [undoStack, setUndoStack] = useState<MediaImageMaskStroke[][]>([]);
  const [redoStack, setRedoStack] = useState<MediaImageMaskStroke[][]>([]);
  const mask = value?.sourceAssetId === asset.id ? value : null;
  const strokes = mask?.strokes ?? [];
  const inverted = mask?.inverted ?? false;
  const pointCount = useMemo(
    () => strokes.reduce((total, stroke) => total + stroke.points.length, 0),
    [strokes],
  );

  useEffect(() => {
    let active = true;
    let objectUrl: string | null = null;
    setImageUrl(null);
    void readMediaAssetReferencePreview(asset.id, 1_536)
      .then((blob) => {
        if (!active) return;
        objectUrl = URL.createObjectURL(blob);
        setImageUrl(objectUrl);
      })
      .catch(() => undefined);
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [asset.id]);

  useEffect(() => {
    setUndoStack([]);
    setRedoStack([]);
    setDraftStroke(null);
  }, [asset.id]);

  useEffect(() => {
    if (!imageUrl) {
      imageRef.current = null;
      return;
    }
    const image = new Image();
    image.onload = () => {
      const scale = Math.min(1, 1_024 / Math.max(image.width, image.height));
      setImageSize({
        width: Math.max(1, Math.round(image.width * scale)),
        height: Math.max(1, Math.round(image.height * scale)),
      });
      imageRef.current = image;
    };
    image.src = imageUrl;
    return () => {
      image.onload = null;
      if (imageRef.current === image) imageRef.current = null;
    };
  }, [imageUrl]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const image = imageRef.current;
    if (!canvas || !image) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    canvas.width = imageSize.width;
    canvas.height = imageSize.height;
    context.clearRect(0, 0, canvas.width, canvas.height);
    const visibleStrokes = draftStroke ? [...strokes, draftStroke] : strokes;
    const selection = createSelectionCanvas(
      canvas.width,
      canvas.height,
      visibleStrokes,
      inverted,
    );
    if (preview === "overlay") {
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const selectionContext = selection.getContext("2d");
      if (selectionContext) {
        selectionContext.globalCompositeOperation = "source-in";
        selectionContext.fillStyle = "#22d3ee";
        selectionContext.fillRect(0, 0, canvas.width, canvas.height);
      }
      context.save();
      context.globalAlpha = 0.52;
      context.drawImage(selection, 0, 0);
      context.restore();
    } else {
      context.fillStyle = "#000000";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(selection, 0, 0);
    }
    if (hoverPoint && !draftStroke) {
      context.beginPath();
      context.arc(
        hoverPoint.x * (canvas.width - 1),
        hoverPoint.y * (canvas.height - 1),
        (brushSize * Math.min(canvas.width, canvas.height)) / 2,
        0,
        Math.PI * 2,
      );
      context.strokeStyle = preview === "overlay" ? "#ffffff" : "#0891b2";
      context.lineWidth = Math.max(1, canvas.width / 512);
      context.stroke();
    }
  }, [
    brushSize,
    draftStroke,
    hoverPoint,
    imageSize,
    inverted,
    preview,
    strokes,
  ]);

  const updateStrokes = (next: MediaImageMaskStroke[]): void => {
    onChange(createMask(asset.id, inverted, next));
  };

  const beginStroke = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    if (
      event.button !== 0 ||
      strokes.length >= MEDIA_IMAGE_MASK_MAX_STROKES ||
      pointCount >= MEDIA_IMAGE_MASK_MAX_POINTS
    ) {
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    setDraftStroke({
      mode: tool,
      size: brushSize,
      opacity: brushOpacity,
      softness: brushSoftness,
      points: [pointFromPointer(event.currentTarget, event)],
    });
  };

  const continueStroke = (
    event: ReactPointerEvent<HTMLCanvasElement>,
  ): void => {
    const point = pointFromPointer(event.currentTarget, event);
    setHoverPoint(point);
    if (
      !draftStroke ||
      pointCount + draftStroke.points.length >= MEDIA_IMAGE_MASK_MAX_POINTS
    ) {
      return;
    }
    const previous = draftStroke.points.at(-1);
    if (
      previous &&
      Math.hypot(point.x - previous.x, point.y - previous.y) < 0.0015
    ) {
      return;
    }
    setDraftStroke({
      ...draftStroke,
      points: [...draftStroke.points, point],
    });
  };

  const finishStroke = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    if (!draftStroke) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setUndoStack((current) => [...current.slice(-49), [...strokes]]);
    setRedoStack([]);
    updateStrokes([...strokes, draftStroke]);
    setDraftStroke(null);
  };

  return (
    <div className={cn("space-y-3", className)}>
      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          type="button"
          size="sm"
          variant={tool === "paint" ? "default" : "outline"}
          aria-pressed={tool === "paint"}
          onClick={() => setTool("paint")}
          className="h-8 px-2.5 text-xs"
        >
          <Brush className="h-3.5 w-3.5" /> Paint
        </Button>
        <Button
          type="button"
          size="sm"
          variant={tool === "erase" ? "default" : "outline"}
          aria-pressed={tool === "erase"}
          onClick={() => setTool("erase")}
          className="h-8 px-2.5 text-xs"
        >
          <Eraser className="h-3.5 w-3.5" /> Erase
        </Button>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label="Undo mask stroke"
          disabled={undoStack.length === 0}
          onClick={() => {
            const previous = undoStack.at(-1);
            if (!previous) return;
            setUndoStack((current) => current.slice(0, -1));
            setRedoStack((current) => [[...strokes], ...current.slice(0, 49)]);
            updateStrokes(previous);
          }}
        >
          <Undo2 className="h-3.5 w-3.5" />
        </Button>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label="Redo mask stroke"
          disabled={redoStack.length === 0}
          onClick={() => {
            const next = redoStack[0];
            if (!next) return;
            setRedoStack((current) => current.slice(1));
            setUndoStack((current) => [...current.slice(-49), [...strokes]]);
            updateStrokes(next);
          }}
        >
          <Redo2 className="h-3.5 w-3.5" />
        </Button>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label="Clear mask"
          disabled={strokes.length === 0 && !inverted}
          onClick={() => {
            setUndoStack((current) => [...current.slice(-49), [...strokes]]);
            setRedoStack([]);
            onChange(createMask(asset.id, false, []));
          }}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>

      <canvas
        ref={canvasRef}
        aria-label="Image edit mask canvas"
        onPointerDown={beginStroke}
        onPointerMove={continueStroke}
        onPointerUp={finishStroke}
        onPointerCancel={finishStroke}
        onPointerLeave={() => setHoverPoint(null)}
        className="block w-full touch-none rounded-xl bg-[linear-gradient(45deg,#1e293b_25%,transparent_25%),linear-gradient(-45deg,#1e293b_25%,transparent_25%),linear-gradient(45deg,transparent_75%,#1e293b_75%),linear-gradient(-45deg,transparent_75%,#1e293b_75%)] bg-[length:16px_16px] bg-[position:0_0,0_8px,8px_-8px,-8px_0] ring-1 ring-inset ring-slate-700"
        style={{ aspectRatio: `${imageSize.width} / ${imageSize.height}` }}
      />

      <div className="grid gap-3 sm:grid-cols-3">
        <label className="space-y-1 text-xs text-slate-400">
          <span>Brush {Math.round(brushSize * 100)}%</span>
          <input
            type="range"
            min="0.25"
            max="35"
            step="0.25"
            value={brushSize * 100}
            onChange={(event) => setBrushSize(Number(event.target.value) / 100)}
            className="block w-full accent-cyan-400"
          />
        </label>
        <label className="space-y-1 text-xs text-slate-400">
          <span>Strength {Math.round(brushOpacity * 100)}%</span>
          <input
            type="range"
            min="1"
            max="100"
            step="1"
            value={brushOpacity * 100}
            onChange={(event) =>
              setBrushOpacity(Number(event.target.value) / 100)
            }
            className="block w-full accent-cyan-400"
          />
        </label>
        <label className="space-y-1 text-xs text-slate-400">
          <span>Soft edge {Math.round(brushSoftness * 100)}%</span>
          <input
            type="range"
            min="0"
            max="100"
            step="1"
            value={brushSoftness * 100}
            onChange={(event) =>
              setBrushSoftness(Number(event.target.value) / 100)
            }
            className="block w-full accent-cyan-400"
          />
        </label>
        <div className="flex items-end gap-1.5 sm:col-span-3 sm:justify-end">
          <button
            type="button"
            aria-pressed={preview === "overlay"}
            onClick={() => setPreview("overlay")}
            className={cn(
              "h-8 rounded-lg px-2.5 text-xs",
              preview === "overlay"
                ? "bg-slate-700 text-white"
                : "text-slate-400 hover:bg-slate-800",
            )}
          >
            Overlay
          </button>
          <button
            type="button"
            aria-pressed={preview === "mask"}
            onClick={() => setPreview("mask")}
            className={cn(
              "h-8 rounded-lg px-2.5 text-xs",
              preview === "mask"
                ? "bg-slate-700 text-white"
                : "text-slate-400 hover:bg-slate-800",
            )}
          >
            Mask
          </button>
          <Button
            type="button"
            size="sm"
            variant={inverted ? "default" : "outline"}
            aria-pressed={inverted}
            disabled={strokes.length === 0}
            onClick={() =>
              onChange(createMask(asset.id, !inverted, [...strokes]))
            }
            className="h-8 px-2.5 text-xs"
          >
            <RotateCcw className="h-3.5 w-3.5" /> Invert
          </Button>
        </div>
      </div>
    </div>
  );
};
