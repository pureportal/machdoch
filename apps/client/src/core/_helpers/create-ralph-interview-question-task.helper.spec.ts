import { createRalphInterviewQuestionTask } from "./create-ralph-interview-question-task.helper.ts";

describe("createRalphInterviewQuestionTask", () => {
  it("creates a question-generation task with defaults and empty transcript text", () => {
    const task = createRalphInterviewQuestionTask({
      flow: { name: "Deploy Flow" },
      block: { id: "interview", title: "Clarify deployment" },
      goal: "Collect deployment inputs.",
      state: { turn: 0, transcript: [] },
    });

    expect(task).toContain("Ralph flow: Deploy Flow");
    expect(task).toContain("Interview block: Clarify deployment (interview)");
    expect(task).toContain("Interview goal:\nCollect deployment inputs.");
    expect(task).toContain("Current turn: 0 of 5");
    expect(task).toContain("Ask at most 3 questions this turn.");
    expect(task).toContain("No answers have been collected yet.");
    expect(task).not.toContain("Completion criteria:");
  });

  it("includes configured limits, completion criteria, prior answers, and skipped answers", () => {
    const task = createRalphInterviewQuestionTask({
      flow: { name: "Release Flow" },
      block: {
        id: "release_interview",
        title: "Release details",
        maxTurns: 1,
        questionsPerTurn: 1,
      },
      goal: "Collect release notes.",
      completionCriteria: "All blockers are known.",
      state: {
        turn: 1,
        transcript: [
          { fieldId: "version", question: "Version?", answer: "1.2.3" },
          { fieldId: "risk", question: "Risk?", answer: null },
        ],
      },
    });

    expect(task).toContain("Completion criteria:\nAll blockers are known.");
    expect(task).toContain("Current turn: 1 of 1");
    expect(task).toContain("Ask at most 1 question this turn.");
    expect(task).toContain("1. Q: Version?\n   A: 1.2.3");
    expect(task).toContain("2. Q: Risk?\n   A: [skipped]");
  });
});
