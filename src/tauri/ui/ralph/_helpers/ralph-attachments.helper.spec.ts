import type { RalphAttachmentReference } from "../../../../core/ralph.js";
import type { DroppedPathEntry } from "../../runtime";
import {
  createRalphPathAttachment,
  mergeRalphAttachments,
  normalizeRalphAttachmentKind,
} from "./ralph-attachments.helper";

const createDroppedPath = (
  overrides: Partial<DroppedPathEntry> = {},
): DroppedPathEntry => ({
  path: "docs/review.md",
  kind: "file",
  name: "review.md",
  ...overrides,
});

describe("Ralph attachment helpers", () => {
  it("normalizes explicit, image-derived, other, unknown, and empty attachment kinds", () => {
    expect(normalizeRalphAttachmentKind("directory", "docs")).toBe("directory");
    expect(normalizeRalphAttachmentKind("image", "docs/not-image.txt")).toBe(
      "image",
    );
    expect(normalizeRalphAttachmentKind(undefined, "screenshots/flow.png")).toBe(
      "image",
    );
    expect(normalizeRalphAttachmentKind("other", "archive.bin")).toBe("other");
    expect(normalizeRalphAttachmentKind("symlink", "docs/review.md")).toBe("file");
    expect(normalizeRalphAttachmentKind(undefined, "")).toBe("file");
  });

  it("creates path attachments with generated ids and image media types when supported", () => {
    const randomUuid = vi
      .spyOn(crypto, "randomUUID")
      .mockReturnValue("00000000-0000-4000-8000-000000000000");

    expect(
      createRalphPathAttachment(
        createDroppedPath({
          path: "screenshots/flow.png",
          kind: "other",
          name: "flow.png",
        }),
      ),
    ).toEqual({
      id: "00000000-0000-4000-8000-000000000000",
      source: "path",
      value: "screenshots/flow.png",
      kind: "image",
      mediaType: "image/png",
    });

    expect(createRalphPathAttachment(createDroppedPath())).toEqual({
      id: "00000000-0000-4000-8000-000000000000",
      source: "path",
      value: "docs/review.md",
      kind: "file",
    });
    expect(randomUuid).toHaveBeenCalledTimes(2);
  });

  it("merges attachments by source and normalized value without mutating existing items", () => {
    const existing: RalphAttachmentReference[] = [
      { id: "existing", source: "path", value: "Docs/Review.md", kind: "file" },
      { id: "variable", source: "variable", value: "Docs/Review.md", kind: "file" },
    ];
    const incoming: RalphAttachmentReference[] = [
      { id: "duplicate", source: "path", value: " docs/review.md ", kind: "file" },
      { id: "new-path", source: "path", value: "docs/summary.md", kind: "file" },
      { id: "new-variable", source: "variable", value: "docs/summary.md", kind: "file" },
    ];

    const merged = mergeRalphAttachments(existing, incoming);

    expect(merged).toEqual([
      existing[0],
      existing[1],
      incoming[1],
      incoming[2],
    ]);
    expect(merged).not.toBe(existing);
    expect(existing).toHaveLength(2);
  });
});
