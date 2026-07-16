import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach } from "vitest";
import type {
  ChatSessionContextAttachment,
  ChatSessionPathContextAttachment,
} from "../../chat-session.model";
import {
  ContextAttachmentMenuButton,
  ContextAttachmentsList,
  MessageAttachmentsList,
} from "./context-attachments";

afterEach(() => {
  cleanup();
});

const createAttachment = (
  overrides: Partial<ChatSessionPathContextAttachment> = {},
): ChatSessionContextAttachment => ({
  id: "attachment-1",
  path: "C:\\Screenshots\\screen.png",
  kind: "image",
  name: "screen.png",
  parent: "C:\\Screenshots",
  ...overrides,
});

describe("ContextAttachmentMenuButton", () => {
  it("opens the Media Library picker from the context menu", async () => {
    const onBrowseMediaAssets = vi.fn();
    render(
      <ContextAttachmentMenuButton
        onSelectFiles={vi.fn()}
        onSelectFolders={vi.fn()}
        onSelectImages={vi.fn()}
        onBrowseMediaAssets={onBrowseMediaAssets}
      />,
    );

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Add context" }),
      { button: 0, ctrlKey: false },
    );
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Media Library" }),
    );

    expect(onBrowseMediaAssets).toHaveBeenCalledTimes(1);
  });

  it("starts a new Media Studio creation from the context menu", async () => {
    const onCreateMediaAsset = vi.fn();
    render(
      <ContextAttachmentMenuButton
        onSelectFiles={vi.fn()}
        onSelectFolders={vi.fn()}
        onSelectImages={vi.fn()}
        onCreateMediaAsset={onCreateMediaAsset}
      />,
    );

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Add context" }),
      { button: 0, ctrlKey: false },
    );
    fireEvent.click(
      await screen.findByRole("menuitem", {
        name: "Create in Media Studio",
      }),
    );

    expect(onCreateMediaAsset).toHaveBeenCalledTimes(1);
  });

  it("keeps Media Library unavailable when the active model cannot use images", async () => {
    render(
      <ContextAttachmentMenuButton
        onSelectFiles={vi.fn()}
        onSelectFolders={vi.fn()}
        onSelectImages={vi.fn()}
        onBrowseMediaAssets={vi.fn()}
        mediaLibraryDisabled
        mediaLibraryDisabledReason="Choose a vision-capable model"
      />,
    );

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Add context" }),
      { button: 0, ctrlKey: false },
    );
    const item = await screen.findByRole("menuitem", { name: "Media Library" });
    expect(item.getAttribute("aria-disabled")).toBe("true");
    expect(item.getAttribute("title")).toBe("Choose a vision-capable model");
  });
});

describe("ContextAttachmentsList", () => {
  it("keeps the clear action on the same row as the attachment chips", () => {
    const { container } = render(
      <ContextAttachmentsList
        attachments={[createAttachment()]}
        onRemove={vi.fn()}
        onClearAll={vi.fn()}
      />,
    );

    const wrapper = container.querySelector(".app-context-attachments-list");
    const attachedContext = screen.getByRole("list", {
      name: "Attached context",
    });
    const clearButton = screen.getByRole("button", {
      name: "Remove all attached context",
    });

    expect(wrapper).not.toBeNull();
    expect(wrapper?.className).toContain(
      "grid-cols-[minmax(0,1fr)_auto]",
    );
    expect(wrapper?.children.item(0)).toBe(attachedContext);
    expect(wrapper?.children.item(1)).toBe(clearButton);
    expect(within(attachedContext).getByText("screen.png")).toBeDefined();
  });

  it("clears all attachments from the inline clear action", () => {
    const onClearAll = vi.fn();

    render(
      <ContextAttachmentsList
        attachments={[createAttachment()]}
        onRemove={vi.fn()}
        onClearAll={onClearAll}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Remove all attached context" }),
    );

    expect(onClearAll).toHaveBeenCalledTimes(1);
  });

  it("opens attachment chips without interfering with remove", () => {
    const onOpen = vi.fn();
    const onRemove = vi.fn();
    const attachment = createAttachment({
      kind: "file",
      name: "notes.md",
      path: "C:\\Screenshots\\notes.md",
    });

    render(
      <ContextAttachmentsList
        attachments={[attachment]}
        onOpen={onOpen}
        onRemove={onRemove}
        onClearAll={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Show file notes.md" }));

    expect(onOpen).toHaveBeenCalledWith(attachment);

    fireEvent.click(screen.getByRole("button", { name: "Remove notes.md" }));

    expect(onRemove).toHaveBeenCalledWith(attachment.id);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});

describe("MessageAttachmentsList", () => {
  it("labels message attachment actions by attachment type", () => {
    const onOpen = vi.fn();
    const folderAttachment = createAttachment({
      id: "folder-attachment",
      path: "C:\\Screenshots\\references",
      kind: "directory",
      name: "references",
    });

    render(
      <MessageAttachmentsList
        attachments={[
          createAttachment({
            id: "file-attachment",
            kind: "file",
            name: "notes.md",
            path: "C:\\Screenshots\\notes.md",
          }),
          folderAttachment,
          createAttachment(),
        ]}
        onOpen={onOpen}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Show file notes.md" }),
    ).toBeDefined();
    expect(
      screen.getByRole("button", { name: "Open folder references" }),
    ).toBeDefined();
    expect(
      screen.getByRole("button", { name: "Preview image screen.png" }),
    ).toBeDefined();

    fireEvent.click(
      screen.getByRole("button", { name: "Open folder references" }),
    );

    expect(onOpen).toHaveBeenCalledWith(folderAttachment);
  });
});
