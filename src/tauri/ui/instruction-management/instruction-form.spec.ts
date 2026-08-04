import { describe, expect, it } from "vitest";
import { MAX_INSTRUCTION_PROFILE_NAME_LENGTH } from "../../../core/instruction-system/limits.js";
import {
  isInstructionFormDirty,
  validateInstructionForm,
  type InstructionFormDraft,
} from "./instruction-form";

const createDraft = (
  patch: Partial<InstructionFormDraft> = {},
): InstructionFormDraft => ({
  name: "Review",
  description: "",
  body: "Review the change.",
  enabled: true,
  global: false,
  tags: [],
  match: null,
  ...patch,
});

describe("instruction form", () => {
  it("validates required, byte-bounded, and mutually exclusive fields", () => {
    expect(validateInstructionForm(createDraft({ name: " " }))).toBe(
      "Enter a name.",
    );
    expect(
      validateInstructionForm(createDraft({ name: "Review\nname" })),
    ).toContain("control characters");
    expect(
      validateInstructionForm(createDraft({ description: "Unsafe\ntext" })),
    ).toContain("control characters");
    expect(validateInstructionForm(createDraft({ body: "\0" }))).toContain(
      "NUL",
    );
    expect(
      validateInstructionForm(createDraft({ body: "invalid\ud800text" })),
    ).toContain("valid Unicode");
    expect(
      validateInstructionForm(createDraft({ body: "é".repeat(70_000) })),
    ).toContain("131072 bytes");
    expect(
      validateInstructionForm(
        createDraft({
          name: "\ud83e\udd8a".repeat(MAX_INSTRUCTION_PROFILE_NAME_LENGTH),
        }),
      ),
    ).toBeNull();
    expect(
      validateInstructionForm(
        createDraft({
          global: true,
          match: { op: "tag", tag: "typescript" },
        }),
      ),
    ).toContain("cannot also");
    expect(
      validateInstructionForm(createDraft({ match: { op: "tag", tag: " " } })),
    ).toContain("empty");
  });

  it("detects meaningful edits without treating trimmed metadata as changes", () => {
    const baseline = {
      id: "profile",
      ...createDraft({ description: "Optional" }),
    };
    expect(
      isInstructionFormDirty(
        baseline,
        createDraft({ name: " Review ", description: " Optional " }),
      ),
    ).toBe(false);
    expect(
      isInstructionFormDirty(
        baseline,
        createDraft({ body: "Review the change.\n" }),
      ),
    ).toBe(true);
    expect(isInstructionFormDirty(null, createDraft())).toBe(true);
    expect(
      isInstructionFormDirty(
        null,
        createDraft({ name: "", body: "", enabled: true }),
      ),
    ).toBe(false);
  });
});
