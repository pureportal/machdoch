import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ChatSessionContextAttachment } from "../../chat-session.model";
import {
  ContextAttachmentsList,
  MessageAttachmentsList,
} from "./context-attachments";

const createAttachment = (
  overrides: Partial<ChatSessionContextAttachment> = {},
): ChatSessionContextAttachment => ({
  id: "attachment-1",
  path: "C:\\Screenshots\\screen.png",
  kind: "image",
  name: "screen.png",
  parent: "C:\\Screenshots",
  ...overrides,
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
