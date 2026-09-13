import type { ProductCommand, ProductShell } from "@machdoch/fleet-protocol";
import { useSyncExternalStore } from "react";
import type { ProductCommandHandler } from "./product-runtime";

interface SessionDraft {
  text: string;
  revision: number;
  pending: Promise<void>;
  error: string | null;
  failedSubmission: string | null;
}

export function createComposerDraftStore() {
  const listeners = new Set<() => void>();
  let revision = 0;
  return {
    sessions: new Map<string, SessionDraft>(),
    submitting: false,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getRevision: () => revision,
    changed() {
      revision += 1;
      for (const listener of listeners) listener();
    },
  };
}

export type ComposerDraftStore = ReturnType<typeof createComposerDraftStore>;

export function useComposerDraft(
  composer: NonNullable<ProductShell["composer"]>,
  onCommand: ProductCommandHandler,
  drafts: ComposerDraftStore,
) {
  useSyncExternalStore(
    drafts.subscribe,
    drafts.getRevision,
    drafts.getRevision,
  );
  const sessionId = composer.sessionId;
  const draft = drafts.sessions.get(sessionId)?.text ?? composer.draft;

  function getDraft(): SessionDraft {
    let entry = drafts.sessions.get(sessionId);
    if (!entry) {
      entry = {
        text: composer.draft,
        revision: 0,
        pending: Promise.resolve(),
        error: null,
        failedSubmission: null,
      };
      drafts.sessions.set(sessionId, entry);
    }
    return entry;
  }

  async function execute(
    entry: SessionDraft,
    command: ProductCommand,
  ): Promise<boolean> {
    try {
      return await onCommand(command);
    } catch (reason) {
      entry.error =
        reason instanceof Error ? reason.message : "Command failed.";
      drafts.changed();
      return false;
    }
  }

  function updateDraft(text: string): void {
    const entry = getDraft();
    entry.text = text;
    entry.revision += 1;
    entry.error = null;
    const revision = entry.revision;
    drafts.changed();
    entry.pending = entry.pending.then(async () => {
      if (entry.revision !== revision) return;
      await execute(entry, { kind: "update-draft", sessionId, prompt: text });
    });
  }

  function submitDraft(): Promise<void> {
    const entry = getDraft();
    const submittedText = entry.text;
    const prompt = submittedText.trim();
    if (
      !prompt ||
      !composer.canSend ||
      drafts.submitting ||
      entry.failedSubmission !== null
    )
      return Promise.resolve();
    drafts.submitting = true;
    entry.text = "";
    entry.revision += 1;
    entry.error = null;
    const submittedRevision = entry.revision;
    drafts.changed();
    entry.pending = entry.pending
      .then(async () => {
        const succeeded = await execute(entry, {
          kind: "submit-message",
          sessionId,
          prompt,
          promptEnhancementMode: composer.promptEnhancementMode,
          interviewEnabled: composer.interviewEnabled,
        });
        if (entry.revision !== submittedRevision) {
          if (!succeeded) {
            entry.failedSubmission = submittedText;
            drafts.changed();
          }
          return;
        }
        if (!succeeded) {
          entry.text = submittedText;
          entry.revision += 1;
          drafts.changed();
        }
        await execute(entry, {
          kind: "update-draft",
          sessionId,
          prompt: entry.text,
        });
      })
      .finally(() => {
        drafts.submitting = false;
        drafts.changed();
      });
    return entry.pending;
  }

  return {
    draft,
    updateDraft,
    submitDraft,
    submitting: drafts.submitting,
    error: drafts.sessions.get(sessionId)?.error,
    failedSubmission: drafts.sessions.get(sessionId)?.failedSubmission ?? null,
    restoreFailedSubmission() {
      const entry = getDraft();
      if (entry.failedSubmission === null) return;
      const text = entry.text
        ? `${entry.failedSubmission}\n\n${entry.text}`
        : entry.failedSubmission;
      entry.failedSubmission = null;
      updateDraft(text);
    },
    discardFailedSubmission() {
      const entry = getDraft();
      entry.failedSubmission = null;
      entry.error = null;
      drafts.changed();
    },
  };
}
