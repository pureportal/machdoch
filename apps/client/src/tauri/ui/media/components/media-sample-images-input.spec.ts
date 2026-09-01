// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement, type ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MediaSampleImagesInput } from "./media-sample-images-input";

const runtimeMocks = vi.hoisted(() => ({
  openDialog: vi.fn(),
  saveClipboardImageAttachment: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: runtimeMocks.openDialog,
}));

vi.mock("../../runtime", () => ({
  saveClipboardImageAttachment: runtimeMocks.saveClipboardImageAttachment,
}));

vi.mock("./media-visual-preview", () => ({
  MediaAssetPreview: () => null,
}));

type Props = ComponentProps<typeof MediaSampleImagesInput>;

const createProps = (overrides: Partial<Props> = {}): Props => ({
  assets: [],
  sampleAssetIds: [],
  sampleImages: [],
  disabled: false,
  onChange: vi.fn(),
  onImportPaths: vi.fn(async () => []),
  onDownloadUrl: vi.fn(async () => null),
  ...overrides,
});

beforeEach(() => {
  runtimeMocks.openDialog.mockReset();
  runtimeMocks.saveClipboardImageAttachment.mockReset();
});

describe("MediaSampleImagesInput", () => {
  it("imports pasted image files and selects the resulting assets", async () => {
    const onChange = vi.fn();
    const onImportPaths = vi.fn(async () => ["asset:pasted"]);
    runtimeMocks.saveClipboardImageAttachment.mockResolvedValue(
      "C:\\temp\\pasted.png",
    );
    render(
      createElement(
        MediaSampleImagesInput,
        createProps({ onChange, onImportPaths }),
      ),
    );

    const image = new File([new Uint8Array([1, 2, 3])], "pasted.png", {
      type: "image/png",
    });
    fireEvent.paste(
      screen.getByRole("group", { name: "Drop or paste sample images" }),
      { clipboardData: { files: [image] } },
    );

    await waitFor(() =>
      expect(runtimeMocks.saveClipboardImageAttachment).toHaveBeenCalledWith({
        blob: image,
        fileName: "pasted.png",
      }),
    );
    expect(onImportPaths).toHaveBeenCalledWith(["C:\\temp\\pasted.png"]);
    expect(onChange).toHaveBeenCalledWith(["asset:pasted"], []);
  });

  it("adds multiple images from the native file picker", async () => {
    const onChange = vi.fn();
    const onImportPaths = vi.fn(async () => ["asset:one", "asset:two"]);
    runtimeMocks.openDialog.mockResolvedValue([
      "C:\\images\\one.png",
      "C:\\images\\two.webp",
    ]);
    render(
      createElement(
        MediaSampleImagesInput,
        createProps({ onChange, onImportPaths }),
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "Add images" }));

    await waitFor(() =>
      expect(onImportPaths).toHaveBeenCalledWith([
        "C:\\images\\one.png",
        "C:\\images\\two.webp",
      ]),
    );
    expect(onChange).toHaveBeenCalledWith(["asset:one", "asset:two"], []);
  });

  it("imports only the sample slots that remain", async () => {
    const onImportPaths = vi.fn(async () => ["asset:one"]);
    runtimeMocks.openDialog.mockResolvedValue([
      "C:\\images\\one.png",
      "C:\\images\\two.webp",
    ]);
    render(
      createElement(
        MediaSampleImagesInput,
        createProps({
          sampleImages: Array.from({ length: 11 }, (_, index) => ({
            url: `https://images.example.com/${index}.webp`,
            width: 512,
            height: 512,
          })),
          onImportPaths,
        }),
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "Add images" }));

    await waitFor(() =>
      expect(onImportPaths).toHaveBeenCalledWith(["C:\\images\\one.png"]),
    );
  });

  it("downloads pasted or dropped HTTPS image links", async () => {
    const onChange = vi.fn();
    const onDownloadUrl = vi.fn(async () => "asset:downloaded");
    render(
      createElement(
        MediaSampleImagesInput,
        createProps({ onChange, onDownloadUrl }),
      ),
    );

    const input = screen.getByRole("textbox", { name: "Sample image URL" });
    fireEvent.change(input, {
      target: { value: "https://images.example.com/sample.webp" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Download" }));

    await waitFor(() =>
      expect(onDownloadUrl).toHaveBeenCalledWith(
        "https://images.example.com/sample.webp",
      ),
    );
    expect(onChange).toHaveBeenCalledWith(["asset:downloaded"], []);

    onDownloadUrl.mockResolvedValue("asset:dropped");
    fireEvent.drop(
      screen.getByRole("group", { name: "Drop or paste sample images" }),
      {
        dataTransfer: {
          files: [],
          getData: (type: string) =>
            type === "text/uri-list"
              ? "https://images.example.com/dropped.png"
              : "",
        },
      },
    );

    await waitFor(() =>
      expect(onDownloadUrl).toHaveBeenLastCalledWith(
        "https://images.example.com/dropped.png",
      ),
    );

    onDownloadUrl.mockResolvedValue("asset:pasted-link");
    fireEvent.paste(
      screen.getByRole("group", { name: "Drop or paste sample images" }),
      {
        clipboardData: {
          files: [],
          getData: (type: string) =>
            type === "text/plain"
              ? "https://images.example.com/pasted.jpg"
              : "",
        },
      },
    );

    await waitFor(() =>
      expect(onDownloadUrl).toHaveBeenLastCalledWith(
        "https://images.example.com/pasted.jpg",
      ),
    );
  });
});
