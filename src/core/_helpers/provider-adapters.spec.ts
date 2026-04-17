/// <reference types="vitest/globals" />
import { normalizeOpenAIStrictInputSchema } from "./provider-adapters.js";

describe("normalizeOpenAIStrictInputSchema", () => {
  it("makes optional properties nullable while requiring every declared key", () => {
    const normalized = normalizeOpenAIStrictInputSchema({
      type: "object",
      additionalProperties: false,
      properties: {
        monitorId: {
          type: "integer",
          description: "Optional monitor id.",
        },
        button: {
          type: "string",
          enum: ["left", "right", "middle"],
        },
      },
      required: ["button"],
    });

    expect(normalized.required).toEqual(["monitorId", "button"]);
    expect(normalized.properties).toMatchObject({
      monitorId: {
        type: ["integer", "null"],
      },
      button: {
        type: "string",
        enum: ["left", "right", "middle"],
      },
    });
  });

  it("adds an explicit empty required list for empty object schemas", () => {
    const normalized = normalizeOpenAIStrictInputSchema({
      type: "object",
      additionalProperties: false,
      properties: {},
    });

    expect(normalized.required).toEqual([]);
    expect(normalized.properties).toEqual({});
  });
});
