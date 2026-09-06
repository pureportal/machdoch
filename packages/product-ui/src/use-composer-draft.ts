import type { ProductCommand, ProductShell } from "@machdoch/fleet-protocol";
import { useReducer, useRef } from "react";
import type { ProductCommandHandler } from "./product-runtime";

interface SessionDraft {
  text: string;
  revision: number;
  pending: Promise<void>;
  error: string | null;
}

export function useComposerDraft(
  composer: NonNullable<ProductShell["composer"]>,
  onCommand: ProductCommandHandler,
) {
  const drafts = useRef(new Map<string, SessionDraft>());
  const [, render] = useReducer((revision: number) => revision + 1, 0);
  const sessionId = composer.sessionId;
  const draft = drafts.current.get(sessionId)?.text ?? composer.draft;

  function getDraft(): SessionDraft {
    let entry = drafts.current.get(sessionId);
    if (!entry) {
      entry = {
        text: composer.draft,
        revision: 0,
        pending: Promise.resolve(),
        error: null,
      };
      drafts.current.set(sessionId, entry);
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
      render();
      return false;
    }
  }

  function updateDraft(text: string): void {
    const entry = getDraft();
    entry.text = text;
    entry.revision += 1;
    entry.error = null;
    render();
    entry.pending = entry.pending.then(async () => {
      await execute(entry, { kind: "update-draft", sessionId, prompt: text });
    });
  }

  function submitDraft(): Promise<void> {
    const entry = getDraft();
    const submittedText = entry.text;
    const prompt = submittedText.trim();
    if (!prompt || !composer.canSend) return Promise.resolve();
    entry.text = "";
    entry.revision += 1;
    entry.error = null;
    const submittedRevision = entry.revision;
    render();
    entry.pending = entry.pending.then(async () => {
      const succeeded = await execute(entry, {
        kind: "submit-message",
        sessionId,
        prompt,
        promptEnhancementMode: composer.promptEnhancementMode,
        interviewEnabled: composer.interviewEnabled,
      });
      if (entry.revision !== submittedRevision) return;
      if (!succeeded) {
        entry.text = submittedText;
        entry.revision += 1;
        render();
      }
      await execute(entry, {
        kind: "update-draft",
        sessionId,
        prompt: entry.text,
      });
    });
    return entry.pending;
  }

  return {
    draft,
    updateDraft,
    submitDraft,
    error: drafts.current.get(sessionId)?.error,
  };
}
