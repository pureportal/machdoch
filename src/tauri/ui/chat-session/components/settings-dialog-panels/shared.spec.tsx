import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SETTINGS_AUTO_SAVE_DEBOUNCE_MS,
  SettingsCredentialForm,
  useDebouncedAutoSave,
} from "./shared";

describe("useDebouncedAutoSave", () => {
  afterEach(async () => {
    cleanup();
    await act(async () => {
      await Promise.resolve();
    });
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("retries the same dirty signature after a rejected save", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const onSave = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValue(undefined);

    renderHook(() =>
      useDebouncedAutoSave({
        dirty: true,
        saving: false,
        signature: "unchanged-draft",
        onSave,
      }),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SETTINGS_AUTO_SAVE_DEBOUNCE_MS);
    });
    expect(onSave).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SETTINGS_AUTO_SAVE_DEBOUNCE_MS * 2);
    });
    expect(onSave).toHaveBeenCalledTimes(2);
  });

  it("stops retrying a permanently failing signature after three attempts", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const onSave = vi.fn<() => Promise<void>>().mockRejectedValue(new Error("no"));

    renderHook(() =>
      useDebouncedAutoSave({
        dirty: true,
        saving: false,
        signature: "permanent-failure",
        onSave,
      }),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SETTINGS_AUTO_SAVE_DEBOUNCE_MS);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SETTINGS_AUTO_SAVE_DEBOUNCE_MS * 2);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SETTINGS_AUTO_SAVE_DEBOUNCE_MS * 4);
    });
    expect(onSave).toHaveBeenCalledTimes(3);
  });

  it("keeps newer credential text when an older save finishes", async () => {
    vi.useFakeTimers();
    let finishSave!: (saved: boolean) => void;
    const onSave = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finishSave = resolve;
        }),
    );

    render(
      <SettingsCredentialForm
        resetKey="openai"
        providerLabel="OpenAI"
        keyValue="old"
        saving={false}
        message={null}
        dirtyText="dirty"
        cleanText="clean"
        onSave={onSave}
      />,
    );

    const input = screen.getByPlaceholderText("Paste your OpenAI API key");
    fireEvent.change(input, { target: { value: "submitted" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SETTINGS_AUTO_SAVE_DEBOUNCE_MS);
    });
    fireEvent.change(input, { target: { value: "newer" } });

    await act(async () => {
      finishSave(true);
      await Promise.resolve();
    });

    expect((input as HTMLInputElement).value).toBe("newer");
  });
});
