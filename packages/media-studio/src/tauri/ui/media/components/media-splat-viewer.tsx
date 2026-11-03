import { LoaderCircle, Maximize2, Pause, RotateCcw, Rotate3d } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import type { MediaAssetRecord } from "../../../../core/media/contracts.js";
import { Button } from "../../components/ui/button";
import { cn } from "../../lib/utils";
import { readMediaSplat } from "../media-runtime";
import { MediaAssetPreview } from "./media-visual-preview";
import type { MediaSplatInputCamera, MediaSplatSceneHandle } from "./media-splat-scene";

const inputCamera = (asset: MediaAssetRecord): MediaSplatInputCamera | null => {
  const operation = asset.operation;
  const generation: unknown =
    operation?.kind === "local-splat-generation"
      ? operation.generation
      : operation?.kind === "workflow"
        ? operation.details
        : null;
  if (typeof generation !== "object" || generation === null) return null;
  const camera = (generation as { camera?: unknown }).camera;
  if (typeof camera !== "object" || camera === null) return null;
  const { yaw, pitch } = camera as { yaw?: unknown; pitch?: unknown };
  return typeof yaw === "number" && typeof pitch === "number" ? { yaw, pitch } : null;
};

export const MediaSplatViewer = ({
  asset,
  className,
}: {
  asset: MediaAssetRecord;
  className?: string;
}): JSX.Element => {
  const frameRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<MediaSplatSceneHandle | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  const [autoRotate, setAutoRotate] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const camera = inputCamera(asset);
  const cameraRef = useRef(camera);
  cameraRef.current = camera;

  useEffect(() => {
    const container = canvasRef.current;
    if (!container) return;
    let active = true;
    setState("loading");
    setAutoRotate(true);
    void Promise.all([readMediaSplat(asset.id), import("./media-splat-scene")])
      .then(async ([bytes, module]) => {
        if (!active) return;
        const handle = await module.createMediaSplatScene({
          container,
          bytes,
          inputCamera: cameraRef.current,
          autoRotate: true,
          onInteraction: () => {
            sceneRef.current?.setAutoRotate(false);
            setAutoRotate(false);
          },
        });
        if (!active) {
          handle.dispose();
          return;
        }
        sceneRef.current = handle;
        setState("ready");
      })
      .catch(() => {
        if (active) setState("failed");
      });
    return () => {
      active = false;
      sceneRef.current?.dispose();
      sceneRef.current = null;
    };
  }, [asset.id, attempt]);

  const toggleRotation = useCallback(() => {
    setAutoRotate((current) => {
      sceneRef.current?.setAutoRotate(!current);
      return !current;
    });
  }, []);

  return (
    <div
      ref={frameRef}
      className={cn(
        "relative overflow-hidden rounded-lg bg-[radial-gradient(circle_at_50%_40%,#1e293b,#020617_75%)]",
        className,
      )}
    >
      <div
        ref={canvasRef}
        aria-label="3D object viewer"
        role="img"
        onDoubleClick={() => sceneRef.current?.resetView()}
        className={cn(
          "absolute inset-0 transition-opacity duration-500",
          state === "ready" ? "opacity-100" : "opacity-0",
        )}
      />
      {state !== "ready" ? (
        <div className="absolute inset-0">
          <MediaAssetPreview asset={asset} fit="contain" className="h-full w-full bg-transparent" />
          <div className="absolute inset-x-0 bottom-3 flex justify-center">
            {state === "loading" ? (
              <span role="status" className="inline-flex items-center gap-2 rounded-full bg-slate-950/80 px-3 py-1 text-xs text-slate-300">
                <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                Loading 3D
              </span>
            ) : (
              <Button size="xs" variant="secondary" onClick={() => setAttempt((value) => value + 1)}>
                Retry 3D view
              </Button>
            )}
          </div>
        </div>
      ) : (
        <div className="absolute right-2 bottom-2 flex gap-1 rounded-lg bg-slate-950/70 p-1 backdrop-blur">
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={autoRotate ? "Stop turning" : "Turn"}
            aria-pressed={autoRotate}
            onClick={toggleRotation}
          >
            {autoRotate ? <Pause /> : <Rotate3d />}
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Reset view"
            onClick={() => sceneRef.current?.resetView()}
          >
            <RotateCcw />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Full screen"
            onClick={() => void frameRef.current?.requestFullscreen()}
          >
            <Maximize2 />
          </Button>
        </div>
      )}
    </div>
  );
};
