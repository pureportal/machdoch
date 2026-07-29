import { describe, expect, it, vi } from "vitest";
import {
  getFilePreviewTargetLineIndex,
  scrollFilePreviewTargetLineIntoView,
} from "./file-preview-target-line";

describe("getFilePreviewTargetLineIndex", () => {
  it("converts a valid one-based source line to a preview line index", () => {
    expect(getFilePreviewTargetLineIndex(13, 40)).toBe(12);
  });

  it.each([null, undefined, 0, -1, 1.5, Number.NaN, 41])(
    "does not navigate for an invalid or unavailable target line %s",
    (targetLine) => {
      expect(getFilePreviewTargetLineIndex(targetLine, 40)).toBeNull();
    },
  );
});

describe("scrollFilePreviewTargetLineIntoView", () => {
  it("centers the requested line in the file preview", () => {
    const scrollIntoView = vi.fn();

    expect(
      scrollFilePreviewTargetLineIntoView({
        scrollIntoView,
      }),
    ).toBe(true);
    expect(scrollIntoView).toHaveBeenCalledWith({
      block: "center",
      inline: "nearest",
    });
  });

  it("does nothing while no rendered target line is available", () => {
    expect(scrollFilePreviewTargetLineIntoView(null)).toBe(false);
  });
});
