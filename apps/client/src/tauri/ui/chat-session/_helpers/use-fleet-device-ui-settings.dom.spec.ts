// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useFleetDeviceUiSettings } from "./use-fleet-device-ui-settings";
import type { ChatSessionVoiceController } from "./use-chat-session-voice";
import type { ChatSessionSpeechInputController } from "./use-chat-session-speech-input";

const { invoke, listen, windowLabel, flush, refresh } = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  windowLabel: vi.fn(() => "main"),
  flush: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));
vi.mock(
  "@machdoch/media-studio/tauri/ui/lib/_helpers/shell-store-storage.helper.js",
  () => ({ getCurrentShellWindowLabel: windowLabel }),
);
beforeEach(() => {
  listen.mockResolvedValue(vi.fn());
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  windowLabel.mockReturnValue("main");
});

function useDevice(supported = true): void {
  const [rate, setRate] = useState(1);
  const [autoSpeakResponses, setAutoSpeakResponses] = useState(false);
  const [preferredVoiceURI, setPreferredVoiceURI] = useState<string | null>(
    null,
  );
  const voice: ChatSessionVoiceController = {
    supported,
    systemVoicesSupported: true,
    autoSpeakResponses,
    preferredVoiceURI,
    rate,
    availabilityDescription: "Voice configured",
    speakingMessageId: null,
    voiceOptions: [
      {
        voiceURI: "device-voice",
        label: "Device voice",
        lang: "en",
        isDefault: true,
      },
    ],
    setRate,
    setAutoSpeakResponses,
    setPreferredVoiceURI,
    speakMessage: vi.fn(),
    stopSpeaking: vi.fn(),
  };
  const speechInput: ChatSessionSpeechInputController = {
    browserSupported: true,
    enabled: true,
    selectedProvider: "whisper",
    configuredProvider: null,
    recording: false,
    starting: false,
    transcribing: false,
    level: 0,
    statusText: null,
    statusTone: null,
    availabilityDescription: "Speech configured",
    toggleRecording: vi.fn(),
    setRecording: vi.fn(),
    cancelSpeechInput: vi.fn(),
    dismissStatus: vi.fn(),
  };
  useFleetDeviceUiSettings({
    voice,
    speechInput,
    speechInputDevices: {
      supported: true,
      refreshing: false,
      devices: [{ deviceId: "mic", label: "Device microphone" }],
      errorText: null,
      refresh,
    },
    flushPersistence: flush,
  });
}

async function request(
  command: string,
  args: Record<string, unknown> = {},
): Promise<void> {
  await waitFor(() => expect(listen).toHaveBeenCalled());
  const handler = listen.mock.calls[0]![1] as (event: unknown) => void;
  await act(async () => {
    handler({ payload: { id: "request", command, args } });
  });
}

describe("client confirmation of remote voice settings", () => {
  it("returns actual device voices and microphones", async () => {
    renderHook(() => useDevice());
    await request("get_device_voice_preferences");
    expect(invoke).toHaveBeenCalledWith("complete_fleet_client_request", {
      id: "request",
      error: null,
      result: expect.objectContaining({
        rate: 1,
        voiceOptions: [expect.objectContaining({ voiceURI: "device-voice" })],
        speechInputDevices: [{ deviceId: "mic", label: "Device microphone" }],
      }),
    });
  });

  it("waits for persisted preferences before confirming the changed state", async () => {
    let finish!: () => void;
    flush.mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    renderHook(() => useDevice());
    await request("save_device_voice_preferences", {
      rate: 1.3,
      autoSpeakResponses: true,
      preferredVoiceURI: "device-voice",
    });
    expect(flush).toHaveBeenCalledOnce();
    expect(invoke).not.toHaveBeenCalled();
    await act(async () => {
      finish();
    });
    expect(invoke).toHaveBeenCalledWith("complete_fleet_client_request", {
      id: "request",
      error: null,
      result: expect.objectContaining({
        rate: 1.3,
        autoSpeakResponses: true,
        preferredVoiceURI: "device-voice",
      }),
    });
  });

  it("reports failed persistence without confirming success", async () => {
    flush.mockRejectedValue(new Error("Storage is unavailable."));
    renderHook(() => useDevice());
    await request("save_device_voice_preferences", {
      rate: 1.3,
      autoSpeakResponses: false,
      preferredVoiceURI: null,
    });
    expect(invoke).toHaveBeenCalledWith("complete_fleet_client_request", {
      id: "request",
      result: null,
      error: "Storage is unavailable.",
    });
  });

  it("rejects a voice from the browser rather than the device list", async () => {
    renderHook(() => useDevice());
    await request("save_device_voice_preferences", {
      rate: 1,
      autoSpeakResponses: false,
      preferredVoiceURI: "browser-voice",
    });
    expect(invoke).toHaveBeenCalledWith("complete_fleet_client_request", {
      id: "request",
      result: null,
      error: "Choose a voice listed on this device.",
    });
    expect(flush).not.toHaveBeenCalled();
  });

  it("requires configured playback before enabling automatic speech", async () => {
    renderHook(() => useDevice(false));
    await request("save_device_voice_preferences", {
      rate: 1,
      autoSpeakResponses: true,
      preferredVoiceURI: null,
    });
    expect(invoke).toHaveBeenCalledWith("complete_fleet_client_request", {
      id: "request",
      result: null,
      error: "Configure voice playback before enabling automatic speech.",
    });
    expect(flush).not.toHaveBeenCalled();
  });

  it("does not subscribe in a secondary window", () => {
    windowLabel.mockReturnValue("quick-voice");
    renderHook(() => useDevice());
    expect(listen).not.toHaveBeenCalled();
  });
});
