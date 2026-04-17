/// <reference types="vitest/globals" />
import {
  normalizeGeminiResponse,
  normalizeOpenAIStrictInputSchema,
} from "./provider-adapters.js";

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

describe("normalizeGeminiResponse", () => {
  it("reads raw Gemini parts without touching the warning-producing text getter", () => {
    let textGetterAccessed = false;

    const response = {
      candidates: [
        {
          content: {
            parts: [
              { text: "Hidden reasoning", thought: true },
              { text: "I will check that. " },
              {
                functionCall: {
                  id: "call_1",
                  name: "lookup_hotkey",
                  args: { key: "Ctrl+J" },
                },
              },
              { text: "Done." },
            ],
          },
        },
      ],
      get text() {
        textGetterAccessed = true;
        throw new Error("normalizeGeminiResponse should not access response.text");
      },
    };

    const normalized = normalizeGeminiResponse(response);

    expect(textGetterAccessed).toBe(false);
    expect(normalized).toEqual({
      text: "I will check that. Done.",
      toolCalls: [
        {
          id: "call_1",
          name: "lookup_hotkey",
          arguments: { key: "Ctrl+J" },
        },
      ],
    });
  });
});
