import { useCallback, useMemo, useState } from "react";

export interface ConversationControls {
  editingMessageId: string | null;
  expandedOriginalPromptIds: ReadonlySet<string>;
  selectedMessageId: string | null;
  startEditing: (messageId: string) => void;
  cancelEditing: () => void;
  toggleOriginalPrompt: (messageId: string) => void;
  selectMessage: (messageId: string | null) => void;
  reset: () => void;
}

export function useConversationControls(): ConversationControls {
  const [editingMessageId, startEditing] = useState<string | null>(null);
  const [expandedOriginalPromptIds, setExpanded] = useState<
    ReadonlySet<string>
  >(new Set());
  const [selectedMessageId, selectMessage] = useState<string | null>(null);
  const cancelEditing = useCallback(() => startEditing(null), []);
  const toggleOriginalPrompt = useCallback((messageId: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(messageId)) next.delete(messageId);
      else next.add(messageId);
      return next;
    });
  }, []);
  const reset = useCallback(() => {
    startEditing(null);
    setExpanded(new Set());
    selectMessage(null);
  }, []);
  return useMemo(
    () => ({
      editingMessageId,
      expandedOriginalPromptIds,
      selectedMessageId,
      startEditing,
      cancelEditing,
      toggleOriginalPrompt,
      selectMessage,
      reset,
    }),
    [
      editingMessageId,
      expandedOriginalPromptIds,
      selectedMessageId,
      cancelEditing,
      toggleOriginalPrompt,
      reset,
    ],
  );
}
