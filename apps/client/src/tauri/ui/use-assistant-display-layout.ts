import { useEffect } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  DISPLAY_LAYOUT_CHANGED_EVENT,
  resolveAssistantSurfaceLayout,
  setWindowPosition,
  setWindowSize,
} from "./assistant-surface";

export const useAssistantDisplayLayout = (): void => {
  useEffect(() => {
    if (!isTauri()) return;
    const current = getCurrentWindow();
    let disposed = false;
    let running = false;
    let pending = false;
    const unlisteners: (() => void)[] = [];
    const sync = async (): Promise<void> => {
      pending = true;
      if (running) return;
      running = true;
      try {
        while (pending && !disposed) {
          pending = false;
          const layout = await resolveAssistantSurfaceLayout("window");
          if (!layout || disposed) continue;
          await setWindowPosition(current, layout.quickVoicePosition);
          if (disposed) break;
          await setWindowSize(current, layout.quickVoiceSize);
        }
      } finally {
        running = false;
      }
    };
    const refresh = (): void => {
      void sync().catch((error) =>
        console.error("Failed to update assistant display layout", error),
      );
    };
    for (const subscribe of [
      () => current.listen(DISPLAY_LAYOUT_CHANGED_EVENT, refresh),
      () => current.onScaleChanged(refresh),
    ]) {
      void subscribe()
        .then((unlisten) => {
          if (disposed) unlisten();
          else unlisteners.push(unlisten);
        })
        .catch((error) =>
          console.error("Failed to subscribe to display changes", error),
        );
    }
    return () => {
      disposed = true;
      for (const unlisten of unlisteners) unlisten();
    };
  }, []);
};
