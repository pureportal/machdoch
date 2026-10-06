import { useCallback, useEffect, useRef, useState } from "react";
import {
  deviceVoicePreferencesSchema,
  type DeviceVoicePreferences,
} from "@machdoch/fleet-protocol/device-settings";
import { invokeDeviceSettingsCommand } from "../ui/device-settings-platform";

type PreferencesChange = Partial<
  Pick<
    DeviceVoicePreferences,
    "autoSpeakResponses" | "preferredVoiceURI" | "rate"
  >
>;

export function useRemoteVoiceSettings(): {
  preferences: DeviceVoicePreferences | null;
  error: string | null;
  save: (change: PreferencesChange) => void;
  refreshDevices: () => Promise<void>;
} {
  const [preferences, setPreferences] = useState<DeviceVoicePreferences | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const current = useRef(preferences);
  const pending = useRef(0);
  const mutations = useRef<Promise<void>>(Promise.resolve());
  const mounted = useRef(true);
  const apply = useCallback((value: unknown): void => {
    const next = deviceVoicePreferencesSchema.parse(value);
    current.current = next;
    if (mounted.current) {
      setPreferences(next);
      setError(null);
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async (): Promise<void> => {
      try {
        if (!pending.current) {
          const value = await invokeDeviceSettingsCommand(
            "get_device_voice_preferences",
          );
          if (mounted.current && !pending.current) apply(value);
        }
      } catch (cause) {
        if (mounted.current)
          setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (mounted.current) timer = setTimeout(() => void refresh(), 2_000);
      }
    };
    void refresh();
    return () => {
      mounted.current = false;
      clearTimeout(timer);
    };
  }, [apply]);
  const save = useCallback(
    (change: PreferencesChange): void => {
      pending.current += 1;
      mutations.current = mutations.current
        .then(async () => {
          const saved = current.current;
          if (!saved)
            throw new Error(
              "Voice settings have not loaded. Refresh settings.",
            );
          apply(
            await invokeDeviceSettingsCommand("save_device_voice_preferences", {
              preferredVoiceURI: saved.preferredVoiceURI,
              rate: saved.rate,
              autoSpeakResponses: saved.autoSpeakResponses,
              ...change,
            }),
          );
        })
        .catch((cause: unknown) => {
          if (mounted.current)
            setError(cause instanceof Error ? cause.message : String(cause));
        })
        .finally(() => {
          pending.current -= 1;
        });
    },
    [apply],
  );
  const refreshDevices = useCallback(async (): Promise<void> => {
    await mutations.current;
    pending.current += 1;
    try {
      apply(
        await invokeDeviceSettingsCommand(
          "refresh_device_speech_input_devices",
        ),
      );
    } catch (cause) {
      if (mounted.current)
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      pending.current -= 1;
    }
  }, [apply]);
  return { preferences, error, save, refreshDevices };
}
