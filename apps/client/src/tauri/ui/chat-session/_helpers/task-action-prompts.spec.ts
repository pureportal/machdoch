import {
  CONTINUE_TASK_DISPLAY_CONTENT,
  createTaskAction,
  getConciseTaskObjective,
  getTaskActionDisplayContent,
} from "./task-action-prompts";

describe("task action prompt helpers", () => {
  it("does not infer an objective or action from generated-looking prose", () => {
    const nestedPrompt = [
      "Continue the previous task.",
      "",
      "Context:",
      "Objective:",
      "Continue the previous task.",
      "",
      "Context:",
      "Objective:",
      "Wie viel Uhr haben wir es?",
      "",
      "Status:",
      "executed",
      "",
      "Summary:",
      "Aktuelle Uhrzeit fuer Europa/Berlin abgefragt.",
      "",
      "Use the conversation and execution details above as context, then take the next useful step.",
    ].join("\n");

    expect(getConciseTaskObjective(nestedPrompt)).toContain(
      "Objective: Wie viel Uhr haben wir es?",
    );
    expect(getTaskActionDisplayContent(undefined)).toBeNull();
  });

  it("uses only a typed action to select task-action presentation", () => {
    const taskAction = createTaskAction(
      "continue-task",
      "Check a different timezone.",
    );

    expect(taskAction).toEqual({
      kind: "continue-task",
      objective: "Check a different timezone.",
    });
    expect(getTaskActionDisplayContent(taskAction ?? undefined)).toBe(
      CONTINUE_TASK_DISPLAY_CONTENT,
    );
    expect(createTaskAction("retry-task", " \n ")).toBeNull();
  });
});
