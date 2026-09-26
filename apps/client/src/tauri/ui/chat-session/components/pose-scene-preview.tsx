import { invoke, isTauri } from "@tauri-apps/api/core";
import { useEffect, useRef, useState, type JSX } from "react";
import {
  isMediaPoseMap,
  type MediaPoseMap,
} from "@machdoch/media-studio/core/media/contracts.js";
import { PoseSceneCanvas } from "./pose-scene-canvas";

const sceneSignature = (scene: MediaPoseMap): string =>
  JSON.stringify({
    aspectRatio: scene.aspectRatio,
    people: scene.people.map((person) => ({
      pose: person.pose,
      x: person.x,
      y: person.y,
      scale: person.scale,
      mirror: person.mirror,
      joints: person.joints,
    })),
  });

export function PoseScenePreview({
  sessionId,
  initialScene,
  onSceneChange,
}: {
  sessionId: string;
  initialScene?: MediaPoseMap | undefined;
  onSceneChange?: (scene: MediaPoseMap) => void;
}): JSX.Element {
  const [scene, setScene] = useState<MediaPoseMap | null>(initialScene ?? null);
  const [error, setError] = useState<string | null>(null);
  const sceneJson = useRef(initialScene ? sceneSignature(initialScene) : null);
  const editing = useRef(false);
  const onSceneChangeRef = useRef(onSceneChange);
  onSceneChangeRef.current = onSceneChange;

  useEffect(() => {
    if (!isTauri()) return;
    let active = true;
    const refresh = async (): Promise<void> => {
      if (editing.current) return;
      try {
        const value = await invoke<unknown>("media_read_pose_scene", {
          sessionId,
        });
        if (active && !editing.current && value !== null) {
          if (!isMediaPoseMap(value))
            throw new Error("The pose scene is invalid.");
          const nextJson = sceneSignature(value);
          if (sceneJson.current !== nextJson) {
            sceneJson.current = nextJson;
            setScene(value);
            onSceneChangeRef.current?.(value);
          }
          setError(null);
        }
      } catch (cause) {
        if (active)
          setError(cause instanceof Error ? cause.message : String(cause));
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [sessionId]);

  const commit = async (next: MediaPoseMap): Promise<void> => {
    if (!isTauri()) return;
    try {
      await invoke("media_write_pose_scene", { sessionId, map: next });
      const saved = await invoke<unknown>("media_read_pose_scene", {
        sessionId,
      });
      if (
        !isMediaPoseMap(saved) ||
        sceneSignature(saved) !== sceneSignature(next)
      ) {
        throw new Error(
          "The pose edit could not be verified. Try moving the joint again.",
        );
      }
      sceneJson.current = sceneSignature(saved);
      editing.current = false;
      setScene(saved);
      setError(null);
      onSceneChangeRef.current?.(saved);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  if (!scene && !error) return <></>;

  return (
    <section
      aria-label="Pose scene"
      className="mx-auto flex w-full max-w-5xl flex-col items-center gap-3 rounded-lg border border-slate-800 bg-slate-900/40 p-4"
    >
      {scene ? (
        <PoseSceneCanvas
          scene={scene}
          onChange={(next) => {
            editing.current = true;
            setScene(next);
          }}
          onCommit={(next) => void commit(next)}
        />
      ) : null}
      {error ? (
        <div role="alert" className="text-xs text-red-300">
          {error}
        </div>
      ) : null}
    </section>
  );
}
