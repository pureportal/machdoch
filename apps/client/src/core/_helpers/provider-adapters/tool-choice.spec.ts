import type { AgentModelToolSpec } from "@machdoch/model-runtime/types";
import { createOpenAIResponseToolSelection } from "@machdoch/model-runtime/providers/openai-adapter";
import { createAnthropicToolSelection } from "@machdoch/model-runtime/providers/anthropic-adapter";
import { createLangdockToolSelection } from "@machdoch/model-runtime/providers/langdock-adapter";
import { createGeminiFunctionCallingMode } from "@machdoch/model-runtime/providers/langdock-gemini-adapter";

const tools: AgentModelToolSpec[] = [
  {
    name: "read_file",
    description: "Read a file",
    inputSchema: { type: "object" },
  },
];

describe("Explicit automatic tool selection", () => {
  it("honors explicitly required tool calls on the Langdock Google route", () => {
    expect(createGeminiFunctionCallingMode("gemini-3-pro-preview", "required")).toBe("ANY");
  });
  it("lets OpenAI finish with text while keeping parallel tools disabled", () => {
    expect(createOpenAIResponseToolSelection(tools, "auto")).toEqual({
      tool_choice: "auto",
      parallel_tool_calls: false,
    });
  });
  it("lets Anthropic finish without another tool call", () => {
    expect(createAnthropicToolSelection(tools, "auto")).toEqual({
      tool_choice: { type: "auto", disable_parallel_tool_use: true },
    });
  });
  it("uses automatic selection on Langdock's OpenAI route", () => {
    expect(createLangdockToolSelection(tools, "auto")).toEqual({
      tool_choice: "auto",
    });
  });
  it.each(["gemini-2.5-flash", "gemini-3-pro-preview"])(
    "allows a final report on the Langdock Google route for %s",
    (model) => {
      expect(createGeminiFunctionCallingMode(model, "auto")).toBe("AUTO");
    },
  );
});
