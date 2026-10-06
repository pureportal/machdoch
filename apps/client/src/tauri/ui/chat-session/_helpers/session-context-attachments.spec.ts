import { describe, expect, it } from "vitest";
import { isLinkContextAttachment } from "@machdoch/client-ui/composer/model";
import { appendContextAttachmentsToTask, createContextAttachmentFromMediaAsset, getImageAttachmentMediaReferences, mergeContextAttachments, stripContextAttachmentsTaskBlock } from "./session-context-attachments";
import { createContextAttachmentFromReference } from "@machdoch/client-ui/composer/attachment-reference";

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

    const task = appendContextAttachmentsToTask("Review this", [attachment!]);

    expect(task).toBe(
      'Review this\n\nUse this link: "https://example.com/docs/intro"',
    );
    expect(stripContextAttachmentsTaskBlock(task)).toBe("Review this");
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

  it("deduplicates Windows path variants while preserving POSIX case variants", () => {
    const windowsUpper = {
      id: "windows-upper",
      source: "path" as const,
      path: "C:\\Project\\File.txt",
      kind: "file" as const,
      name: "File.txt",
    };
    const windowsLower = {
      ...windowsUpper,
      id: "windows-lower",
      path: "c:/project/file.txt",
    };
    const posixUpper = {
      ...windowsUpper,
      id: "posix-upper",
      path: "/work/File.txt",
    };
    const posixLower = {
      ...windowsUpper,
      id: "posix-lower",
      path: "/work/file.txt",
    };

    expect(
      mergeContextAttachments([windowsUpper], [windowsLower]),
    ).toHaveLength(1);
    expect(mergeContextAttachments([posixUpper], [posixLower])).toHaveLength(2);
  });
});
