import {
  hasUnsupportedStrictJsonSchemaKeyword,
  validateJsonAgainstSchema,
} from "../ralph.js";

describe("Ralph JSON Schema validation", () => {
  it("supports boolean schemas and deep const equality", () => {
    expect(validateJsonAgainstSchema({ nested: [1] }, true).valid).toBe(true);
    expect(validateJsonAgainstSchema({ nested: [1] }, false).valid).toBe(false);
    expect(validateJsonAgainstSchema(
      { nested: [1, { ok: true }] },
      { const: { nested: [1, { ok: true }] } },
    ).valid).toBe(true);
  });

  it("supports local refs, definitions, formats, constraints, and combinators", () => {
    const schema = {
      $defs: {
        item: {
          type: "object",
          required: ["id", "score"],
          additionalProperties: false,
          properties: {
            id: { type: "string", format: "uuid" },
            score: { type: "number", exclusiveMinimum: 0, multipleOf: 0.5 },
          },
        },
      },
      type: "array",
      minItems: 1,
      uniqueItems: true,
      items: {
        allOf: [
          { $ref: "#/$defs/item" },
          { not: { properties: { score: { maximum: 0 } }, required: ["score"] } },
        ],
      },
    };

    expect(validateJsonAgainstSchema([
      { id: "9aa0be52-f28a-4ce5-9962-36802f0444bc", score: 1.5 },
    ], schema).valid).toBe(true);
    expect(validateJsonAgainstSchema([
      { id: "not-a-uuid", score: 0.3, extra: true },
    ], schema).valid).toBe(false);
  });

  it("does not mistake property names for schema combinators", () => {
    expect(hasUnsupportedStrictJsonSchemaKeyword({
      type: "object",
      properties: {
        oneOf: { type: "string" },
        allOf: { type: "number" },
        not: { type: "boolean" },
      },
    })).toBe(false);
    expect(hasUnsupportedStrictJsonSchemaKeyword({
      oneOf: [{ type: "string" }, { type: "number" }],
    })).toBe(true);
  });
});
