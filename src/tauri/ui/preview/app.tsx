import { Suspense, lazy, type JSX } from "react";
import { getCurrentShellWindowLabel } from "../lib/shell-store";
import {
  ASSISTANT_BUBBLE_WINDOW_LABEL,
  ASSISTANT_POPUP_WINDOW_LABEL,
  QUICK_VOICE_WINDOW_LABEL,
  TRAY_MENU_WINDOW_LABEL,
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
  const module = await import("../chat-session-shell");

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

const TrayMenuShell = lazy(async () => {
  const module = await import("../tray-menu-shell");

  return {
    default: module.TrayMenuShell,
  };
});

const previewWindowLabels = new Set<string>([
  ASSISTANT_BUBBLE_WINDOW_LABEL,
  ASSISTANT_POPUP_WINDOW_LABEL,
  QUICK_VOICE_WINDOW_LABEL,
  TRAY_MENU_WINDOW_LABEL,
]);

const getPreviewWindowLabel = (): string | null => {
  const currentWindowLabel = getCurrentShellWindowLabel();

  if (currentWindowLabel && previewWindowLabels.has(currentWindowLabel)) {
    return currentWindowLabel;
  }

  if (typeof window === "undefined") {
    return null;
  }

  const previewLabel = new URLSearchParams(window.location.search).get(
    "window",
  );

  if (!previewLabel || !previewWindowLabels.has(previewLabel)) {
    return null;
  }

  return previewLabel;
};

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
    windowLabel === QUICK_VOICE_WINDOW_LABEL ||
    windowLabel === TRAY_MENU_WINDOW_LABEL
  ) {
    return (
      <div className="fixed inset-0 overflow-hidden rounded-3xl bg-slate-950/98" />
    );
  }

  return <main className="min-h-screen bg-slate-950 text-slate-50" />;
};

export const App = (): JSX.Element => {
  const windowLabel = getPreviewWindowLabel();
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

  if (windowLabel === TRAY_MENU_WINDOW_LABEL) {
    return (
      <Suspense fallback={fallback}>
        <TrayMenuShell />
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
