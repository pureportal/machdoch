import { getVersion } from "@tauri-apps/api/app";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { Button } from "@machdoch/media-studio/tauri/ui/components/ui/button.js";
import {
  SettingPanel,
  SettingsCard,
} from "../chat-session/components/settings-dialog-panels/shared";
import { CHECK_FOR_UPDATES_EVENT } from "./use-desktop-update";

export function UpdateSettingsControl() {
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    void invoke<boolean>("app_update_available")
      .then(async (available) => {
        if (!available) return;
        const installedVersion = await getVersion();
        if (!disposed) setVersion(installedVersion);
      })
      .catch((error: unknown) =>
        console.error("Could not inspect update support", error),
      );
    return () => {
      disposed = true;
    };
  }, []);
  return version ? (
    <SettingsCard title="Updates">
      <SettingPanel label={`Version ${version}`}>
        <Button
          variant="outline"
          data-analytics-feature="update"
          onClick={() =>
            window.dispatchEvent(new Event(CHECK_FOR_UPDATES_EVENT))
          }
        >
          Check for updates
        </Button>
      </SettingPanel>
    </SettingsCard>
  ) : null;
}
