import {
  PromptEnhancementCancellationError,
  isPromptEnhancementCancellation,
  resolveImmediatePromptEnhancementPlacement,
  resolveStagedPromptEnhancementSubmission,
  shouldRenderPromptEnhancementSessionMessages,
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

  it("keeps edited-message enhancement out of conversation state", () => {
    const placement = resolveImmediatePromptEnhancementPlacement({
      conversationCutoffMessageId: "message-1",
      interviewEnabled: false,
      runningAction: null,
    });

    expect(placement).toBe("edit-composer");
    expect(shouldRenderPromptEnhancementSessionMessages(placement)).toBe(false);
  });

  it("retains the existing placements for normal enhancement flows", () => {
    expect(
      resolveImmediatePromptEnhancementPlacement({
        interviewEnabled: false,
        runningAction: null,
      }),
    ).toBe("message");
    expect(
      resolveImmediatePromptEnhancementPlacement({
        interviewEnabled: true,
        runningAction: null,
      }),
    ).toBe("composer-blocker");
    expect(shouldRenderPromptEnhancementSessionMessages("message")).toBe(true);
    expect(
      shouldRenderPromptEnhancementSessionMessages("composer-blocker"),
    ).toBe(true);
    expect(shouldRenderPromptEnhancementSessionMessages("queued-message")).toBe(
      true,
    );
  });

  it("submits a staged edit without enhancing it a second time", () => {
    expect(
      resolveStagedPromptEnhancementSubmission("simple", {
        mode: "simple",
        originalContent: "  Original request  ",
      }),
    ).toEqual({
      mode: "off",
      originalContent: "Original request",
    });
  });

  it("runs the newly selected mode after the staged mode changes", () => {
    expect(
      resolveStagedPromptEnhancementSubmission("web-search", {
        mode: "simple",
        originalContent: "Original request",
      }),
    ).toEqual({ mode: "web-search" });
  });
});
