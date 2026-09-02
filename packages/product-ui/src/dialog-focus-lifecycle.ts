import { useEffect, type RefObject } from "react";

export function useDialogFocusLifecycle(
  open: boolean,
  onClose: () => void,
  initialFocusRef: RefObject<HTMLElement | null>,
): void {
  useEffect(() => {
    if (!open) return;

    const previouslyFocused = document.activeElement;
    initialFocusRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      if (
        previouslyFocused instanceof HTMLElement &&
        previouslyFocused.isConnected
      ) {
        previouslyFocused.focus();
      }
    };
  }, [initialFocusRef, onClose, open]);
}
