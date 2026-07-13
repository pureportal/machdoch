import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  ArrowUpRight,
  LogOut,
  Minus,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useState, type JSX } from "react";
import {
  hideMainWindowToTray,
  isMainWindowOpen,
  quitMachdoch,
  revealMainWindow,
} from "./assistant-surface";

const TRAY_MENU_BLUR_HIDE_DELAY_MS = 90;

interface TrayMenuAction {
  id: string;
  label: string;
  icon: LucideIcon;
  tone: "sky" | "violet" | "slate" | "danger";
  onSelect: () => Promise<void>;
}

interface TrayMenuActionButtonProps {
  action: TrayMenuAction;
  onSelect: (action: TrayMenuAction) => void;
}

const actionToneClasses: Record<TrayMenuAction["tone"], string> = {
  sky: "border-sky-400/30 bg-sky-400/10 text-sky-100 group-hover:border-sky-300/45 group-hover:bg-sky-400/15",
  violet:
    "border-violet-400/30 bg-violet-400/10 text-violet-100 group-hover:border-violet-300/45 group-hover:bg-violet-400/15",
  slate:
    "border-slate-700 bg-slate-900/80 text-slate-300 group-hover:border-slate-600 group-hover:bg-slate-800/90 group-hover:text-slate-100",
  danger:
    "border-rose-400/25 bg-rose-400/10 text-rose-100 group-hover:border-rose-300/40 group-hover:bg-rose-400/15",
};

const TrayMenuActionButton = ({
  action,
  onSelect,
}: TrayMenuActionButtonProps): JSX.Element => {
  const Icon = action.icon;

  return (
    <button
      type="button"
      onClick={() => {
        onSelect(action);
      }}
      className="group flex h-12 w-full items-center gap-3 rounded-lg px-3 text-left text-sm font-medium text-slate-100 outline-none transition-colors duration-150 hover:bg-slate-900/80 focus-visible:bg-slate-900/80 focus-visible:ring-2 focus-visible:ring-sky-400/45"
    >
      <span
        aria-hidden="true"
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md border transition-colors duration-150 ${actionToneClasses[action.tone]}`}
      >
        <Icon className="h-4 w-4" />
      </span>
      <span className="min-w-0 flex-1 truncate">{action.label}</span>
    </button>
  );
};

export const TrayMenuShell = (): JSX.Element => {
  const [mainWindowOpen, setMainWindowOpen] = useState(() => !isTauri());

  const hideTrayMenu = useCallback(async (): Promise<void> => {
    if (!isTauri()) {
      return;
    }

    await getCurrentWindow().hide();
  }, []);

  const actions: TrayMenuAction[] = [
    {
      id: "open-app",
      label: "Open machdoch",
      icon: ArrowUpRight,
      tone: "slate",
      onSelect: revealMainWindow,
    },
    ...(mainWindowOpen
      ? [
          {
            id: "hide-to-tray",
            label: "Hide to tray",
            icon: Minus,
            tone: "slate",
            onSelect: hideMainWindowToTray,
          } satisfies TrayMenuAction,
        ]
      : []),
    {
      id: "quit",
      label: "Quit machdoch",
      icon: LogOut,
      tone: "danger",
      onSelect: quitMachdoch,
    },
  ];

  const selectAction = useCallback(
    (action: TrayMenuAction): void => {
      void (async () => {
        await hideTrayMenu();
        await action.onSelect();
      })().catch((error) => {
        console.error(`Failed to run tray action \`${action.id}\``, error);
      });
    },
    [hideTrayMenu],
  );

  useEffect(() => {
    if (!isTauri()) {
      return;
    }

    const currentWindow = getCurrentWindow();
    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    let hideTimeoutId: number | undefined;

    const refreshMainWindowOpenState = (): void => {
      void isMainWindowOpen()
        .then((isOpen) => {
          if (disposed) {
            return;
          }

          setMainWindowOpen(isOpen);
        })
        .catch((error) => {
          console.error("Failed to refresh tray menu window state", error);
        });
    };

    const clearPendingHide = (): void => {
      if (hideTimeoutId === undefined) {
        return;
      }

      window.clearTimeout(hideTimeoutId);
      hideTimeoutId = undefined;
    };

    refreshMainWindowOpenState();

    void currentWindow
      .onFocusChanged((event) => {
        clearPendingHide();

        if (event.payload) {
          refreshMainWindowOpenState();
          return;
        }

        hideTimeoutId = window.setTimeout(() => {
          hideTimeoutId = undefined;

          if (disposed) {
            return;
          }

          void currentWindow.hide().catch(() => undefined);
        }, TRAY_MENU_BLUR_HIDE_DELAY_MS);
      })
      .then((unlisten) => {
        if (disposed) {
          unlisten();
          return;
        }

        unsubscribe = unlisten;
      })
      .catch((error) => {
        console.error("Failed to subscribe to tray menu focus changes", error);
      });

    return () => {
      disposed = true;
      clearPendingHide();
      unsubscribe?.();
    };
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") {
        return;
      }

      void hideTrayMenu().catch(() => undefined);
    };

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [hideTrayMenu]);

  return (
    <div className="fixed inset-0 overflow-hidden bg-transparent p-1.5">
      <div className="relative flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-slate-700/80 bg-slate-950/98 text-slate-100 shadow-[0_18px_50px_rgba(2,6,23,0.42)] backdrop-blur-xl">
        <span
          aria-hidden="true"
          className="absolute left-4 right-4 top-0 h-px bg-gradient-to-r from-sky-400/0 via-sky-300/80 to-violet-300/0"
        />

        <header className="flex items-center justify-between gap-3 border-b border-slate-800 px-4 py-3">
          <div className="min-w-0 flex items-center gap-3">
            <span
              aria-hidden="true"
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-sky-400/25 bg-sky-400/10 text-sky-100"
            >
              <Sparkles className="h-5 w-5" />
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-white">
                machdoch
              </p>
            </div>
          </div>
        </header>

        <nav className="min-h-0 flex-1 space-y-1 p-2" aria-label="Tray menu">
          {actions.map((action) => (
            <TrayMenuActionButton
              key={action.id}
              action={action}
              onSelect={selectAction}
            />
          ))}
        </nav>
      </div>
    </div>
  );
};
