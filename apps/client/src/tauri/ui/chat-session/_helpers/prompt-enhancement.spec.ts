import {
  PromptEnhancementCancellationError,
  createQueuedMessageDispatchPrompt,
  isPromptEnhancementCancellation,
  resolveImmediatePromptEnhancementPlacement,
} from "./prompt-enhancement";

describe("prompt enhancement presentation", () => {
  it("recognizes cancellation only from authoritative task state", () => {
    const taskId = "prompt-enhancement-1";

    expect(
      isPromptEnhancementCancellation(
        new PromptEnhancementCancellationError(taskId),
        taskId,
        new Set(),
      ),
    ).toBe(true);
    expect(
      isPromptEnhancementCancellation(
        new Error("Prompt enhancement was cancelled."),
        taskId,
        new Set(),
      ),
    ).toBe(false);
    expect(
      isPromptEnhancementCancellation(
        new Error('The prompt quoted "cancelled" as an example.'),
        taskId,
        new Set([taskId]),
      ),
    ).toBe(true);
    expect(
      isPromptEnhancementCancellation(
        new PromptEnhancementCancellationError("another-task"),
        taskId,
        new Set(),
      ),
    ).toBe(false);
  });

  it("uses the edited-message marker only for edited-message enhancement", () => {
    const placement = resolveImmediatePromptEnhancementPlacement({
      conversationCutoffMessageId: "message-1",
    });

    expect(placement).toBe("edit-composer");
  });

  it("uses a message bubble for every non-edit enhancement flow", () => {
    expect(resolveImmediatePromptEnhancementPlacement({})).toBe("message");
  });

  it("executes an enhanced queued prompt while retaining its original prompt", () => {
    expect(
      createQueuedMessageDispatchPrompt(
        {
          task: "Draft a release note",
          visibleMessageContent: "Draft a release note",
          promptHistoryContent: "Draft a release note",
        },
        "Draft a concise customer release note",
      ),
    ).toEqual({
      task: "Draft a concise customer release note",
      visibleMessageContent: "Draft a concise customer release note",
      promptHistoryContent: "Draft a release note",
      promptEnhancement: { originalContent: "Draft a release note" },
    });
  });
});
