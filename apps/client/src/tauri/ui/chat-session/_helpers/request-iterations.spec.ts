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
  createQueuedRequestIterations,
  getBlockingRequestIteration,
} from "./request-iterations";

describe("request iterations", () => {
  it("queues one enhanced request followed by ordered continuations", () => {
    const messages = createQueuedRequestIterations({
      sessionId: "session-1",
      task: "Improve the UI of view XY",
      count: 3,
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
    expect(messages[1]?.task).toContain("Improve the UI of view XY");
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
    expect(second.message.promptEnhancementRequest).toBeUndefined();
  });

  it("keeps shutdown pending until the final continuation drains", () => {
    const state = createInitialShellState();
    const session = createSession({ id: "session-1" });
    state.sessions.push(session);
    state.queuedSessionMessages = createQueuedRequestIterations({
      sessionId: session.id,
      task: "Improve the UI",
      count: 3,
      orderRank: 0,
      contextAttachments: [],
      timestamp: 10,
    });
    const normalized = normalizeShellState(state);
    expect(normalized.queuedSessionMessages[2]?.iteration?.index).toBe(3);

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
