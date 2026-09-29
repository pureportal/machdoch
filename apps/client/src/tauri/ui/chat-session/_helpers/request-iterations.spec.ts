import { describe, expect, it } from "vitest";
import { DEFAULT_USER_AGENT_LIMITS_SETTINGS } from "../../../../core/runtime-contract.generated.js";
import {
  createInitialShellState,
  createSession,
  normalizeShellState,
} from "../../chat-session.model";
import { hasPendingChatWork } from "../../app-shell/shutdown-when-idle";
import { createQueuedMessageDispatchAttempt } from "./queued-message-lifecycle";
import {
  CONTINUE_ITERATION_CONTENT,
  applyEnhancedPromptToQueuedRequestIterations,
  createQueuedRequestIterations,
  getBlockingRequestIteration,
} from "./request-iterations";

describe("request iterations", () => {
  it("queues one enhanced request followed by ordered continuations", () => {
    const messages = createQueuedRequestIterations({
      sessionId: "session-1",
      task: "Improve the UI of view XY",
      count: 3,
      mode: "continue",
      orderRank: 4,
      contextAttachments: [
        {
          id: "reference",
          source: "path",
          kind: "file",
          name: "reference.md",
          path: "C:\\workspace\\reference.md",
        },
      ],
      promptEnhancementRequest: { mode: "simple" },
      timestamp: 10,
    });

    expect(messages).toHaveLength(3);
    expect(messages.map((message) => message.orderRank)).toEqual([4, 5, 6]);
    expect(messages.map((message) => message.iteration?.index)).toEqual([
      1, 2, 3,
    ]);
    expect(messages.every((message) => message.iteration?.total === 3)).toBe(
      true,
    );
    expect(messages.map((message) => message.promptEnhancementRequest)).toEqual(
      [{ mode: "simple" }, undefined, undefined],
    );
    expect(
      messages.slice(1).map((message) => message.visibleMessageContent),
    ).toEqual([CONTINUE_ITERATION_CONTENT, CONTINUE_ITERATION_CONTENT]);
    expect(messages[1]?.task).toBe(CONTINUE_ITERATION_CONTENT);
    expect(
      messages.every((message) => message.contextAttachments.length === 1),
    ).toBe(true);
    expect(messages[0]?.contextAttachments).not.toBe(
      messages[1]?.contextAttachments,
    );

    const first = createQueuedMessageDispatchAttempt(
      messages[0]!,
      "Improve the UI of view XY with clearer spacing",
      11,
    );
    const second = createQueuedMessageDispatchAttempt(
      messages[1]!,
      undefined,
      12,
    );
    expect(first.message.promptEnhancementRequest).toBeUndefined();
    expect(first.message.iteration?.index).toBe(1);
    expect(second.prompt.visibleMessageContent).toBe("Continue");
    expect(second.prompt.task).toBe("Continue");
    expect(second.message.promptEnhancementRequest).toBeUndefined();
  });

  it.each([
    ["repeat-prompt", "Improve the UI"],
    ["continue", CONTINUE_ITERATION_CONTENT],
  ] as const)("sends %s for later iterations", (mode, expectedContent) => {
    const messages = createQueuedRequestIterations({
      sessionId: "session-1",
      task: "Improve the UI",
      count: 3,
      mode,
      orderRank: 0,
      contextAttachments: [],
      timestamp: 10,
    });

    expect(messages[0]?.task).toBe("Improve the UI");
    expect(messages.slice(1).map((message) => message.task)).toEqual([
      expectedContent,
      expectedContent,
    ]);
    expect(
      messages.slice(1).map((message) => message.visibleMessageContent),
    ).toEqual([expectedContent, expectedContent]);
    expect(
      createQueuedMessageDispatchAttempt(messages[1]!, undefined, 11).prompt
        .task,
    ).toBe(expectedContent);
  });

  it("repeats the prompt with a continuation instruction after a separator", () => {
    const messages = createQueuedRequestIterations({
      sessionId: "session-1",
      task: "Improve the UI",
      count: 2,
      mode: "repeat-prompt-and-continue",
      orderRank: 0,
      contextAttachments: [],
      timestamp: 10,
    });
    const followUp = messages[1]!;

    expect(followUp.task).toMatch(/^Improve the UI\n\n---\n\nNext iteration:/);
    expect(followUp.task).toContain("Continue working on the request above");
    expect(followUp.task).toContain("preceding conversation");
    expect(followUp.visibleMessageContent).toBe(followUp.task);
    expect(
      createQueuedMessageDispatchAttempt(followUp, undefined, 11).prompt.task,
    ).toBe(followUp.task);
  });

  it.each([
    ["repeat-prompt", "Enhanced request"],
    ["continue", CONTINUE_ITERATION_CONTENT],
    [
      "repeat-prompt-and-continue",
      "Enhanced request\n\n---\n\nNext iteration: Continue working on the request above. Use the preceding conversation as context and avoid repeating completed work.",
    ],
  ] as const)(
    "reuses the first enhanced prompt for %s follow-ups",
    (mode, expectedContent) => {
      const messages = createQueuedRequestIterations({
        sessionId: "session-1",
        task: "Original request",
        count: 3,
        mode,
        orderRank: 0,
        contextAttachments: [],
        promptEnhancementRequest: { mode: "simple" },
        timestamp: 10,
      });
      const first = createQueuedMessageDispatchAttempt(
        messages[0]!,
        "Enhanced request",
        11,
      );
      const updated = applyEnhancedPromptToQueuedRequestIterations(
        [first.message, ...messages.slice(1)],
        messages[0]!,
        first.prompt.task,
        11,
      );

      expect(updated.map((message) => message.task)).toEqual([
        "Enhanced request",
        expectedContent,
        expectedContent,
      ]);
      expect(
        updated.slice(1).map((message) => message.visibleMessageContent),
      ).toEqual([expectedContent, expectedContent]);
      expect(
        updated.slice(1).map((message) => message.promptHistoryContent),
      ).toEqual([expectedContent, expectedContent]);
      expect(
        updated.map((message) => message.promptEnhancementRequest),
      ).toEqual([undefined, undefined, undefined]);
      expect(
        updated
          .slice(1)
          .map(
            (message) =>
              createQueuedMessageDispatchAttempt(message, undefined, 12).prompt
                .task,
          ),
      ).toEqual([expectedContent, expectedContent]);
    },
  );

  it("leaves edited and unrelated queued messages unchanged after enhancement", () => {
    const messages = createQueuedRequestIterations({
      sessionId: "session-1",
      task: "Original request",
      count: 3,
      mode: "repeat-prompt",
      orderRank: 0,
      contextAttachments: [],
      timestamp: 10,
    });
    const editedFollowUp = {
      ...messages[1]!,
      task: "Different request",
      contentUpdatedAt: 11,
    };
    const editedFirst = {
      ...messages[0]!,
      task: "Revised request",
      contentUpdatedAt: 11,
    };
    const otherGroup = createQueuedRequestIterations({
      sessionId: "session-1",
      task: "Other request",
      count: 2,
      mode: "repeat-prompt",
      orderRank: 3,
      contextAttachments: [],
      timestamp: 10,
    });
    const updated = applyEnhancedPromptToQueuedRequestIterations(
      [editedFirst, editedFollowUp, messages[2]!, ...otherGroup],
      editedFirst,
      "Enhanced request",
      12,
    );

    expect(updated[1]).toBe(editedFollowUp);
    expect(updated[2]?.task).toBe("Enhanced request");
    expect(updated[3]).toBe(otherGroup[0]);
    expect(updated[4]).toBe(otherGroup[1]);
  });

  it("keeps shutdown pending until the final continuation drains", () => {
    const state = createInitialShellState();
    const session = createSession({ id: "session-1" });
    state.sessions.push(session);
    state.queuedSessionMessages = createQueuedRequestIterations({
      sessionId: session.id,
      task: "Improve the UI",
      count: 3,
      mode: "continue",
      orderRank: 0,
      contextAttachments: [],
      timestamp: 10,
    });
    const normalized = normalizeShellState(state);
    expect(normalized.queuedSessionMessages[2]?.iteration?.index).toBe(3);
    expect(normalized.queuedSessionMessages[2]?.iteration?.mode).toBe(
      "continue",
    );

    while (state.queuedSessionMessages.length > 0) {
      expect(
        hasPendingChatWork(state, DEFAULT_USER_AGENT_LIMITS_SETTINGS),
      ).toBe(true);
      state.queuedSessionMessages.shift();
    }
    expect(hasPendingChatWork(state, DEFAULT_USER_AGENT_LIMITS_SETTINGS)).toBe(
      false,
    );
  });

  it("waits for earlier queued or failed iterations before dispatch", () => {
    const messages = createQueuedRequestIterations({
      sessionId: "session-1",
      task: "Improve the UI",
      count: 3,
      mode: "continue",
      orderRank: 0,
      contextAttachments: [],
      timestamp: 10,
    });
    expect(
      getBlockingRequestIteration(messages[1]!, messages)?.iteration?.index,
    ).toBe(1);
    expect(
      getBlockingRequestIteration(messages[2]!, messages)?.iteration?.index,
    ).toBe(1);
    messages[0]!.status = "failed";
    expect(getBlockingRequestIteration(messages[1]!, messages)?.status).toBe(
      "failed",
    );
    messages.shift();
    expect(
      getBlockingRequestIteration(messages[1]!, messages)?.iteration?.index,
    ).toBe(2);
    messages.shift();
    expect(getBlockingRequestIteration(messages[0]!, messages)).toBeUndefined();
  });
});
