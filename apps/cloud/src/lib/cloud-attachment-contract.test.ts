import { describe, expect, it } from "vitest";
import {
  attachmentKind,
  attachmentMarkdown,
  attachmentMime,
  formatBytes,
  referencedAttachmentIds,
} from "./cloud-attachment-contract";
import { availableIssueAgentActions } from "./agent-quick-actions";
import { builtinRoles } from "./cloud-permissions";

const id = "0b5f4a55-2d1f-4c55-9a43-1f0c1d7b2e10";

describe("attachment contract", () => {
  it("derives file types from the browser type or the file name", () => {
    expect(attachmentMime("shot.png", "image/png")).toBe("image/png");
    expect(attachmentMime("notes.md", "")).toBe("text/markdown");
    expect(attachmentMime("clip.MOV", "application/octet-stream")).toBe(
      "video/quicktime",
    );
    expect(attachmentMime("data.json", "application/json; charset=utf-8")).toBe(
      "application/json",
    );
    expect(attachmentKind("image/gif")).toBe("image");
    expect(attachmentKind("text/csv")).toBe("document");
    expect(attachmentKind("application/pdf")).toBe("file");
    expect(attachmentKind("application/x-msdownload")).toBeNull();
  });

  it("writes Markdown that shows images in place and links other files", () => {
    expect(
      attachmentMarkdown({ id, name: "Hero [v2].png", kind: "image" }),
    ).toBe(`![Hero v2.png](/api/v1/attachments/${id})`);
    expect(attachmentMarkdown({ id, name: "spec.pdf", kind: "file" })).toBe(
      `[spec.pdf](/api/v1/attachments/${id})`,
    );
  });

  it("finds each referenced attachment once", () => {
    expect(
      referencedAttachmentIds(
        `![a](/api/v1/attachments/${id}) and [b](/api/v1/attachments/${id.toUpperCase()}) /api/v1/attachments/nope`,
      ),
    ).toEqual([id]);
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });

  it("offers client work only to people who manage clients", () => {
    expect(
      availableIssueAgentActions({
        owner: false,
        permissions: builtinRoles.member.permissions,
      }).map((action) => action.id),
    ).not.toContain("client");
    expect(
      availableIssueAgentActions({
        owner: false,
        permissions: builtinRoles.admin.permissions,
      }).map((action) => action.id),
    ).toContain("client");
  });
});
