import { LoaderCircle, Sparkles } from "lucide-react";
import type { JSX } from "react";
import { ControlTooltip } from "@machdoch/media-studio/tauri/ui/components/ui/tooltip.js";
import { useCommandShortcut } from "@machdoch/media-studio/tauri/ui/commands/command-context.js";
import { cn } from "@machdoch/media-studio/tauri/ui/lib/utils.js";

export interface QuickChatButtonProps {
  open: boolean;
  running: boolean;
  unread: boolean;
  onToggle: () => void;
}

export const QuickChatButton = ({
  open,
  running,
  unread,
  onToggle,
}: QuickChatButtonProps): JSX.Element => {
  const shortcut = useCommandShortcut("app.quick-chat.toggle");
  const label = running
    ? "Quick Chat, working"
    : unread
      ? "Quick Chat, new reply"
      : "Quick Chat";
  return (
    <ControlTooltip
      content={shortcut ? `Quick Chat (${shortcut.label})` : "Quick Chat"}
      side="bottom"
    >
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-keyshortcuts={shortcut?.ariaKeyShortcuts}
        onClick={onToggle}
        className={cn(
          "pointer-events-auto relative inline-flex h-7 items-center gap-1.5 rounded-lg px-2 text-xs font-medium transition-colors",
          open
            ? "bg-sky-500/15 text-sky-100 ring-1 ring-sky-400/30"
            : "text-slate-300 hover:bg-slate-800 hover:text-slate-100",
        )}
        data-tauri-no-drag
      >
        {running ? (
          <LoaderCircle
            aria-hidden="true"
            className="size-3.5 animate-spin text-sky-300"
          />
        ) : (
          <Sparkles aria-hidden="true" className="size-3.5 text-sky-400" />
        )}
        <span className="hidden sm:inline">Quick Chat</span>
        {unread && !running ? (
          <span
            aria-hidden="true"
            className="absolute top-1 right-1 size-1.5 rounded-full bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.7)]"
          />
        ) : null}
      </button>
    </ControlTooltip>
  );
};
