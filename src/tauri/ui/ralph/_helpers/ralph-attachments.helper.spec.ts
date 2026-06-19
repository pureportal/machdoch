import type { RalphAttachmentReference } from "../../../../core/ralph.js";
import type { DroppedPathEntry } from "../../runtime";
import {
  createRalphPathAttachment,
  createRalphPathAttachmentPreview,
  getRalphPathAttachmentPreviews,
  getRalphPathName,
  getRalphPathParent,
  getRalphVariableAttachmentItems,
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
  it("derives path names and parents from Unix and Windows paths", () => {
    expect(getRalphPathName("docs/review.md")).toBe("review.md");
    expect(getRalphPathName("C:\\repo\\screenshots\\flow.png")).toBe("flow.png");
    expect(getRalphPathName("docs/reports/")).toBe("reports");
    expect(getRalphPathName("")).toBe("");

    expect(getRalphPathParent("docs/review.md")).toBe("docs");
    expect(getRalphPathParent("C:\\repo\\screenshots\\flow.png")).toBe(
      "C:\\repo\\screenshots",
    );
    expect(getRalphPathParent("review.md")).toBeUndefined();
    expect(getRalphPathParent("/review.md")).toBeUndefined();
  });

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

  it("maps path attachments to chat attachment previews and skips variable attachments", () => {
    const attachments: RalphAttachmentReference[] = [
      {
        source: "variable",
        value: "{{screenshot:file}}",
        kind: "file",
      },
      {
        id: "path-one",
        source: "path",
        value: "docs/review.md",
        kind: "file",
      },
      {
        source: "path",
        value: "screenshots/flow.png",
      },
    ];

    expect(getRalphPathAttachmentPreviews(undefined)).toEqual([]);
    expect(getRalphPathAttachmentPreviews(attachments)).toEqual([
      {
        id: "path-one",
        path: "docs/review.md",
        kind: "file",
        name: "review.md",
        parent: "docs",
      },
      {
        id: "ralph-path-1",
        path: "screenshots/flow.png",
        kind: "image",
        name: "flow.png",
        parent: "screenshots",
      },
    ]);
  });

  it("creates individual path previews with fallback ids and no parent at path roots", () => {
    expect(
      createRalphPathAttachmentPreview(
        {
          source: "path",
          value: "image.jpeg",
        },
        3,
      ),
    ).toEqual({
      id: "ralph-path-3",
      path: "image.jpeg",
      kind: "image",
      name: "image.jpeg",
    });
  });

  it("returns variable attachment items with stable fallback keys based on source indexes", () => {
    const pathAttachment: RalphAttachmentReference = {
      source: "path",
      value: "docs/review.md",
      kind: "file",
    };
    const namedVariable: RalphAttachmentReference = {
      id: "variable-one",
      source: "variable",
      value: "{{first:file}}",
      kind: "file",
    };
    const fallbackVariable: RalphAttachmentReference = {
      source: "variable",
      value: "{{second:file}}",
      kind: "file",
    };

    expect(getRalphVariableAttachmentItems(undefined)).toEqual([]);
    expect(
      getRalphVariableAttachmentItems([
        pathAttachment,
        namedVariable,
        fallbackVariable,
      ]),
    ).toEqual([
      { attachment: namedVariable, key: "variable-one" },
      { attachment: fallbackVariable, key: "ralph-variable-2" },
    ]);
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
