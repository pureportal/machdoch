import {
  CONTINUE_TASK_DISPLAY_CONTENT,
  getConciseTaskObjective,
  getTaskActionDisplayContent,
  shouldOmitTaskActionPromptFromAiContext,
} from "./task-action-prompts";

describe("task action prompt helpers", () => {
  it("compacts nested legacy continuation prompts to the original objective", () => {
    const nestedPrompt = [
      "Continue from this previous task.",
      "",
      "Previous task:",
      "Continue from this previous task.",
      "",
      "Previous task:",
      "Wie viel Uhr haben wir es?",
      "",
      "Previous status:",
      "executed",
      "",
      "Previous summary:",
      "Aktuelle Uhrzeit fuer Europa/Berlin abgefragt.",
      "",
      "Use the conversation and execution details above as context, then take the next useful step.",
    ].join("\n");

    expect(getConciseTaskObjective(nestedPrompt)).toBe(
      "Wie viel Uhr haben wir es?",
    );
    expect(getTaskActionDisplayContent(nestedPrompt)).toBe(
      CONTINUE_TASK_DISPLAY_CONTENT,
    );
    expect(shouldOmitTaskActionPromptFromAiContext(nestedPrompt)).toBe(true);
  });

  it("does not collapse normal user messages that only start with an action phrase", () => {
    const userPrompt =
      "Continue the previous task by checking a different timezone.";

    expect(getTaskActionDisplayContent(userPrompt)).toBeNull();
    expect(shouldOmitTaskActionPromptFromAiContext(userPrompt)).toBe(false);
  });
});
