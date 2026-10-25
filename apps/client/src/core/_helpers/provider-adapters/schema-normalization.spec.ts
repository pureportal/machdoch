import { describe, expect, it } from "vitest";
import { normalizeOpenAIStrictInputSchema } from "@machdoch/model-runtime/providers/schema-normalization";

describe("normalizeOpenAIStrictInputSchema", () => {
  it("normalizes referenced definitions and tuple objects recursively", () => {
    const normalized = normalizeOpenAIStrictInputSchema({
      type: "object",
      $defs: {
        row: { type: "object", properties: { count: { type: "integer" } } },
      },
      properties: {
        rows: {
          type: "array",
          prefixItems: [
            { type: "object", properties: { label: { type: "string" } } },
          ],
        },
      },
    });
    expect(normalized.$defs).toMatchObject({
      row: {
        required: ["count"],
        additionalProperties: false,
        properties: { count: { type: ["integer", "null"] } },
      },
    });
    expect(normalized.properties).toMatchObject({
      rows: {
        prefixItems: [
          {
            required: ["label"],
            additionalProperties: false,
            properties: { label: { type: ["string", "null"] } },
          },
        ],
      },
    });
  });
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
