import { describe, expect, it } from "vitest";
import {
  createInstructionAiTask,
  extractInstructionAiBody,
} from "./instruction-ai";

describe("instruction AI assistance", () => {
  it("keeps the editing request separate from the instruction body", () => {
    const task = createInstructionAiTask({
      mode: "improve",
      name: "TypeScript",
      body: "Use strict types.",
      request: "Add testing guidance.",
    });
    expect(task).toContain("<current_instruction>\nUse strict types.");
    expect(task).toContain("<editing_request>\nAdd testing guidance.");
    expect(task).toContain("<machdoch_instruction_file>");
  });

  it("extracts only a complete delimited body", () => {
    expect(
      extractInstructionAiBody(
        "Result:\n<machdoch_instruction_file>\n# Rules\nBe concise.\n</machdoch_instruction_file>",
      ),
    ).toBe("# Rules\nBe concise.");
    expect(extractInstructionAiBody("No delimiter")).toBeNull();
  });
});
