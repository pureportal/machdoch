import { Suspense, lazy, useEffect, type JSX } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentShellWindowLabel } from "../lib/shell-store";
import { QUICK_VOICE_WINDOW_LABEL, TRAY_MENU_WINDOW_LABEL } from "../runtime";

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
  if (
    windowLabel === QUICK_VOICE_WINDOW_LABEL ||
    windowLabel === TRAY_MENU_WINDOW_LABEL
  ) {
    return (
      <div className="fixed inset-0 overflow-hidden rounded-3xl bg-slate-950/98" />
    );
  }

  return <main className="min-h-screen bg-slate-950 text-slate-50" />;
};

const MainWindowReady = (): null => {
  useEffect(() => {
    if (isTauri()) {
      void invoke("main_window_ready").catch((error: unknown) => {
        console.error("Failed to initialize the main window", error);
      });
    }
  }, []);
  return null;
};

export const App = (): JSX.Element => {
  const windowLabel = getPreviewWindowLabel();
  const fallback = <WindowLoadingFallback windowLabel={windowLabel} />;

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
      <main className="h-dvh min-h-0 bg-slate-950 text-slate-50 flex flex-col">
        <ChatSession />
        <MainWindowReady />
      </main>
    </Suspense>
  );
};
