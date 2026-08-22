import { createSession } from "../../chat-session.model";
import {
  createComposerClearGuard,
  createComposerSubmissionSessionSnapshot,
  isComposerClearGuardCurrent,
} from "./composer-submission";

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
