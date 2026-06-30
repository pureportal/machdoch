import { describe, expect, it } from "vitest";
import {
  appendContextAttachmentsToTask,
  createContextAttachmentFromReference,
  createContextAttachmentsFromTaskBlock,
  isLinkContextAttachment,
  stripContextAttachmentsTaskBlock,
} from "./session-context-attachments";

describe("session context attachments", () => {
  it("creates link attachments and preserves them in hidden task context", () => {
    const attachment = createContextAttachmentFromReference(
      "https://example.com/docs/intro",
    );

    expect(attachment).toMatchObject({
      path: "https://example.com/docs/intro",
      kind: "other",
      name: "example.com/docs/intro",
    });
    expect(attachment && isLinkContextAttachment(attachment)).toBe(true);

    const task = appendContextAttachmentsToTask("Review this", [
      attachment!,
    ]);

    expect(task).toBe(
      'Review this\n\nUse this link: "https://example.com/docs/intro"',
    );
    expect(stripContextAttachmentsTaskBlock(task)).toBe("Review this");
    expect(createContextAttachmentsFromTaskBlock(task)).toMatchObject([
      {
        path: "https://example.com/docs/intro",
        kind: "other",
        name: "example.com/docs/intro",
      },
    ]);
  });
});
