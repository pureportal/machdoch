import type { JSX } from "react";
import { AssistantBubbleShell } from "../assistant-bubble-shell";
import { AssistantPopupShell } from "../assistant-popup-shell";
import { ChatSession } from "../chat-session";
import { getCurrentShellWindowLabel } from "../lib/shell-store";
import { QuickVoiceShell } from "../quick-voice-shell";
import {
  ASSISTANT_BUBBLE_WINDOW_LABEL,
  ASSISTANT_POPUP_WINDOW_LABEL,
  QUICK_VOICE_WINDOW_LABEL,
} from "../runtime";

export const App = (): JSX.Element => {
  const windowLabel = getCurrentShellWindowLabel();

  if (windowLabel === ASSISTANT_BUBBLE_WINDOW_LABEL) {
    return <AssistantBubbleShell />;
  }

  if (windowLabel === ASSISTANT_POPUP_WINDOW_LABEL) {
    return <AssistantPopupShell />;
  }

  if (windowLabel === QUICK_VOICE_WINDOW_LABEL) {
    return <QuickVoiceShell />;
  }

  return (
    <main className="min-h-screen bg-slate-950 text-slate-50 flex flex-col">
      <ChatSession />
    </main>
  );
};
