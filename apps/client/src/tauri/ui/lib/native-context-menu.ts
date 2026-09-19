export const preserveNativeContextMenu = (
  target: EventTarget | null,
): boolean => {
  if (!(target instanceof Element)) return false;
  if (
    target.closest(
      '[data-app-context-menu-trigger], input, textarea, [contenteditable]:not([contenteditable="false"])',
    )
  )
    return true;
  const selection = window.getSelection();
  return Boolean(
    selection &&
    !selection.isCollapsed &&
    selection.rangeCount > 0 &&
    selection.getRangeAt(0).intersectsNode(target),
  );
};
