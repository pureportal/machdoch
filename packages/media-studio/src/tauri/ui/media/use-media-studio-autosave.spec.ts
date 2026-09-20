// @vitest-environment jsdom

import type { MediaStudioState } from "../../../core/media/contracts.js";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  DEFAULT_MEDIA_STUDIO_STATE,
  saveMediaStudioState,
} from "./media-studio-store";
import { useMediaStudioAutosave } from "./use-media-studio-autosave";

vi.mock("./media-studio-store", async (original) => ({
  ...(await original<typeof import("./media-studio-store")>()),
  saveMediaStudioState: vi.fn().mockResolvedValue(undefined),
}));

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(saveMediaStudioState).mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const edited: MediaStudioState = {
  ...DEFAULT_MEDIA_STUDIO_STATE,
  recipe: {
    ...DEFAULT_MEDIA_STUDIO_STATE.recipe,
    prompt: "Keep this prompt",
    seed: 42,
    modelAddons: [
      {
        kind: "lora" as const,
        addonId: "portrait",
        enabled: true,
        modelStrength: 0.65,
        textEncoderStrength: null,
        denoisingSchedule: { start: 0.1, end: 0.8 },
      },
    ],
  },
};

it("flushes the latest complete draft when leaving before the save delay", async () => {
  const view = renderHook(({ state }) => useMediaStudioAutosave(state, true), {
    initialProps: { state: DEFAULT_MEDIA_STUDIO_STATE as MediaStudioState },
  });
  view.rerender({ state: edited });
  expect(saveMediaStudioState).not.toHaveBeenCalled();
  view.unmount();
  expect(saveMediaStudioState).toHaveBeenCalledExactlyOnceWith(edited);
  await act(() => vi.runAllTimersAsync());
  expect(saveMediaStudioState).toHaveBeenCalledTimes(1);
});

it("coalesces typing and flushes on page exit", async () => {
  const view = renderHook(({ state }) => useMediaStudioAutosave(state, true), {
    initialProps: { state: edited },
  });
  view.rerender({
    state: { ...edited, recipe: { ...edited.recipe, prompt: "Latest prompt" } },
  });
  await act(async () => {
    window.dispatchEvent(new Event("pagehide"));
  });
  expect(saveMediaStudioState).toHaveBeenCalledTimes(1);
  expect(vi.mocked(saveMediaStudioState).mock.lastCall?.[0].recipe.prompt).toBe(
    "Latest prompt",
  );
  view.unmount();
  expect(saveMediaStudioState).toHaveBeenCalledTimes(1);
});

it("does not overwrite storage while loading or after a failed load", async () => {
  const view = renderHook(() => useMediaStudioAutosave(edited, false));
  await act(() => vi.runAllTimersAsync());
  await act(() => view.result.current.retry());
  view.unmount();
  expect(saveMediaStudioState).not.toHaveBeenCalled();
});

it("surfaces save failures and retries the latest settings", async () => {
  vi.mocked(saveMediaStudioState).mockRejectedValueOnce(new Error("Disk full"));
  const view = renderHook(() => useMediaStudioAutosave(edited, true));
  await act(() => vi.advanceTimersByTimeAsync(250));
  expect(view.result.current.error).toBe("Disk full");
  await act(() => view.result.current.retry());
  expect(view.result.current.error).toBeNull();
  expect(saveMediaStudioState).toHaveBeenLastCalledWith(edited);
});
