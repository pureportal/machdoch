// @vitest-environment jsdom

import { createElement } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaAssetRecord } from "../../../../core/media/contracts.js";
import { MediaAssetPreview } from "./media-visual-preview";
import { readMediaAssetReferencePreview } from "../media-runtime";

vi.mock("../media-runtime", () => ({
  readMediaAssetReferencePreview: vi
    .fn()
    .mockRejectedValue(new Error("Asset file is unavailable")),
}));

const missingAsset: MediaAssetRecord = {
  id: "asset-missing",
  runId: "run-completed",
  digest: "a".repeat(64),
  kind: "image",
  mimeType: "image/png",
  byteSize: 128,
  width: 512,
  height: 512,
  createdAt: "2026-08-20T10:00:01.000Z",
  outputIndex: 0,
  fixture: false,
  operation: null,
  sourceAssetIds: [],
  tags: [],
};

let intersect: IntersectionObserverCallback;
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(readMediaAssetReferencePreview).mockRejectedValue(
    new Error("Asset file is unavailable"),
  );
  vi.stubGlobal("URL", {
    createObjectURL: vi.fn(() => "blob:video-preview"),
    revokeObjectURL: vi.fn(),
  });
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: IntersectionObserverCallback) {
        intersect = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const reveal = (): void => {
  act(() =>
    intersect(
      [{ isIntersecting: true } as IntersectionObserverEntry],
      {} as IntersectionObserver,
    ),
  );
};

describe("MediaAssetPreview", () => {
  it.each(["none", "ping-pong", "seamless", "crossfade"] as const)(
    "previews %s video with its intended playback mode and alpha backdrop",
    async (loopMode) => {
      vi.mocked(readMediaAssetReferencePreview).mockResolvedValue(
        new Blob([], { type: "video/webm" }),
      );
      const asset: MediaAssetRecord = {
        ...missingAsset,
        kind: "video",
        mimeType: "video/webm",
        operation: {
          kind: "local-video-generation",
          output: { hasAlpha: true, loopMode },
        } as MediaAssetRecord["operation"],
      };
      const { unmount } = render(
        createElement(MediaAssetPreview, { asset, controls: true }),
      );
      reveal();
      const video = (await screen.findByLabelText(
        "Video 1",
      )) as HTMLVideoElement;
      expect(video.loop).toBe(loopMode !== "none");
      expect(video.controls).toBe(true);
      expect(video.style.backgroundSize).toBe("16px 16px");
      unmount();
      expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:video-preview");
    },
  );
  it("replaces an unavailable media file with a failure state", async () => {
    render(createElement(MediaAssetPreview, { asset: missingAsset }));
    reveal();

    expect(
      await screen.findByRole("img", { name: "Preview unavailable" }),
    ).toBeTruthy();
  });
  it("defers offscreen preview work and requests the inspection resolution when visible", async () => {
    render(
      createElement(MediaAssetPreview, { asset: missingAsset, maxEdge: 2048 }),
    );
    expect(readMediaAssetReferencePreview).not.toHaveBeenCalled();
    reveal();
    await screen.findByRole("img", { name: "Preview unavailable" });
    expect(readMediaAssetReferencePreview).toHaveBeenCalledWith(
      missingAsset.id,
      2048,
      "image/webp",
    );
  });
  it("requests video previews with their actual content type", async () => {
    render(
      createElement(MediaAssetPreview, {
        asset: { ...missingAsset, kind: "video", mimeType: "video/webm" },
      }),
    );
    reveal();
    await screen.findByRole("img", { name: "Preview unavailable" });
    expect(readMediaAssetReferencePreview).toHaveBeenCalledWith(
      missingAsset.id,
      768,
      "video/webm",
    );
  });
});
