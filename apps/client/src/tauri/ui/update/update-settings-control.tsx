import { invoke, isTauri } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { Button } from "@machdoch/media-studio/tauri/ui/components/ui/button.js";
import { CHECK_FOR_UPDATES_EVENT } from "./use-desktop-update";

export function UpdateSettingsControl() {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    void invoke<boolean>("app_update_available")
      .then((value) => {
        if (!disposed) setEnabled(value);
      })
      .catch((error: unknown) =>
        console.error("Could not inspect update support", error),
      );
    return () => {
      disposed = true;
    };
  }, []);
  return enabled ? (
    <Button
      variant="outline"
      onClick={() => window.dispatchEvent(new Event(CHECK_FOR_UPDATES_EVENT))}
    >
      Check for updates
    </Button>
  ) : null;
}
