import { getCurrentWindow, type DragDropEvent } from "@tauri-apps/api/window";
import { useEffect, useState } from "react";
import type { FileDropTarget } from "./session-context-attachments";

export const useSessionFileDrops = (options: {
  fileDropTarget?: FileDropTarget;
  isDesktop: boolean;
  onAttachPaths: (paths: string[], target: FileDropTarget) => Promise<void>;
}): { isActive: boolean } => {
  const [isFileDropActive, setIsFileDropActive] = useState(false);

  useEffect(() => {
    const fileDropTarget = options.fileDropTarget;

    if (!fileDropTarget || !options.isDesktop) {
      setIsFileDropActive(false);
      return;
    }

    let disposed = false;
    let unsubscribe: (() => void) | undefined;

    void getCurrentWindow()
      .onDragDropEvent((event: { payload: DragDropEvent }) => {
        const payload = event.payload;

        if (payload.type === "enter" || payload.type === "over") {
          setIsFileDropActive(true);
          return;
        }

        if (payload.type === "leave") {
          setIsFileDropActive(false);
          return;
        }

        setIsFileDropActive(false);
        void options.onAttachPaths(payload.paths, fileDropTarget).catch((error) => {
          console.error("Failed to attach dropped files", error);
        });
      })
      .then((unlisten) => {
        if (disposed) {
          unlisten();
          return;
        }

        unsubscribe = unlisten;
      })
      .catch((error) => {
        console.error("Failed to subscribe to dropped files", error);
      });

    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, [
    options.fileDropTarget,
    options.isDesktop,
    options.onAttachPaths,
  ]);

  return { isActive: isFileDropActive };
};
