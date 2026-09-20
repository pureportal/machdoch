import type { CommandFocusKind, CommandFocusSnapshot } from "./command-types";

const EXPLICIT_KINDS = new Set<CommandFocusKind>([
  "document",
  "text-entry",
  "editor",
  "terminal",
  "interactive-control",
  "command-surface",
]);

const getElement = (value: unknown): Element | null =>
  typeof Element !== "undefined" && value instanceof Element ? value : null;

const isTextEntry = (element: Element): boolean => {
  if (
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement
  ) {
    return true;
  }
  if (element instanceof HTMLInputElement) {
    const type = element.type.toLocaleLowerCase("en-US");
    return !new Set([
      "button",
      "checkbox",
      "color",
      "file",
      "hidden",
      "image",
      "radio",
      "range",
      "reset",
      "submit",
    ]).has(type);
  }
  return false;
};

const isInteractive = (element: Element): boolean =>
  element.matches(
    "button, a[href], input, select, textarea, summary, [role='button'], [role='checkbox'], [role='combobox'], [role='gridcell'], [role='link'], [role='listbox'], [role='menuitem'], [role='option'], [role='radio'], [role='slider'], [role='switch'], [role='tab'], [role='treeitem']",
  );

export const getEventPath = (event: Event): readonly EventTarget[] => {
  const composed = event.composedPath?.();
  if (composed && composed.length > 0) return composed;
  return event.target ? [event.target] : [];
};

export const classifyFocusPath = (
  path: readonly unknown[],
): CommandFocusSnapshot => {
  const elements = path
    .map(getElement)
    .filter((item): item is Element => item !== null);
  const ownerPath = elements
    .map((element) => element.getAttribute("data-command-owner"))
    .filter((owner): owner is string => Boolean(owner));

  for (const element of elements) {
    const explicit = (element.getAttribute("data-command-focus") ??
      element.getAttribute("data-command-boundary")) as CommandFocusKind | null;
    if (explicit && EXPLICIT_KINDS.has(explicit)) {
      return { kind: explicit, ownerPath };
    }
    if (
      element.matches(
        ".cm-editor, .cm-content, .monaco-editor, [contenteditable]:not([contenteditable='false'])",
      )
    ) {
      return { kind: "editor", ownerPath };
    }
    if (element.matches(".xterm, .xterm-helper-textarea")) {
      return { kind: "terminal", ownerPath };
    }
  }

  if (elements.some(isTextEntry)) return { kind: "text-entry", ownerPath };
  if (elements.some(isInteractive))
    return { kind: "interactive-control", ownerPath };
  return { kind: "document", ownerPath };
};

export const getFocusSnapshot = (event: Event): CommandFocusSnapshot =>
  classifyFocusPath(getEventPath(event));

const getComposedParent = (element: Element): Element | null => {
  if (element.assignedSlot) return element.assignedSlot;
  if (element.parentElement) return element.parentElement;
  const root = element.getRootNode();
  return typeof ShadowRoot !== "undefined" && root instanceof ShadowRoot
    ? root.host
    : null;
};

export const getElementFocusSnapshot = (
  element: Element,
): CommandFocusSnapshot => {
  const path: Element[] = [];
  let current: Element | null = element;
  while (current) {
    path.push(current);
    current = getComposedParent(current);
  }
  return classifyFocusPath(path);
};

export const getActiveFocusSnapshot = (): CommandFocusSnapshot => {
  let active = document.activeElement;
  while (active?.shadowRoot?.activeElement) {
    active = active.shadowRoot.activeElement;
  }
  return active
    ? getElementFocusSnapshot(active)
    : { kind: "document", ownerPath: [] };
};
