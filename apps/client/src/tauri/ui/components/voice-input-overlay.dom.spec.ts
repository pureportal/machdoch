// @vitest-environment jsdom

import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VoiceInputOverlay } from "./voice-input-overlay";

afterEach(cleanup);

describe("voice input overlay cancellation", () => {
  it.each(["starting", "recording", "transcribing", "processing"])(
    "keeps Cancel enabled while %s",
    (stage) => {
      const onCancel = vi.fn();
      render(
        createElement(VoiceInputOverlay, {
          title: "Voice input",
          starting: stage === "starting",
          recording: stage === "recording",
          transcribing: stage === "transcribing" || stage === "processing",
          level: 0,
          statusText: stage === "processing" ? "Processing speech..." : null,
          primaryActionDisabled: stage !== "recording",
          onPrimaryAction: vi.fn(),
          onCancel,
        }),
      );
      const button = screen.getByRole<HTMLButtonElement>("button", {
        name: "Cancel",
      });
      expect(button.disabled).toBe(false);
      fireEvent.click(button);
      expect(onCancel).toHaveBeenCalledOnce();
      fireEvent.keyDown(window, { key: "Escape" });
      expect(onCancel).toHaveBeenCalledTimes(2);
    },
  );

  it("removes its Escape handler when returning to the normal view", () => {
    const onCancel = vi.fn();
    const { unmount } = render(
      createElement(VoiceInputOverlay, {
        title: "Voice input",
        recording: true,
        transcribing: false,
        level: 0,
        statusText: null,
        onPrimaryAction: vi.fn(),
        onCancel,
      }),
    );
    unmount();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCancel).not.toHaveBeenCalled();
  });
});
