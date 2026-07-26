import {
  getConciseTaskObjective,
  shouldOmitTaskActionPromptFromAiContext,
} from "./task-action-prompts";

describe("task action prompt helpers", () => {
  it("extracts the original objective from nested legacy continuation prompts", () => {
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
    expect(shouldOmitTaskActionPromptFromAiContext(nestedPrompt)).toBe(true);
  });

  it("keeps normal user messages that only start with an action phrase in AI context", () => {
    const userPrompt =
      "Continue the previous task by checking a different timezone.";

    expect(shouldOmitTaskActionPromptFromAiContext(userPrompt)).toBe(false);
  });
});
