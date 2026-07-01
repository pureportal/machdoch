import { normalizeOpenAIStrictInputSchema } from "./schema-normalization.js";

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

  it("closes map-like object schemas for OpenAI strict tools", () => {
    const normalized = normalizeOpenAIStrictInputSchema({
      type: "object",
      additionalProperties: true,
      properties: {
        payload: {
          type: "object",
          additionalProperties: true,
        },
        variables: {
          type: "object",
          additionalProperties: { type: "string" },
        },
      },
    });

    expect(normalized.additionalProperties).toBe(false);
    expect(normalized.required).toEqual(["payload", "variables"]);
    expect(normalized.properties).toMatchObject({
      payload: {
        type: ["object", "null"],
        additionalProperties: false,
        required: [],
      },
      variables: {
        type: ["object", "null"],
        additionalProperties: false,
        required: [],
      },
    });
  });

  it("removes property name validators rejected by strict tool schemas", () => {
    const normalized = normalizeOpenAIStrictInputSchema({
      type: "object",
      properties: {
        data: {
          type: "object",
          propertyNames: {
            type: "string",
          },
          additionalProperties: {
            type: "string",
          },
        },
      },
      required: ["data"],
    });
    const properties = normalized.properties as Record<string, unknown>;
    const dataSchema = properties.data as Record<string, unknown>;

    expect(dataSchema).not.toHaveProperty("propertyNames");
    expect(dataSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: [],
    });
  });
});
