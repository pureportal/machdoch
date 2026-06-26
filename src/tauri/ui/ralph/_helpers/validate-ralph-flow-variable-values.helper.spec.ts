import type { RalphFlowVariable } from "../../../../core/ralph.js";
import {
  createDefaultRalphVariableValues,
  getRalphVariableValue,
  normalizeRalphBooleanVariableValue,
  validateRalphFlowVariableValue,
  validateRalphFlowVariableValues,
} from "./validate-ralph-flow-variable-values.helper";

const createVariable = (
  overrides: Partial<RalphFlowVariable> = {},
): RalphFlowVariable => ({
  name: "field",
  type: "string",
  required: false,
  ...overrides,
});

describe("createDefaultRalphVariableValues", () => {
  it("uses declared defaults and preserves empty fallback values", () => {
    const text = createVariable({ name: "text", default: "draft" });
    const number = createVariable({ name: "count", type: "number" });
    const enabled = createVariable({
      name: "enabled",
      type: "boolean",
      default: "false",
    });

    expect(createDefaultRalphVariableValues([text, number, enabled])).toEqual({
      text: "draft",
      count: "",
      enabled: "false",
    });
    expect(getRalphVariableValue(text, {})).toBe("draft");
    expect(getRalphVariableValue(number, {})).toBe("");
  });
});

describe("normalizeRalphBooleanVariableValue", () => {
  it.each([
    ["true", "true"],
    [" TRUE ", "true"],
    ["false", "false"],
    ["", ""],
    ["yes", null],
  ] as const)("normalizes %j to %j", (value, expected) => {
    expect(normalizeRalphBooleanVariableValue(value)).toBe(expected);
  });
});

describe("validateRalphFlowVariableValue", () => {
  it("validates required, number, boolean, and url variable values", () => {
    expect(
      validateRalphFlowVariableValue(createVariable({ required: true }), ""),
    ).toBe("This variable is required.");
    expect(
      validateRalphFlowVariableValue(createVariable({ type: "number" }), "abc"),
    ).toBe("Enter a valid number.");
    expect(
      validateRalphFlowVariableValue(createVariable({ type: "number" }), "3.5"),
    ).toBeNull();
    expect(
      validateRalphFlowVariableValue(createVariable({ type: "boolean" }), "yes"),
    ).toBe("Choose true or false.");
    expect(
      validateRalphFlowVariableValue(createVariable({ type: "boolean" }), "false"),
    ).toBeNull();
    expect(
      validateRalphFlowVariableValue(createVariable({ type: "url" }), "localhost"),
    ).toBe("Enter a valid URL.");
    expect(
      validateRalphFlowVariableValue(
        createVariable({ type: "url" }),
        "https://example.com",
      ),
    ).toBeNull();
  });
});

describe("validateRalphFlowVariableValues", () => {
  it("returns errors keyed by variable name", () => {
    expect(
      validateRalphFlowVariableValues(
        [
          createVariable({ name: "required", required: true }),
          createVariable({ name: "count", type: "number" }),
          createVariable({ name: "enabled", type: "boolean" }),
        ],
        { required: "", count: "x", enabled: "maybe" },
      ),
    ).toEqual({
      required: "This variable is required.",
      count: "Enter a valid number.",
      enabled: "Choose true or false.",
    });
  });
});
