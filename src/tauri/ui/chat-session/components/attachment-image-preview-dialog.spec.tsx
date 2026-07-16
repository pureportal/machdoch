import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach } from "vitest";
import type {
  ChatSessionMediaAssetAttachment,
  ChatSessionPathContextAttachment,
} from "../../chat-session.model";
import { AttachmentImagePreviewDialog } from "./attachment-image-preview-dialog";

afterEach(() => {
  cleanup();
});

const mediaAttachment: ChatSessionMediaAssetAttachment = {
  id: "attachment-media-1",
  source: "media-asset",
  workspaceRoot: "C:\\Project",
  assetId: "asset-1",
  kind: "image",
  name: "Generated portrait",
  displayName: "Generated portrait",
  rendition: "preview",
};

const pathAttachment: ChatSessionPathContextAttachment = {
  id: "attachment-path-1",
  source: "path",
  path: "C:\\Project\\portrait.png",
  kind: "image",
  name: "portrait.png",
};

describe("AttachmentImagePreviewDialog", () => {
  it("opens an attached Media Studio asset for non-destructive editing", () => {
    const onEditMediaAsset = vi.fn();
    render(
      <AttachmentImagePreviewDialog
        preview={{
          attachment: mediaAttachment,
          source: "data:image/png;base64,iVBORw0KGgo=",
          loading: false,
          error: null,
        }}
        onOpenChange={vi.fn()}
        onEditMediaAsset={onEditMediaAsset}
      />,
    );

    expect(screen.getByText("Media Studio asset · asset-1")).toBeDefined();
    fireEvent.click(
      screen.getByRole("button", { name: "Edit in Media Studio" }),
    );

    expect(onEditMediaAsset).toHaveBeenCalledWith(mediaAttachment);
  });

  it("does not offer Media Studio editing for a filesystem image", () => {
    const onSaveToMediaLibrary = vi.fn();
    render(
      <AttachmentImagePreviewDialog
        preview={{
          attachment: pathAttachment,
          source: "data:image/png;base64,iVBORw0KGgo=",
          loading: false,
          error: null,
        }}
        onOpenChange={vi.fn()}
        onEditMediaAsset={vi.fn()}
        onSaveToMediaLibrary={onSaveToMediaLibrary}
      />,
    );

    expect(
      screen.queryByRole("button", { name: "Edit in Media Studio" }),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Save to Media Library" }),
    );
    expect(onSaveToMediaLibrary).toHaveBeenCalledWith(pathAttachment);
  });
});
