import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef } from "react";
import { flushSync } from "react-dom";
import { deviceSettingsCommands } from "@machdoch/fleet-protocol/device-settings";
import { getCurrentShellWindowLabel } from "@machdoch/media-studio/tauri/ui/lib/_helpers/shell-store-storage.helper.js";
import { createDeviceVoicePreferences } from "./voice-settings-controls";
import type { ChatSessionVoiceController } from "./use-chat-session-voice";
import type { ChatSessionSpeechInputController } from "./use-chat-session-speech-input";
import type { SpeechInputDevicesController } from "./use-speech-input-devices";

interface Options {
  voice: ChatSessionVoiceController;
  speechInput: ChatSessionSpeechInputController;
  speechInputDevices: SpeechInputDevicesController;
  flushPersistence: () => Promise<void>;
}

interface Request {
  id: string;
  command:
    | "get_device_voice_preferences"
    | "save_device_voice_preferences"
    | "refresh_device_speech_input_devices";
  args: Record<string, unknown>;
}

export function useFleetDeviceUiSettings(options: Options): void {
  const current = useRef(options);
  current.current = options;
  useEffect(() => {
    if (getCurrentShellWindowLabel() !== "main") return;
    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    const handle = async (request: Request): Promise<void> => {
      if (
        ![
          "get_device_voice_preferences",
          "save_device_voice_preferences",
          "refresh_device_speech_input_devices",
        ].includes(request.command)
      )
        return;
      let error: string | null = null;
      let result: Record<string, unknown> | null = null;
      try {
        if (!Object.hasOwn(deviceSettingsCommands, request.command))
          throw new Error("Unknown device voice settings operation.");
        deviceSettingsCommands[request.command].parse(request.args);
        if (request.command === "save_device_voice_preferences") {
          const preferences =
            deviceSettingsCommands.save_device_voice_preferences.parse(
              request.args,
            );
          const voice = current.current.voice;
          if (preferences.autoSpeakResponses && !voice.supported)
            throw new Error(
              "Configure voice playback before enabling automatic speech.",
            );
          if (
            preferences.preferredVoiceURI !== null &&
            preferences.preferredVoiceURI !== voice.preferredVoiceURI &&
            !voice.voiceOptions.some(
              (option) => option.voiceURI === preferences.preferredVoiceURI,
            )
          )
            throw new Error("Choose a voice listed on this device.");
          flushSync(() => {
            voice.setAutoSpeakResponses(preferences.autoSpeakResponses);
            voice.setPreferredVoiceURI(preferences.preferredVoiceURI);
            voice.setRate(preferences.rate);
          });
          await current.current.flushPersistence();
        } else if (request.command === "refresh_device_speech_input_devices") {
          await current.current.speechInputDevices.refresh();
          await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
        }
        const { voice, speechInput, speechInputDevices } = current.current;
        result = createDeviceVoicePreferences(
          voice,
          speechInput,
          speechInputDevices,
        );
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause);
      }
      await invoke("complete_fleet_client_request", {
        id: request.id,
        result,
        error,
      });
    };
    void listen<Request>("machdoch://fleet-client-request", (event) => {
      void handle(event.payload).catch((error: unknown) =>
        console.error("Device settings could not be confirmed", error),
      );
    })
      .then((stop) => {
        if (disposed) stop();
        else unsubscribe = stop;
      })
      .catch((error: unknown) =>
        console.error("Device settings could not be opened", error),
      );
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, []);
}
