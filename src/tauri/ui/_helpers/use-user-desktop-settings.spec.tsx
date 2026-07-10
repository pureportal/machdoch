import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as runtime from "../runtime";
import { useUserDesktopSettings } from "./use-user-desktop-settings";

describe("useUserDesktopSettings", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not let an older initial load overwrite a newer event", async () => {
    let resolveLoad!: (settings: runtime.UserDesktopSettings) => void;
    let publish!: (settings: runtime.UserDesktopSettings) => void;
    vi.spyOn(runtime, "loadUserDesktopSettings").mockReturnValue(
      new Promise((resolve) => {
        resolveLoad = resolve;
      }),
    );
    vi.spyOn(runtime, "subscribeToDesktopSettingsChanged").mockImplementation(
      async (onChange) => {
        publish = onChange;
        return () => undefined;
      },
    );

    const { result } = renderHook(() => useUserDesktopSettings());
    const newer = { ...result.current, quickVoiceEnabled: false };
    const older = { ...result.current, quickVoiceEnabled: true };

    await act(async () => {
      publish(newer);
      resolveLoad(older);
      await Promise.resolve();
    });

    expect(result.current.quickVoiceEnabled).toBe(false);
  });
});
