import { FunctionCallingConfigMode, type GoogleGenAI } from "@google/genai";
import type {
  AgentModelStartParams,
  AgentModelStreamEvent,
  AgentModelToolSpec,
} from "../../types.js";
import { TASK_EXECUTION_TIMEOUT_MS } from "../agent-runtime-types.js";
import {
  GeminiChatAdapter,
  createGeminiUserMessage,
  normalizeGeminiResponse,
} from "./gemini-adapter.js";

const tool: AgentModelToolSpec = {
  name: "inspect_file",
  description: "Inspect a workspace file.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      path: { type: "string" },
    },
    required: ["path"],
  },
};

const startParams: AgentModelStartParams = {
  model: "gemini-3-pro",
  systemPrompt: "System prompt.",
  userPrompt: "Read README.md",
  tools: [tool],
};

describe("Gemini function-calling conformance", () => {
  it("creates inline image parts", () => {
    expect(
      createGeminiUserMessage({
        userPrompt: "Describe this screen",
        imageInputs: [
          {
            path: "C:/workspace/screenshot.png",
            mediaType: "image/png",
            data: "ZmFrZS1pbWFnZQ==",
          },
        ],
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

  it("sends ANY-mode function calls and function responses through chat", async () => {
    const createCalls: unknown[] = [];
    const sendCalls: unknown[] = [];
    const responses = [
      {
        candidates: [
          {
            content: {
              parts: [
                { text: "Need the file." },
                {
                  functionCall: {
                    id: "call_1",
                    name: "inspect_file",
                    args: { path: "README.md" },
                  },
                },
              ],
            },
          },
        ],
      },
      {
        candidates: [
          {
            content: {
              parts: [{ text: "Done." }],
            },
          },
        ],
      },
    ];
    const chat = {
      sendMessage: async (request: unknown) => {
        sendCalls.push(request);
        return responses.shift() ?? { candidates: [] };
      },
    };
    const client = {
      chats: {
        create: (request: unknown) => {
          createCalls.push(request);
          return chat;
        },
      },
    } as unknown as GoogleGenAI;
    const adapter = new GeminiChatAdapter(client, "gemini-3-pro", [tool]);

    await expect(adapter.startTurn(startParams)).resolves.toEqual({
      text: "Need the file.",
      toolCalls: [
        {
          id: "call_1",
          name: "inspect_file",
          arguments: { path: "README.md" },
        },
      ],
    });
    await expect(
      adapter.continueTurn({
        toolResults: [
          {
            callId: "call_1",
            name: "inspect_file",
            output: "contents",
          },
        ],
      }),
    ).resolves.toEqual({
      text: "Done.",
      toolCalls: [],
    });

    expect(createCalls[0]).toMatchObject({
      model: "gemini-3-pro",
      config: {
        toolConfig: {
          functionCallingConfig: {
            mode: FunctionCallingConfigMode.ANY,
            allowedFunctionNames: ["inspect_file"],
          },
        },
        automaticFunctionCalling: {
          disable: true,
        },
      },
    });
    expect(sendCalls[0]).toMatchObject({
      message: "Read README.md",
      config: {
        systemInstruction: "System prompt.",
        httpOptions: {
          timeout: TASK_EXECUTION_TIMEOUT_MS,
        },
        toolConfig: {
          functionCallingConfig: {
            mode: FunctionCallingConfigMode.ANY,
            allowedFunctionNames: ["inspect_file"],
          },
        },
      },
    });
    expect(sendCalls[1]).toMatchObject({
      message: [
        {
          functionResponse: {
            id: "call_1",
            name: "inspect_file",
            response: {
              output: "contents",
            },
          },
        },
      ],
    });
  });

  it("normalizes streamed Gemini chunks", async () => {
    const events: AgentModelStreamEvent[] = [];
    const chat = {
      sendMessageStream: async () => [
        {
          usageMetadata: {
            promptTokenCount: 11,
            candidatesTokenCount: 3,
            totalTokenCount: 14,
            thoughtsTokenCount: 2,
          },
          candidates: [
            {
              content: {
                parts: [
                  { text: "Thinking privately.", thought: true },
                  { text: "Need " },
                ],
              },
            },
          ],
        },
        {
          candidates: [
            {
              content: {
                parts: [
                  {
                    functionCall: {
                      id: "call_1",
                      name: "inspect_file",
                      args: { path: "README.md" },
                    },
                  },
                ],
              },
            },
          ],
        },
      ],
    };
    const client = {
      chats: {
        create: vi.fn(() => chat),
      },
    } as unknown as GoogleGenAI;
    const adapter = new GeminiChatAdapter(client, "gemini-3-pro", [tool]);

    await expect(
      adapter.startTurn({
        ...startParams,
        onStreamEvent: (event) => events.push(event),
      }),
    ).resolves.toMatchObject({
      text: "Need",
      toolCalls: [{ id: "call_1", name: "inspect_file" }],
    });

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "status", provider: "google" }),
        expect.objectContaining({
          type: "reasoning-delta",
          provider: "google",
          delta: "Thinking privately.",
        }),
        { type: "text-delta", provider: "google", delta: "Need " },
        expect.objectContaining({
          type: "tool-call-start",
          provider: "google",
          name: "inspect_file",
        }),
        expect.objectContaining({
          type: "tool-call-done",
          provider: "google",
          argumentsText: "{\"path\":\"README.md\"}",
        }),
        expect.objectContaining({
          type: "usage",
          provider: "google",
          usage: expect.objectContaining({
            totalTokens: 14,
            reasoningTokens: 2,
          }),
        }),
      ]),
    );
  });
});
