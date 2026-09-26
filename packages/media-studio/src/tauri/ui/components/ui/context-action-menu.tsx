import { Check, Copy, X, type LucideIcon } from "lucide-react";
import { ContextMenu } from "radix-ui";
import { createPortal } from "react-dom";
import {
  useId,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
} from "react";
import { useCommandOverlay } from "../../commands/use-command-overlay";
import { copyText } from "../../lib/clipboard";

export interface ContextMenuAction {
  label: string;
  icon?: LucideIcon;
  checked?: boolean;
  disabled?: boolean;
  destructive?: boolean;
  onSelect: () => void | Promise<void>;
}

export const openContextMenuFromButton = (
  event: ReactMouseEvent<HTMLElement>,
): void => {
  const bounds = event.currentTarget.getBoundingClientRect();
  event.currentTarget.closest("[data-app-context-menu-trigger]")?.dispatchEvent(
    new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      button: 2,
      clientX: bounds.left,
      clientY: bounds.bottom,
    }),
  );
};

export const ContextActionMenu = ({
  children,
  actions,
  label,
  selectable = false,
  preserveEditing = true,
}: {
  children: ReactElement;
  actions: readonly ContextMenuAction[] | (() => readonly ContextMenuAction[]);
  label: string;
  selectable?: boolean;
  preserveEditing?: boolean;
}) => {
  const id = useId();
  const triggerRef = useRef<HTMLSpanElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const focusTargetRef = useRef<HTMLElement | null>(null);
  const outsideInteractionRef = useRef(false);
  const operationRef = useRef(0);
  const [open, setOpen] = useState(false);
  const [menuActions, setMenuActions] = useState<readonly ContextMenuAction[]>(
    [],
  );
  const [error, setError] = useState<string | null>(null);
  useCommandOverlay({
    open,
    id: `context-menu:${id}`,
    kind: "non-modal",
    dismiss: () => {
      menuRef.current?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    },
  });

  const execute = async (action: ContextMenuAction) => {
    const operation = ++operationRef.current;
    setError(null);
    try {
      await action.onSelect();
    } catch (failure) {
      if (operation === operationRef.current) {
        setError(
          failure instanceof Error
            ? failure.message
            : "Action failed. Try again.",
        );
      }
    }
  };

  return (
    <>
      <ContextMenu.Root
        modal={false}
        onOpenChange={(nextOpen) => {
          setOpen(nextOpen);
          if (!nextOpen) return;
          operationRef.current += 1;
          setError(null);
          outsideInteractionRef.current = false;
          const trigger = triggerRef.current;
          focusTargetRef.current =
            document.activeElement instanceof HTMLElement &&
            trigger?.contains(document.activeElement)
              ? document.activeElement
              : (trigger?.querySelector<HTMLElement>(
                  "button:not(:disabled), [tabindex='0']",
                ) ?? trigger);
          const selection = window.getSelection();
          const selectedText =
            selectable &&
            selection &&
            trigger?.contains(selection.anchorNode) &&
            trigger.contains(selection.focusNode)
              ? selection.toString()
              : "";
          setMenuActions([
            ...(selectedText
              ? [
                  {
                    label: "Copy selection",
                    icon: Copy,
                    onSelect: () => copyText(selectedText),
                  },
                ]
              : []),
            ...(typeof actions === "function" ? actions() : actions),
          ]);
        }}
      >
        <ContextMenu.Trigger
          asChild
          ref={triggerRef}
          data-app-context-menu-trigger
          aria-haspopup="menu"
          className={selectable ? "app-copyable" : undefined}
          tabIndex={0}
          onContextMenuCapture={(event) => {
            if (
              preserveEditing &&
              event.target instanceof Element &&
              event.target.closest(
                'input, textarea, [contenteditable]:not([contenteditable="false"])',
              )
            ) {
              event.stopPropagation();
            }
          }}
          onContextMenu={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            if (
              event.key !== "ContextMenu" &&
              !(event.shiftKey && event.key === "F10")
            )
              return;
            if (
              preserveEditing &&
              event.target instanceof Element &&
              event.target.closest(
                'input, textarea, [contenteditable]:not([contenteditable="false"])',
              )
            )
              return;
            event.preventDefault();
            event.stopPropagation();
            const bounds =
              event.target instanceof HTMLElement
                ? event.target.getBoundingClientRect()
                : event.currentTarget.getBoundingClientRect();
            event.currentTarget.dispatchEvent(
              new MouseEvent("contextmenu", {
                bubbles: true,
                cancelable: true,
                clientX: bounds.left,
                clientY: bounds.bottom,
                button: 2,
              }),
            );
          }}
        >
          {children}
        </ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Content
            ref={menuRef}
            className="app-menu-surface z-[150] min-w-44 max-h-(--radix-context-menu-content-available-height) overflow-y-auto"
            collisionPadding={8}
            aria-label={label}
            onInteractOutside={() => {
              outsideInteractionRef.current = true;
            }}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              if (
                !outsideInteractionRef.current &&
                (document.activeElement === document.body ||
                  menuRef.current?.contains(document.activeElement))
              )
                focusTargetRef.current?.focus({ preventScroll: true });
            }}
          >
            {menuActions.map((action) =>
              action.checked === undefined ? (
                <ContextMenu.Item
                  key={action.label}
                  className="app-menu-item"
                  disabled={action.disabled}
                  data-variant={action.destructive ? "destructive" : undefined}
                  onSelect={() => {
                    void execute(action);
                  }}
                >
                  {action.icon ? <action.icon aria-hidden="true" /> : null}
                  {action.label}
                </ContextMenu.Item>
              ) : (
                <ContextMenu.CheckboxItem
                  key={action.label}
                  className="app-menu-item"
                  checked={action.checked}
                  disabled={action.disabled}
                  onCheckedChange={() => {
                    void execute(action);
                  }}
                >
                  <ContextMenu.ItemIndicator>
                    <Check aria-hidden="true" />
                  </ContextMenu.ItemIndicator>
                  {action.label}
                </ContextMenu.CheckboxItem>
              ),
            )}
          </ContextMenu.Content>
        </ContextMenu.Portal>
      </ContextMenu.Root>
      {error
        ? createPortal(
            <div
              role="alert"
              className="app-menu-surface fixed bottom-4 right-4 z-[160] flex max-w-80 items-center gap-3 p-3 text-xs"
            >
              <span>{error}</span>
              <button
                type="button"
                aria-label="Dismiss menu error"
                onClick={() => setError(null)}
              >
                <X className="size-4" />
              </button>
            </div>,
            document.body,
          )
        : null}
    </>
  );
};
