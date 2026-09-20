// @vitest-environment jsdom

import { createElement, useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MediaAssetRecord } from "../../../../core/media/contracts.js";
import { createEmptyMediaGenerationAssetMetadata } from "../../../../core/media/asset-metadata.js";
import { MediaAssetBrowser } from "./media-asset-browser";

vi.mock("./media-visual-preview", () => ({ MediaAssetPreview: () => null }));
afterEach(cleanup);

const assets: MediaAssetRecord[] = Array.from({ length: 30 }, (_, index) => ({
  id: `asset:${index}`,
  runId: "run:1",
  digest: "a".repeat(64),
  kind: "image",
  mimeType: "image/png",
  byteSize: 100,
  width: 512,
  height: 512,
  createdAt: "2026-09-15T00:00:00Z",
  outputIndex: index,
  fixture: false,
  operation: null,
  sourceAssetIds: [],
  tags: [],
}));

describe("MediaAssetBrowser", () => {
  it("retains selected IDs across pages, filters, and sorting", () => {
    let selected: string[] = [];
    const Harness = () => {
      const [ids, setIds] = useState<string[]>([]);
      return createElement(MediaAssetBrowser, {
        assets,
        categories: [{ id: "style", name: "Illustration" }],
        metadata: {
          "asset:28": {
            ...createEmptyMediaGenerationAssetMetadata(),
            tags: ["anime"],
            categoryIds: ["style"],
          },
        },
        selectedIds: ids,
        onSelect: (asset) => {
          selected = ids.includes(asset.id)
            ? ids.filter((id) => id !== asset.id)
            : [...ids, asset.id];
          setIds(selected);
        },
      });
    };
    render(createElement(Harness));
    fireEvent.click(screen.getByRole("button", { name: "Image 1" }));
    fireEvent.click(screen.getByRole("button", { name: "Next images page" }));
    fireEvent.click(screen.getByRole("button", { name: "Image 29" }));
    fireEvent.change(screen.getByLabelText("Search images"), {
      target: { value: "anime illustration" },
    });
    expect(screen.queryByRole("button", { name: "Image 1" })).toBeNull();
    expect(
      screen
        .getByRole("button", { name: "Image 29" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(selected).toEqual(["asset:0", "asset:28"]);
    fireEvent.change(screen.getByLabelText("Search images"), {
      target: { value: "" },
    });
    fireEvent.change(screen.getByLabelText("Sort images"), {
      target: { value: "name-desc" },
    });
    fireEvent.click(screen.getByLabelText("Selected only"));
    expect(
      screen
        .getByRole("button", { name: "Image 1" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Image 29" }));
    expect(selected).toEqual(["asset:0"]);
  });
});
