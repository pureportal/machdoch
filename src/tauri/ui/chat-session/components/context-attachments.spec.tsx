import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ChatSessionContextAttachment } from "../../chat-session.model";
import { ContextAttachmentsList } from "./context-attachments";

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
});
