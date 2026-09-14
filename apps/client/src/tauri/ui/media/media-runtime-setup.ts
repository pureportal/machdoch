import { invoke, isTauri } from "@tauri-apps/api/core";

export interface MediaRuntimeSetupStatus {
  phase:
    | "idle"
    | "checking"
    | "downloading"
    | "python"
    | "dependencies"
    | "verifying"
    | "models"
    | "ready"
    | "failed";
  downloadPercent: number | null;
  message: string;
  diagnostic: string | null;
}

export const EMPTY_MEDIA_RUNTIME_SETUP: MediaRuntimeSetupStatus = {
  phase: "idle",
  downloadPercent: null,
  message: "",
  diagnostic: null,
};

export const isMediaRuntimeSetupActive = (
  status: MediaRuntimeSetupStatus,
): boolean => !["idle", "ready", "failed"].includes(status.phase);

export const getMediaRuntimeSetup =
  async (): Promise<MediaRuntimeSetupStatus> =>
    isTauri() ? invoke("media_get_runtime_setup") : EMPTY_MEDIA_RUNTIME_SETUP;

export const startMediaRuntimeSetup =
  async (): Promise<MediaRuntimeSetupStatus> => {
    if (!isTauri()) {
      throw new Error("Open the desktop app to set up Media Studio.");
    }
    return invoke("media_start_runtime_setup");
  };

export const mediaRuntimeSetupLabel = (
  status: MediaRuntimeSetupStatus,
): string => {
  switch (status.phase) {
    case "idle":
      return "Set up Media Studio";
    case "checking":
      return "Checking setup…";
    case "downloading":
      return status.downloadPercent === null
        ? "Downloading setup…"
        : `Downloading setup… ${status.downloadPercent}%`;
    case "python":
      return "Installing runtime…";
    case "dependencies":
      return "Installing components…";
    case "verifying":
      return "Checking Media Studio…";
    case "models":
      return "Checking models…";
    case "ready":
      return "Media Studio is ready";
    case "failed":
      return "Retry setup";
  }
};
