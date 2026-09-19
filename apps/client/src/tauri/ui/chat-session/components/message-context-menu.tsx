import {
  Code,
  Copy,
  Download,
  Image,
  Save,
  Text,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type JSX } from "react";
import type { ChatSessionMessage } from "../../chat-session.model";
import { useCommandOverlay } from "../../commands/use-command-overlay";
import {
  copyMessageImage,
  copyMessageText,
  createMessageMarkdownFileName,
  getMessagePlainText,
  saveMessageMarkdown,
} from "../_helpers/message-export";

export interface MessageContextMenuTarget {
  message: ChatSessionMessage;
  content: string;
  bubble: HTMLElement;
  canSaveAsContextPack: boolean;
  left: number;
  top: number;
}

interface MessageContextMenuProps {
  target: MessageContextMenuTarget;
  onClose: () => void;
  onSaveAsContextPack?: (message: ChatSessionMessage) => void;
}

interface MessageAction {
  label: string;
  icon: LucideIcon;
  execute: () => void | Promise<void>;
}

export const MessageContextMenu = ({
  target,
  onClose,
  onSaveAsContextPack,
}: MessageContextMenuProps): JSX.Element => {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({
    left: target.left,
    top: target.top,
  });
  const [selection] = useState(() => {
    const selected = window.getSelection();
    return selected &&
      target.bubble.contains(selected.anchorNode) &&
      target.bubble.contains(selected.focusNode)
      ? selected.toString()
      : "";
  });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useCommandOverlay({
    open: true,
    id: "message-context-menu",
    kind: "non-modal",
    dismiss: onClose,
  });

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const bounds = menu.getBoundingClientRect();
    setPosition({
      left: Math.max(
        8,
        Math.min(target.left, window.innerWidth - bounds.width - 8),
      ),
      top: Math.max(
        8,
        Math.min(target.top, window.innerHeight - bounds.height - 8),
      ),
    });
  }, [target, error]);

  useEffect(() => {
    menuRef.current
      ?.querySelector<HTMLButtonElement>("[role='menuitem']")
      ?.focus({ preventScroll: true });
    const dismissOnScroll = (event: Event): void => {
      if (
        event.target instanceof Node &&
        menuRef.current?.contains(event.target)
      )
        return;
      onClose();
    };
    const dismissOnEscape = (event: KeyboardEvent): void => {
      if (!event.defaultPrevented && event.key === "Escape") onClose();
    };
    document.addEventListener("pointerdown", onClose);
    document.addEventListener("keydown", dismissOnEscape);
    window.addEventListener("resize", onClose);
    window.addEventListener("scroll", dismissOnScroll, true);
    return () => {
      document.removeEventListener("pointerdown", onClose);
      document.removeEventListener("keydown", dismissOnEscape);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("scroll", dismissOnScroll, true);
    };
  }, [onClose]);

  const actions: MessageAction[] = [
    ...(selection
      ? [
          {
            label: "Copy selection",
            icon: Copy,
            execute: () => copyMessageText(selection),
          },
        ]
      : []),
    ...(target.canSaveAsContextPack && onSaveAsContextPack
      ? [
          {
            label: "Save as pack",
            icon: Save,
            execute: () => onSaveAsContextPack(target.message),
          },
        ]
      : []),
    ...(target.content.length > 0 || target.message.content.length > 0
      ? [
          {
            label: "Copy Markdown",
            icon: Copy,
            execute: () => copyMessageText(target.content),
          },
          {
            label: "Copy as text",
            icon: Text,
            execute: () => copyMessageText(getMessagePlainText(target.bubble)),
          },
          {
            label: "Copy as raw text",
            icon: Code,
            execute: () => copyMessageText(target.message.content),
          },
          {
            label: "Copy as image",
            icon: Image,
            execute: () => copyMessageImage(target.bubble),
          },
          {
            label: "Save Markdown",
            icon: Download,
            execute: () =>
              saveMessageMarkdown(
                target.content,
                createMessageMarkdownFileName(target.message),
              ),
          },
        ]
      : []),
  ];

  const executeAction = async (action: MessageAction): Promise<void> => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await action.execute();
      if (menuRef.current) onClose();
    } catch (failure) {
      setError(
        failure instanceof Error && failure.name !== "NotAllowedError"
          ? failure.message
          : "The action was blocked. Check clipboard access and try again.",
      );
    } finally {
      setPending(false);
    }
  };

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label="Message actions"
      aria-busy={pending}
      className="app-message-context-menu fixed z-[140] w-[196px] max-h-[calc(100dvh-16px)] max-w-[calc(100vw-16px)] overflow-y-auto app-menu-surface"
      style={position}
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onKeyDown={(event) => {
        if (event.key === "Tab") {
          onClose();
          return;
        }
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key))
          return;
        event.preventDefault();
        const items = Array.from(
          event.currentTarget.querySelectorAll<HTMLButtonElement>(
            "[role='menuitem']:not(:disabled)",
          ),
        );
        const current = items.findIndex(
          (item) => item === document.activeElement,
        );
        const next =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? items.length - 1
              : (current +
                  (event.key === "ArrowDown" ? 1 : -1) +
                  items.length) %
                items.length;
        items[next]?.focus();
      }}
    >
      <div className="app-menu-label min-w-0">
        <span className="block truncate">
          {target.message.role === "agent" ? "Assistant" : "User"} message
        </span>
      </div>
      {actions.map((action) => (
        <button
          key={action.label}
          type="button"
          role="menuitem"
          disabled={pending}
          onClick={() => void executeAction(action)}
          className="app-menu-item w-full"
        >
          <action.icon
            aria-hidden="true"
            className="h-3.5 w-3.5 shrink-0 text-sky-300"
          />
          <span className="min-w-0 flex-1 truncate">{action.label}</span>
        </button>
      ))}
      {error ? (
        <p role="alert" className="px-2 py-1 text-xs text-rose-300">
          {error}
        </p>
      ) : null}
    </div>
  );
};
