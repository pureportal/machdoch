import type { RalphInputField } from "../../../../core/ralph.js";
import {
  createDefaultRalphInputValues,
  formatRalphInputValueForPrompt,
  getDefaultRalphInputValue,
  isEmptyRalphInputValue,
  validateRalphInputFieldValue,
  validateRalphInputFieldValues,
} from "./validate-ralph-input-field-values.helper";

const createField = (
  overrides: Partial<RalphInputField> = {},
): RalphInputField => ({
  id: "field",
  type: "text",
  label: "Field",
  ...overrides,
});

describe("createDefaultRalphInputValues", () => {
  it("uses configured defaults and boolean false fallback", () => {
    const text = createField({ id: "text", defaultValue: "draft" });
    const boolean = createField({ id: "enabled", type: "boolean" });
    const number = createField({ id: "count", type: "number" });

    expect(getDefaultRalphInputValue(text)).toBe("draft");
    expect(getDefaultRalphInputValue(boolean)).toBe(false);
    expect(getDefaultRalphInputValue(number)).toBeNull();
    expect(createDefaultRalphInputValues([text, boolean, number])).toEqual({
      text: "draft",
      enabled: false,
      count: null,
    });
  });
});

describe("isEmptyRalphInputValue", () => {
  it.each([
    [undefined, true],
    [null, true],
    ["", true],
    ["   ", false],
    [[], true],
    [[""], false],
    [0, false],
    [false, false],
  ])("returns %j for %j", (value, expected) => {
    expect(isEmptyRalphInputValue(value)).toBe(expected);
  });
});

describe("formatRalphInputValueForPrompt", () => {
  it("formats skipped and present values for prompt text", () => {
    expect(formatRalphInputValueForPrompt(undefined)).toBe("Skipped");
    expect(formatRalphInputValueForPrompt(null)).toBe("Skipped");
    expect(formatRalphInputValueForPrompt([])).toBe("Skipped");
    expect(formatRalphInputValueForPrompt(["a", "b"])).toBe("a, b");
    expect(formatRalphInputValueForPrompt(false)).toBe("false");
    expect(formatRalphInputValueForPrompt(3)).toBe("3");
  });
});

describe("validateRalphInputFieldValue", () => {
  it("requires non-skippable required values", () => {
    expect(
      validateRalphInputFieldValue(
        createField({ required: true, skippable: false }),
        null,
      ),
    ).toBe("This answer is required.");
    expect(
      validateRalphInputFieldValue(
        createField({ required: true, skippable: true }),
        null,
      ),
    ).toBeNull();
  });

  it("validates number parsing and min/max boundaries", () => {
    const field = createField({
      type: "number",
      validation: { min: 2, max: 4 },
    });

    expect(validateRalphInputFieldValue(field, "abc")).toBe("Enter a valid number.");
    expect(validateRalphInputFieldValue(field, 1)).toBe(
      "Enter a value of at least 2.",
    );
    expect(validateRalphInputFieldValue(field, 5)).toBe(
      "Enter a value of at most 4.",
    );
    expect(validateRalphInputFieldValue(field, 3)).toBeNull();
  });

  it("validates string length and pattern while ignoring invalid patterns", () => {
    expect(
      validateRalphInputFieldValue(
        createField({ validation: { minLength: 3 } }),
        "ab",
      ),
    ).toBe("Enter at least 3 characters.");
    expect(
      validateRalphInputFieldValue(
        createField({ validation: { maxLength: 2 } }),
        "abc",
      ),
    ).toBe("Enter at most 2 characters.");
    expect(
      validateRalphInputFieldValue(
        createField({ validation: { pattern: "^ok$" } }),
        "no",
      ),
    ).toBe("Enter a value matching the requested format.");
    expect(
      validateRalphInputFieldValue(
        createField({ validation: { pattern: "[" } }),
        "anything",
      ),
    ).toBeNull();
  });
});

describe("validateRalphInputFieldValues", () => {
  it("returns errors keyed by field id", () => {
    expect(
      validateRalphInputFieldValues(
        [
          createField({ id: "required", required: true }),
          createField({ id: "count", type: "number" }),
          createField({ id: "valid" }),
        ],
        { required: "", count: "x", valid: "ok" },
      ),
    ).toEqual({
      required: "This answer is required.",
      count: "Enter a valid number.",
    });
  });
});
