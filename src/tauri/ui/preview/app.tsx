import { Suspense, lazy, type JSX } from "react";
import { getCurrentShellWindowLabel } from "../lib/shell-store";
import {
  ASSISTANT_BUBBLE_WINDOW_LABEL,
  ASSISTANT_POPUP_WINDOW_LABEL,
  QUICK_VOICE_WINDOW_LABEL,
} from "../runtime";

const AssistantBubbleShell = lazy(async () => {
  const module = await import("../assistant-bubble-shell");

  return {
    default: module.AssistantBubbleShell,
  };
});

const AssistantPopupShell = lazy(async () => {
  const module = await import("../assistant-popup-shell");

  return {
    default: module.AssistantPopupShell,
  };
});

const ChatSession = lazy(async () => {
  const module = await import("../chat-session");

  return {
    default: module.ChatSession,
  };
});

const QuickVoiceShell = lazy(async () => {
  const module = await import("../quick-voice-shell");

  return {
    default: module.QuickVoiceShell,
  };
});

const WindowLoadingFallback = ({
  windowLabel,
}: {
  windowLabel: string | null;
}): JSX.Element => {
  if (windowLabel === ASSISTANT_BUBBLE_WINDOW_LABEL) {
    return <div className="fixed inset-0 overflow-hidden bg-transparent" />;
  }

  if (
    windowLabel === ASSISTANT_POPUP_WINDOW_LABEL ||
    windowLabel === QUICK_VOICE_WINDOW_LABEL
  ) {
    return (
      <div className="fixed inset-0 overflow-hidden rounded-3xl bg-slate-950/98" />
    );
  }

  return <main className="min-h-screen bg-slate-950 text-slate-50" />;
};

export const App = (): JSX.Element => {
  const windowLabel = getCurrentShellWindowLabel();
  const fallback = <WindowLoadingFallback windowLabel={windowLabel} />;

  if (windowLabel === ASSISTANT_BUBBLE_WINDOW_LABEL) {
    return (
      <Suspense fallback={fallback}>
        <AssistantBubbleShell />
      </Suspense>
    );
  }

  if (windowLabel === ASSISTANT_POPUP_WINDOW_LABEL) {
    return (
      <Suspense fallback={fallback}>
        <AssistantPopupShell />
      </Suspense>
    );
  }

  if (windowLabel === QUICK_VOICE_WINDOW_LABEL) {
    return (
      <Suspense fallback={fallback}>
        <QuickVoiceShell />
      </Suspense>
    );
  }

  return (
    <Suspense fallback={fallback}>
      <main className="min-h-screen bg-slate-950 text-slate-50 flex flex-col">
        <ChatSession />
      </main>
    </Suspense>
  );
};
