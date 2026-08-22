import { useCallback, useEffect, useRef, useState } from "react";
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
  const mountedRef = useRef(true);
  const refreshSequenceRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      refreshSequenceRef.current += 1;
    };
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    if (!mountedRef.current) return;
    const refreshSequence = refreshSequenceRef.current + 1;
    refreshSequenceRef.current = refreshSequence;
    if (!supported) {
      if (mountedRef.current) {
        setDevices([]);
        setErrorText(
          "This WebView does not expose microphone device selection.",
        );
      }
      return;
    }

    setRefreshing(true);
    setErrorText(null);

    try {
      const nextDevices = await listSpeechInputDevices();
      if (
        mountedRef.current &&
        refreshSequence === refreshSequenceRef.current
      ) {
        setDevices(nextDevices);
      }
    } catch (error) {
      if (
        mountedRef.current &&
        refreshSequence === refreshSequenceRef.current
      ) {
        setErrorText(getDeviceListErrorText(error));
      }
    } finally {
      if (
        mountedRef.current &&
        refreshSequence === refreshSequenceRef.current
      ) {
        setRefreshing(false);
      }
    }
  }, [supported]);

  useEffect(() => {
    if (!enabled) {
      refreshSequenceRef.current += 1;
      setRefreshing(false);
      return;
    }

    void refresh();
  }, [enabled, refresh]);

  useEffect(() => {
    if (
      !enabled ||
      !supported ||
      typeof navigator === "undefined" ||
      typeof navigator.mediaDevices.addEventListener !== "function" ||
      typeof navigator.mediaDevices.removeEventListener !== "function"
    ) {
      return;
    }

    const handleDeviceChange = (): void => {
      void refresh();
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
