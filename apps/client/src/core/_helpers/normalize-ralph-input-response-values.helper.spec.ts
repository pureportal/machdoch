import type { RalphInputField, RalphInputValue } from "../ralph.js";
import {
  getRalphInputFieldVariableNames,
  hasRalphInputValue,
  isRalphVariableName,
  normalizeRalphInputResponseValues,
  stringifyRalphInputValue,
} from "./normalize-ralph-input-response-values.helper.ts";

const createField = (
  overrides: Partial<RalphInputField> = {},
): RalphInputField => ({
  id: "field",
  type: "text",
  label: "Field",
  ...overrides,
});

describe("normalizeRalphInputResponseValues", () => {
  it("normalizes text, number, boolean, select, and multiselect values", () => {
    const result = normalizeRalphInputResponseValues(
      [
        createField({ id: "text", label: "Text", type: "text" }),
        createField({ id: "number", label: "Number", type: "number" }),
        createField({ id: "boolean", label: "Boolean", type: "boolean" }),
        createField({
          id: "select",
          label: "Select",
          type: "select",
          options: [{ label: "One", value: "one" }],
        }),
        createField({
          id: "multi",
          label: "Multi",
          type: "multiselect",
          options: [
            { label: "One", value: "one" },
            { label: "Two", value: "two" },
          ],
        }),
      ],
      {
        text: 12,
        number: " 42 ",
        boolean: "YES",
        select: "one",
        multi: ["one", " ", "two"],
      },
    );

    expect(result).toEqual({
      values: {
        text: "12",
        number: 42,
        boolean: true,
        select: "one",
        multi: ["one", "two"],
      },
      skipped: [],
      errors: [],
    });
  });

  it("uses defaults and marks empty optional values as skipped", () => {
    const result = normalizeRalphInputResponseValues(
      [
        createField({ id: "defaulted", label: "Defaulted", defaultValue: "fallback" }),
        createField({ id: "blank", label: "Blank" }),
        createField({ id: "emptyFiles", label: "Files", type: "files" }),
      ],
      { blank: "   ", emptyFiles: [] },
    );

    expect(result.values).toEqual({
      defaulted: "fallback",
      blank: null,
      emptyFiles: null,
    });
    expect(result.skipped).toEqual(["blank", "emptyFiles"]);
    expect(result.errors).toEqual([]);
  });

  it("reports required values unless the field is skippable", () => {
    const result = normalizeRalphInputResponseValues(
      [
        createField({ id: "required", label: "Required", required: true }),
        createField({
          id: "skippable",
          label: "Skippable",
          required: true,
          skippable: true,
        }),
      ],
      undefined,
    );

    expect(result.values).toEqual({ required: null, skippable: null });
    expect(result.skipped).toEqual(["required", "skippable"]);
    expect(result.errors).toEqual(["Required is required."]);
  });

  it("reports invalid number, boolean, URL, select, and string validation failures", () => {
    const result = normalizeRalphInputResponseValues(
      [
        createField({
          id: "number",
          label: "Number",
          type: "number",
          validation: { min: 10, max: 20 },
        }),
        createField({ id: "badNumber", label: "Bad number", type: "number" }),
        createField({ id: "boolean", label: "Boolean", type: "boolean" }),
        createField({ id: "url", label: "URL", type: "url" }),
        createField({
          id: "select",
          label: "Select",
          type: "select",
          options: [{ label: "Known", value: "known" }],
        }),
        createField({
          id: "pattern",
          label: "Pattern",
          validation: { minLength: 3, maxLength: 4, pattern: "[" },
        }),
      ],
      {
        number: 25,
        badNumber: "abc",
        boolean: "maybe",
        url: "not a url",
        select: "unknown",
        pattern: "xx",
      },
    );

    expect(result.values).toEqual({
      number: 25,
      badNumber: null,
      boolean: null,
      url: "not a url",
      select: "unknown",
      pattern: "xx",
    });
    expect(result.skipped).toEqual(["badNumber", "boolean"]);
    expect(result.errors).toEqual([
      "Number must be at most 20.",
      "Bad number must be a number.",
      "Boolean must be true or false.",
      "URL must be a valid URL.",
      "Select has an unknown option: unknown.",
      "Pattern must be at least 3 characters.",
      "Pattern has an invalid validation pattern.",
    ]);
  });

  it("reports unknown multiselect options while preserving valid entries", () => {
    const result = normalizeRalphInputResponseValues(
      [
        createField({
          id: "choices",
          label: "Choices",
          type: "multiselect",
          options: [{ label: "Known", value: "known" }],
        }),
      ],
      { choices: ["known", "missing"] },
    );

    expect(result.values).toEqual({ choices: ["known", "missing"] });
    expect(result.errors).toEqual(["Choices has an unknown option: missing."]);
  });
});

describe("hasRalphInputValue", () => {
  it.each<[RalphInputValue | undefined, boolean]>([
    [undefined, false],
    [null, false],
    ["", false],
    ["   ", false],
    [[], false],
    [[""], true],
    [0, true],
    [false, true],
  ])("returns %s for %j", (value, expected) => {
    expect(hasRalphInputValue(value)).toBe(expected);
  });
});

describe("stringifyRalphInputValue", () => {
  it("stringifies values for prompt variables", () => {
    expect(stringifyRalphInputValue(null)).toBe("");
    expect(stringifyRalphInputValue(["a", "b"])).toBe("[\"a\",\"b\"]");
    expect(stringifyRalphInputValue(false)).toBe("false");
    expect(stringifyRalphInputValue(3)).toBe("3");
  });
});

describe("getRalphInputFieldVariableNames", () => {
  it("returns valid explicit and id-based variable names without duplicates", () => {
    expect(
      getRalphInputFieldVariableNames(
        createField({ id: "field_id", variableName: " explicitName " }),
      ),
    ).toEqual(["explicitName", "field_id"]);
    expect(
      getRalphInputFieldVariableNames(
        createField({ id: "field_id", variableName: "field_id" }),
      ),
    ).toEqual(["field_id"]);
  });

  it("ignores invalid variable names", () => {
    expect(
      getRalphInputFieldVariableNames(
        createField({ id: "1-invalid", variableName: "invalid-name" }),
      ),
    ).toEqual([]);
  });
});

describe("isRalphVariableName", () => {
  it.each([
    ["variable", true],
    ["_variable1", true],
    ["1variable", false],
    ["variable-name", false],
    ["", false],
  ] as const)("returns %s for %j", (value, expected) => {
    expect(isRalphVariableName(value)).toBe(expected);
  });
});
