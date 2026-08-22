import { coerceRalphAttachmentReferences } from "./coerce-ralph-attachment-references.helper.ts";

describe("coerceRalphAttachmentReferences", () => {
  it("coerces valid path and variable attachment references", () => {
    expect(
      coerceRalphAttachmentReferences([
        {
          id: "attachment-1",
          source: "path",
          value: "docs/spec.md",
          kind: "file",
          mediaType: "text/markdown",
        },
        {
          source: "variable",
          value: "SCREENSHOT_PATH",
          kind: "image",
        },
      ]),
    ).toEqual([
      {
        id: "attachment-1",
        source: "path",
        value: "docs/spec.md",
        kind: "file",
        mediaType: "text/markdown",
      },
      {
        source: "variable",
        value: "SCREENSHOT_PATH",
        kind: "image",
      },
    ]);
  });

  it("defaults unknown sources to path and omits invalid optional fields", () => {
    expect(
      coerceRalphAttachmentReferences([
        {
          id: 123,
          source: "unknown",
          value: "  docs/spec.md  ",
          kind: "unsupported",
          mediaType: false,
        },
      ]),
    ).toEqual([
      {
        source: "path",
        value: "  docs/spec.md  ",
      },
    ]);
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["object", { value: "docs/spec.md" }],
    ["string", "docs/spec.md"],
    ["number", 42],
  ])("returns an empty list for non-array input: %s", (_label, value) => {
    expect(coerceRalphAttachmentReferences(value)).toEqual([]);
  });

  it("skips non-object entries, array entries, missing values, and blank values", () => {
    expect(
      coerceRalphAttachmentReferences([
        null,
        undefined,
        "docs/spec.md",
        ["docs/spec.md"],
        { value: "" },
        { value: "   " },
        { value: 42 },
        { value: "docs/spec.md" },
      ]),
    ).toEqual([
      {
        source: "path",
        value: "docs/spec.md",
      },
    ]);
  });

  it.each(["file", "directory", "image", "other"] as const)(
    "keeps supported attachment kind %s",
    (kind) => {
      expect(coerceRalphAttachmentReferences([{ value: "asset", kind }])).toEqual([
        {
          source: "path",
          value: "asset",
          kind,
        },
      ]);
    },
  );
});
