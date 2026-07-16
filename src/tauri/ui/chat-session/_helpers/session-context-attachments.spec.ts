import { describe, expect, it } from "vitest";
import {
  appendContextAttachmentsToTask,
  createContextAttachmentFromMediaAsset,
  createContextAttachmentFromReference,
  createContextAttachmentsFromTaskBlock,
  getImageAttachmentMediaReferences,
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

  it("keeps Media Studio image references path-free and model-ready", () => {
    const attachment = createContextAttachmentFromMediaAsset({
      source: "media-asset",
      workspaceRoot: "C:\\Project",
      assetId: "asset:approved-image",
      kind: "image",
      displayName: "Approved cutout",
      rendition: "original",
    });
    const task = appendContextAttachmentsToTask("Describe this", [attachment]);

    expect(attachment).not.toHaveProperty("path");
    expect(task).toBe(
      'Describe this\n\nUse this Media Studio image asset: "asset:approved-image"',
    );
    expect(stripContextAttachmentsTaskBlock(task)).toBe("Describe this");
    expect(getImageAttachmentMediaReferences([attachment])).toEqual([
      {
        source: "media-asset",
        workspaceRoot: "C:\\Project",
        assetId: "asset:approved-image",
        kind: "image",
        displayName: "Approved cutout",
        rendition: "original",
      },
    ]);
  });
});
