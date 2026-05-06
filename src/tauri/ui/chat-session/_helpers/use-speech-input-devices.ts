import { useCallback, useEffect, useState } from "react";
import {
  canEnumerateSpeechInputDevices,
  listSpeechInputDevices,
  type SpeechInputDeviceOption,
} from "./speech-audio";

export interface SpeechInputDevicesController {
  supported: boolean;
  devices: SpeechInputDeviceOption[];
  refreshing: boolean;
  errorText: string | null;
  refresh: () => Promise<void>;
}

const getDeviceListErrorText = (error: unknown): string => {
  if (
    typeof DOMException !== "undefined" &&
    error instanceof DOMException &&
    error.name === "NotAllowedError"
  ) {
    return "Microphone device names are hidden until microphone access is allowed.";
  }

  return error instanceof Error
    ? error.message
    : "Microphone devices could not be loaded.";
};

export const useSpeechInputDevices = (
  enabled: boolean,
): SpeechInputDevicesController => {
  const supported = canEnumerateSpeechInputDevices();
  const [devices, setDevices] = useState<SpeechInputDeviceOption[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    if (!supported) {
      setDevices([]);
      setErrorText("This WebView does not expose microphone device selection.");
      return;
    }

    setRefreshing(true);
    setErrorText(null);

    try {
      setDevices(await listSpeechInputDevices());
    } catch (error) {
      setErrorText(getDeviceListErrorText(error));
    } finally {
      setRefreshing(false);
    }
  }, [supported]);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    void refresh();
  }, [enabled, refresh]);

  useEffect(() => {
    if (
      !supported ||
      typeof navigator === "undefined" ||
      typeof navigator.mediaDevices.addEventListener !== "function" ||
      typeof navigator.mediaDevices.removeEventListener !== "function"
    ) {
      return;
    }

    const handleDeviceChange = (): void => {
      if (enabled) {
        void refresh();
      }
    };

    navigator.mediaDevices.addEventListener("devicechange", handleDeviceChange);

    return () => {
      navigator.mediaDevices.removeEventListener(
        "devicechange",
        handleDeviceChange,
      );
    };
  }, [enabled, refresh, supported]);

  return {
    supported,
    devices,
    refreshing,
    errorText,
    refresh,
  };
};
