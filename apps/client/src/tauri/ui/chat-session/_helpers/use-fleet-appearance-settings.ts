import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef } from "react";
import { deviceAppearanceSchema } from "@machdoch/fleet-protocol/device-settings";
import { getCurrentShellWindowLabel } from "../../lib/shell-store";
import type { AppearanceSettingsController } from "./use-appearance-settings";

export function useFleetAppearanceSettings(
  appearance: AppearanceSettingsController,
): void {
  const current = useRef(appearance);
  current.current = appearance;
  useEffect(() => {
    if (getCurrentShellWindowLabel() !== "main") return;
    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    const handle = async (request: {
      id: string;
      command: string;
      args: unknown;
    }): Promise<void> => {
      if (
        request.command !== "get_device_appearance" &&
        request.command !== "save_device_appearance"
      )
        return;
      let result = null;
      let error = null;
      try {
        if (request.command === "save_device_appearance") {
          const args = request.args as { settings?: unknown };
          await current.current.onSave(
            deviceAppearanceSchema.parse(args?.settings),
          );
          await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
        }
        result = current.current.settings;
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause);
      }
      await invoke("complete_fleet_client_request", {
        id: request.id,
        result,
        error,
      });
    };
    void listen<{ id: string; command: string; args: unknown }>(
      "machdoch://fleet-client-request",
      ({ payload }) => {
        void handle(payload).catch((error: unknown) =>
          console.error("Appearance could not be confirmed", error),
        );
      },
    )
      .then((stop) => {
        if (disposed) stop();
        else unsubscribe = stop;
      })
      .catch((error: unknown) =>
        console.error("Appearance could not be connected", error),
      );
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, []);
}
