// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MediaTrainView } from "./media-train-view";

const mocks = vi.hoisted(() => ({
  open: vi.fn(),
  inspectImages: vi.fn(),
}));

vi.mock("../media-platform", () => ({
  hasMediaHost: () => true,
  isRemoteMedia: () => false,
  open: mocks.open,
  openUrl: vi.fn(),
}));

vi.mock("../krea-training", () => ({
  inspectKreaTrainingImages: mocks.inspectImages,
}));

vi.mock("../media-runtime", () => ({
  importMediaModelAddon: vi.fn(),
  inspectMediaModelAddon: vi.fn(),
}));

beforeEach(() => {
  localStorage.clear();
  mocks.open.mockReset();
  mocks.inspectImages.mockReset();
});

describe("MediaTrainView", () => {
  it("shows dataset and resolution warnings for inspected images", async () => {
    const paths = ["C:\\images\\one.png", "C:\\images\\two.png", "C:\\images\\three.png"];
    mocks.open.mockResolvedValue(paths);
    mocks.inspectImages.mockResolvedValue(paths.map((path) => ({ path, width: 512, height: 512 })));
    render(createElement(MediaTrainView, { onImported: vi.fn(), onUseAddon: vi.fn(), canUseAddon: false, onFindModel: vi.fn() }));

    fireEvent.click(screen.getByRole("button", { name: "Add images" }));
    await waitFor(() => expect(screen.getByText("Images (3)")).toBeTruthy());
    expect(screen.getByText("Only 3 images. Add varied examples for more reliable results.")).toBeTruthy();
    expect(screen.getByText("3 images are smaller than the 768px training size. Use larger originals.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Advanced settings" }));
    fireEvent.change(screen.getByLabelText("Resolution"), { target: { value: "512" } });
    expect(screen.queryByText(/images are smaller/u)).toBeNull();
  });

  it("keeps undecodable images out of the dataset", async () => {
    mocks.open.mockResolvedValue(["C:\\images\\broken.png"]);
    mocks.inspectImages.mockRejectedValue(new Error("broken.png could not be decoded. Choose another image."));
    render(createElement(MediaTrainView, { onImported: vi.fn(), onUseAddon: vi.fn(), canUseAddon: false, onFindModel: vi.fn() }));

    fireEvent.click(screen.getByRole("button", { name: "Add images" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("could not be decoded"));
    expect(screen.getByText("Images (0)")).toBeTruthy();
  });
});
