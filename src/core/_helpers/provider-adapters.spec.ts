/// <reference types="vitest/globals" />
import { getEventListeners } from "node:events";
import {
  createAnthropicToolSelection,
  createAnthropicUserContent,
  createGeminiUserMessage,
  createOpenAIResponseToolSelection,
  createOpenAIUserInput,
  createProviderRequestSignal,
  normalizeGeminiResponse,
  normalizeOpenAIStrictInputSchema,
} from "./provider-adapters.js";

describe("createProviderRequestSignal", () => {
  it("cleans up the parent abort listener after each request", () => {
    const controller = new AbortController();

    for (let index = 0; index < 12; index += 1) {
      const requestSignal = createProviderRequestSignal(controller.signal);

      expect(requestSignal.signal).toBeDefined();
      expect(requestSignal.signal).not.toBe(controller.signal);
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);

      requestSignal.cleanup();

      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    }
  });

  it("forwards parent aborts to the request signal", () => {
    const controller = new AbortController();
    const requestSignal = createProviderRequestSignal(controller.signal);
    const reason = new Error("Stop request.");

    controller.abort(reason);

    expect(requestSignal.signal?.aborted).toBe(true);
    expect(requestSignal.signal?.reason).toBe(reason);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });
});

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

describe("provider tool selection", () => {
  it("requires OpenAI Responses to use one tool per turn", () => {
    expect(createOpenAIResponseToolSelection()).toEqual({
      parallel_tool_calls: false,
      tool_choice: "required",
    });
  });

  it("requires Anthropic Messages to use one tool per turn", () => {
    expect(createAnthropicToolSelection()).toEqual({
      tool_choice: {
        type: "any",
        disable_parallel_tool_use: true,
      },
    });
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
