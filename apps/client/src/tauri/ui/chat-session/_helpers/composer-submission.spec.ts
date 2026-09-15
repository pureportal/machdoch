import { createSession } from "../../chat-session.model";
import {
  createComposerClearGuard,
  createComposerSubmissionSessionSnapshot,
  getSessionMessageRunningAction,
  isComposerClearGuardCurrent,
} from "./composer-submission";
import { shouldDeferPromptEnhancementUntilQueuedDispatch } from "./prompt-enhancement";

const createDraftSession = (draft: string, draftUpdatedAt: number) => ({
  ...createSession({
    id: "session-1",
    provider: "openai",
    model: "gpt-5.4",
    draft,
  }),
  draftUpdatedAt,
  updatedAt: draftUpdatedAt,
});

describe("composer submission snapshots", () => {
  it("uses the current session metadata when the buffered draft was already published", () => {
    const submittedDraft = "Investigate the composer race";
    const renderedSession = createDraftSession(
      "Investigate the composer rac",
      100,
    );
    const currentSession = createDraftSession(submittedDraft, 200);

    const submissionSession = createComposerSubmissionSessionSnapshot(
      renderedSession,
      currentSession,
      submittedDraft,
    );

    expect(submissionSession).toBe(currentSession);
    expect(
      isComposerClearGuardCurrent(
        currentSession,
        createComposerClearGuard(submissionSession),
      ),
    ).toBe(true);
  });

  it("does not make a concurrent draft eligible for clearing", () => {
    const renderedSession = createDraftSession("Submitted request", 100);
    const currentSession = createDraftSession("New unsent request", 300);

    const submissionSession = createComposerSubmissionSessionSnapshot(
      renderedSession,
      currentSession,
      "Submitted request",
    );

    expect(submissionSession.draft).toBe("Submitted request");
    expect(submissionSession.draftUpdatedAt).toBe(300);
    expect(
      isComposerClearGuardCurrent(
        currentSession,
        createComposerClearGuard(submissionSession),
      ),
    ).toBe(false);
  });

  it("retains timestamp protection when a draft changes back to the same text", () => {
    const originalSession = createDraftSession("Same text", 100);
    const guard = createComposerClearGuard(originalSession);
    const changedSession = createDraftSession("Same text", 200);

    expect(isComposerClearGuardCurrent(changedSession, guard)).toBe(false);
  });
});

describe("session message routing", () => {
  const runningSession = createSession({
    id: "session-1",
    messages: [{ id: "task-1", role: "user", content: "First request" }],
  });
  const completedSession = createSession({
    ...runningSession,
    messages: [
      ...runningSession.messages,
      {
        id: "task-1-result",
        taskId: "task-1",
        role: "agent",
        content: "Done",
        outcome: { status: "succeeded" },
      },
    ],
  });

  it.each(["queue", "steer", "stop-and-send"] as const)(
    "queues during post-agent processing with the %s preference",
    (runningAction) => {
      expect(
        getSessionMessageRunningAction({
          session: completedSession,
          activeTaskId: null,
          unsettledTaskId: "task-1",
          runningAction,
        }),
      ).toBe("queue");
    },
  );

  it.each(["queue", "steer", "stop-and-send"] as const)(
    "preserves the %s action while the agent is running",
    (runningAction) => {
      for (const [session, activeTaskId] of [
        [runningSession, "task-1"],
        [runningSession, null],
        [completedSession, "task-1"],
      ] as const) {
        expect(
          getSessionMessageRunningAction({
            session,
            activeTaskId,
            unsettledTaskId: "task-1",
            runningAction,
          }),
        ).toBe(runningAction);
      }
    },
  );

  it.each(["simple", "web-search"] as const)(
    "defers %s enhancement until post-agent processing settles",
    (mode) => {
      const runningAction = getSessionMessageRunningAction({
        session: completedSession,
        activeTaskId: null,
        unsettledTaskId: "task-1",
        runningAction: "steer",
      });

      expect(
        shouldDeferPromptEnhancementUntilQueuedDispatch(mode, runningAction),
      ).toBe(true);
    },
  );

  it.each([createSession({ id: "empty" }), completedSession])(
    "sends directly when the session is settled",
    (session) => {
      expect(
        getSessionMessageRunningAction({
          session,
          activeTaskId: null,
          unsettledTaskId: null,
          runningAction: "queue",
        }),
      ).toBeNull();
    },
  );
});
