import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect } from "react";

export const useUnsavedChangesGuard = (message: string | null): void => {
  useEffect(() => {
    if (!message || typeof window === "undefined") return;

    const desktop = isTauri() && "__TAURI_INTERNALS__" in window;
    if (!desktop) {
      const preventUnload = (event: BeforeUnloadEvent): void => {
        event.preventDefault();
        event.returnValue = "";
      };
      window.addEventListener("beforeunload", preventUnload);
      return () => window.removeEventListener("beforeunload", preventUnload);
    }

    let disposed = false;
    let unlisten: (() => void) | undefined;
    void getCurrentWindow()
      .onCloseRequested((event) => {
        if (!window.confirm(message)) event.preventDefault();
      })
      .then((dispose) => {
        if (disposed) dispose();
        else unlisten = dispose;
      })
      .catch((error: unknown) => {
        console.error("Failed to register the unsaved-changes guard", error);
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [message]);
};
