import {
  resolveImmediatePromptEnhancementPlacement,
  resolveStagedPromptEnhancementSubmission,
  shouldRenderPromptEnhancementSessionMessages,
} from "./prompt-enhancement";

describe("prompt enhancement presentation", () => {
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
