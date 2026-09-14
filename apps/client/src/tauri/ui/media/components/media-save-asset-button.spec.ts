// @vitest-environment jsdom

import { createElement } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { save } from "@tauri-apps/plugin-dialog";
import { exportMediaAsset } from "../media-runtime";
import type { MediaAssetRecord } from "../../../../core/media/contracts.js";
import { MediaSaveAssetButton } from "./media-save-asset-button";

vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn() }));
vi.mock("../media-runtime", () => ({ exportMediaAsset: vi.fn() }));

const asset: MediaAssetRecord = {
  id: "report:1",
  runId: "run:1",
  kind: "report",
  mimeType: "application/json",
  digest: "a".repeat(64),
  byteSize: 100,
  width: 0,
  height: 0,
  createdAt: "2026-09-14T00:00:00Z",
  outputIndex: 0,
  fixture: false,
  operation: null,
  sourceAssetIds: [],
  tags: [],
};
beforeEach(() => vi.resetAllMocks());
afterEach(cleanup);

describe("saving media", () => {
  it("labels reports correctly and confirms only a successful export", async () => {
    vi.mocked(save).mockResolvedValue("C:\\results\\review.json");
    render(createElement(MediaSaveAssetButton, { asset }));
    fireEvent.click(screen.getByRole("button", { name: "Save report" }));
    await screen.findByRole("button", { name: "Saved" });
    expect(exportMediaAsset).toHaveBeenCalledWith({
      assetId: asset.id,
      destinationPath: "C:\\results\\review.json",
      mode: "verified-original",
    });
  });
  it("keeps a canceled save available and lets a failed export be retried", async () => {
    vi.mocked(save)
      .mockResolvedValueOnce(null)
      .mockResolvedValue("C:\\results\\review.json");
    vi.mocked(exportMediaAsset).mockRejectedValueOnce(
      new Error("Choose a writable folder."),
    );
    render(createElement(MediaSaveAssetButton, { asset }));
    fireEvent.click(screen.getByRole("button", { name: "Save report" }));
    await waitFor(() =>
      expect(
        (
          screen.getByRole("button", {
            name: "Save report",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    expect(exportMediaAsset).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Save report" }));
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "Choose a writable folder.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Save report" }));
    await screen.findByRole("button", { name: "Saved" });
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
