import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import type {
  ProductCommand,
  ProductAttachment,
  ComposerHistorySelection,
} from "@machdoch/fleet-protocol";
import type { RemoteComposerProps } from "@machdoch/product-ui";
import { navigatePromptHistory } from "./prompt-history-navigation";

type HistoryEntry = NonNullable<
  RemoteComposerProps["composer"]["history"]
>[number];
type DraftEntry = NonNullable<
  ReturnType<RemoteComposerProps["drafts"]["sessions"]["get"]>
>;

interface HistoryPreview {
  sessionId: string;
  workspace: string | undefined;
  position: number;
  entry: HistoryEntry;
  originalDraft: string;
  nativeDraftAtPreview: string;
  originalAttachments: ProductAttachment[];
  historyIdentity: string;
  draftEntry: DraftEntry;
  previewRevision: number;
  committing: Promise<boolean> | null;
  committedDraft: string | null;
}

export function useRemoteComposerHistory(props: RemoteComposerProps) {
  const latest = useRef(props);
  latest.current = props;
  const previewRef = useRef<HistoryPreview | null>(null);
  const navigation = useRef(Promise.resolve());
  const mounted = useRef(false);
  const [preview, setPreview] = useState<HistoryPreview | null>(null);
  const historyIdentity = JSON.stringify(props.composer.history ?? []);
  const nativeAttachmentIdentity = JSON.stringify(props.composer.attachments.map(({ id }) => id));

  const publish = useCallback((value: HistoryPreview | null): void => {
    previewRef.current = value;
    if (mounted.current) setPreview(value);
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const value = previewRef.current;
      if (
        !value ||
        value.committing ||
        value.draftEntry.revision !== value.previewRevision
      )
        return;
      value.draftEntry.text = value.originalDraft;
      value.draftEntry.revision += 1;
      previewRef.current = null;
      latest.current.drafts.changed();
    };
  }, []);

  useEffect(() => {
    const value = previewRef.current;
    if (!value) return;
    const sameSession = value.sessionId === props.session.id && value.workspace === props.session.workspace;
    if (sameSession && value.committing) return;
    if (sameSession && props.composer.draft === value.originalDraft) value.nativeDraftAtPreview = value.originalDraft;
    const nativeChanged = sameSession && (props.composer.draft !== value.nativeDraftAtPreview || nativeAttachmentIdentity !== JSON.stringify(value.originalAttachments.map(({ id }) => id)));
    if (sameSession && value.historyIdentity === historyIdentity && !nativeChanged) return;
    if (
      !value.committing &&
      value.draftEntry.revision === value.previewRevision
    ) {
      value.draftEntry.text = nativeChanged ? props.composer.draft : value.originalDraft;
      value.draftEntry.revision += 1;
      props.drafts.changed();
    }
    publish(null);
  }, [
    props.session.id,
    props.session.workspace,
    props.composer.draft,
    nativeAttachmentIdentity,
    historyIdentity,
    props.drafts,
    publish,
  ]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>, currentDraft: string): void => {
      if (
        event.nativeEvent.isComposing ||
        event.keyCode === 229 ||
        (event.key !== "ArrowUp" && event.key !== "ArrowDown")
      )
        return;
      const state = latest.current;
      if (!state.composer.history?.length) return;
      if (
        !previewRef.current &&
        (event.key === "ArrowDown" ||
          event.currentTarget.selectionStart !== 0 ||
          event.currentTarget.selectionStart !==
            event.currentTarget.selectionEnd)
      )
        return;
      event.preventDefault();
      const sessionId = state.session.id;
      const direction = event.key === "ArrowUp" ? "previous" : "next";
      navigation.current = navigation.current
        .then(async () => {
          const controls = latest.current;
          if (!mounted.current || controls.session.id !== sessionId) return;
          let draftEntry = controls.drafts.sessions.get(sessionId);
          const revision = draftEntry?.revision;
          await draftEntry?.pending;
          if (
            !mounted.current ||
            latest.current.session.id !== sessionId ||
            draftEntry?.revision !== revision
          )
            return;
          const history = latest.current.composer.history ?? [];
          if (!history.length) return;
          const active = previewRef.current;
          if (active?.committing) return;
          if (!active && draftEntry && draftEntry.text !== currentDraft) return;
          if (!draftEntry) {
            draftEntry = {
              text: currentDraft,
              revision: 0,
              pending: Promise.resolve(),
              error: null,
              failedSubmission: null,
            };
            controls.drafts.sessions.set(sessionId, draftEntry);
          }
          const next = navigatePromptHistory(
            {
              draft: draftEntry.text,
              draftBeforeHistory: active?.originalDraft ?? "",
              historyIndex: active?.position ?? null,
            },
            history.map(({ prompt }) => prompt),
            direction,
          );
          draftEntry.text = next.draft;
          draftEntry.revision += 1;
          draftEntry.error = null;
          if (next.historyIndex === null) {
            publish(null);
          } else {
            const entry = history[next.historyIndex];
            if (!entry) return;
            publish({
              sessionId,
              workspace: controls.session.workspace,
              position: next.historyIndex,
              entry,
          originalDraft: active?.originalDraft ?? next.draftBeforeHistory,
          nativeDraftAtPreview: active?.nativeDraftAtPreview ?? latest.current.composer.draft,
              originalAttachments:
                active?.originalAttachments ??
                latest.current.composer.attachments,
              historyIdentity: JSON.stringify(history),
              draftEntry,
              previewRevision: draftEntry.revision,
              committing: null,
              committedDraft: null,
            });
          }
          controls.drafts.changed();
        })
        .catch((reason: unknown) => {
          const entry = latest.current.drafts.sessions.get(sessionId);
          if (entry)
            entry.error =
              reason instanceof Error ? reason.message : String(reason);
          latest.current.drafts.changed();
        });
    },
    [publish],
  );

  const execute = useCallback(
    async (command: ProductCommand): Promise<boolean> => {
      const active = previewRef.current;
      const controls = latest.current;
      if (
        !active ||
        !("sessionId" in command) ||
        command.sessionId !== active.sessionId
      )
        return controls.onCommand(command);
      if (!active.committing) {
        const history: ComposerHistorySelection = {
          index: active.entry.index,
          prompt: active.entry.prompt,
          attachmentIds: active.entry.attachments.map(({ id }) => id),
          previousDraft: active.originalDraft,
          previousAttachmentIds: active.originalAttachments.map(({ id }) => id),
        };
        const draft =
          command.kind === "update-draft"
            ? command.prompt
            : active.draftEntry.text;
        active.committedDraft = draft;
        active.committing = (async () => {
          try {
            const accepted = await controls.onCommand({
              kind: "restore-prompt-history",
              sessionId: active.sessionId,
              prompt: draft,
              history,
            });
            if (!accepted)
              throw new Error(
                "The draft or prompt history changed. Select the prompt again.",
              );
            if (previewRef.current === active) publish(null);
            return true;
          } catch (reason) {
            active.draftEntry.error =
              reason instanceof Error ? reason.message : String(reason);
            controls.drafts.changed();
            active.committing = null;
            return false;
          }
        })();
      }
      if (!(await active.committing)) return false;
      if (
        command.kind === "update-draft" &&
        command.prompt === active.committedDraft
      )
        return true;
      return controls.onCommand(command);
    },
    [publish],
  );

  return {
    composer:
      preview?.sessionId === props.session.id
        ? { ...props.composer, attachments: preview.entry.attachments }
        : props.composer,
    handleKeyDown,
    execute,
  };
}
