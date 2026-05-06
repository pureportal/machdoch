/// <reference types="vitest/globals" />
import {
  createAnthropicUserContent,
  createGeminiUserMessage,
  createOpenAIUserInput,
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

describe("provider image input serialization", () => {
  const imageInput = {
    path: "C:/workspace/screenshot.png",
    mediaType: "image/png" as const,
    data: "ZmFrZS1pbWFnZQ==",
  };

  it("creates OpenAI Responses image content parts", () => {
    expect(
      createOpenAIUserInput({
        userPrompt: "Describe this screen",
        imageInputs: [imageInput],
      }),
    ).toEqual([
      {
        role: "user",
        content: [
          { type: "input_text", text: "Describe this screen" },
          {
            type: "input_image",
            detail: "auto",
            image_url: "data:image/png;base64,ZmFrZS1pbWFnZQ==",
          },
        ],
      },
    ]);
  });

  it("places Anthropic image blocks before text", () => {
    expect(
      createAnthropicUserContent({
        userPrompt: "Describe this screen",
        imageInputs: [imageInput],
      }),
    ).toEqual([
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: "ZmFrZS1pbWFnZQ==",
        },
      },
      { type: "text", text: "Describe this screen" },
    ]);
  });

  it("creates Gemini inline image parts", () => {
    expect(
      createGeminiUserMessage({
        userPrompt: "Describe this screen",
        imageInputs: [imageInput],
      }),
    ).toEqual([
      {
        inlineData: {
          data: "ZmFrZS1pbWFnZQ==",
          mimeType: "image/png",
        },
      },
      { text: "Describe this screen" },
    ]);
  });
});
