import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect } from "react";
import { INSTALL_LATEST_UPDATE_EVENT } from "./use-desktop-update";

const REMOTE_UPDATE_EVENT = "app-update-requested";

export function useRemoteUpdateRequests() {
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen(REMOTE_UPDATE_EVENT, () => {
      window.dispatchEvent(new Event(INSTALL_LATEST_UPDATE_EVENT));
    })
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch((failure: unknown) =>
        console.error("Could not listen for remote updates", failure),
      );
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
}
