// @vitest-environment jsdom

import { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MediaAssetRecord } from "../../../../core/media/contracts.js";
import { MediaAssetPreview } from "./media-visual-preview";

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

afterEach(cleanup);

describe("MediaAssetPreview", () => {
  it("replaces an unavailable media file with a failure state", async () => {
    render(createElement(MediaAssetPreview, { asset: missingAsset }));

    expect(
      await screen.findByRole("img", { name: "Preview unavailable" }),
    ).toBeTruthy();
  });
});
