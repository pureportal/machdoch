import {
  findFirstIndex,
  locateFindSpan,
  type FindTextSpan,
} from "./find-text-matches";

const FIND_SCOPE_ATTRIBUTE = "data-find-scope";
export const FIND_BAR_ATTRIBUTE = "data-find-bar";

export interface FindScope {
  element: HTMLElement;
  label: string;
}

interface FindTextSegment extends FindTextSpan {
  node: Text;
}

export interface FindTextIndex {
  text: string;
  segments: readonly FindTextSegment[];
}

interface ElementTextInfo {
  block: Element;
  visible: boolean;
}

const OPEN_DIALOG_SELECTOR = '[data-slot="dialog-content"][data-state="open"]';
const SCOPE_SELECTOR = `[${FIND_SCOPE_ATTRIBUTE}]`;
const IGNORED_SELECTOR = [
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "canvas",
  "input",
  "textarea",
  "select",
  ".sr-only",
  ".cm-editor",
  ".monaco-editor",
  ".xterm",
  `[${FIND_BAR_ATTRIBUTE}]`,
].join(", ");
const BLOCK_SEPARATOR = "\u0000";
const MATCH_HIGHLIGHT = "app-find-match";
const ACTIVE_HIGHLIGHT = "app-find-active";
const REVEAL_MARGIN_PX = 56;
const FIND_BAR_OBSTACLE_SELECTOR = "header, nav";
const FIND_BAR_EDGE_PX = 12;
const FIND_BAR_GAP_PX = 8;
const PINNED_BAR_MAX_OFFSET_PX = 24;

export const isFindBarTarget = (target: EventTarget | null): boolean =>
  target instanceof Element &&
  target.closest(`[${FIND_BAR_ATTRIBUTE}]`) !== null;

const getTopOpenDialog = (): HTMLElement | null => {
  const dialogs = document.querySelectorAll<HTMLElement>(OPEN_DIALOG_SELECTOR);
  return dialogs[dialogs.length - 1] ?? null;
};

const getDialogLabel = (dialog: HTMLElement): string => {
  const titleId = dialog.getAttribute("aria-labelledby");
  const title = titleId
    ? document.getElementById(titleId)?.textContent?.trim()
    : undefined;
  return title || dialog.getAttribute("aria-label")?.trim() || "dialog";
};

const toViewScope = (element: HTMLElement): FindScope => ({
  element,
  label: element.getAttribute(FIND_SCOPE_ATTRIBUTE) || "view",
});

export const resolveFindScope = (
  contextElement: Element | null,
): FindScope | null => {
  const dialog = getTopOpenDialog();
  const contextScope = contextElement?.closest<HTMLElement>(SCOPE_SELECTOR);
  if (
    contextScope &&
    (!dialog || dialog.contains(contextScope)) &&
    contextScope.checkVisibility()
  ) {
    return toViewScope(contextScope);
  }
  const root: ParentNode = dialog ?? document;
  const viewScope = Array.from(
    root.querySelectorAll<HTMLElement>(SCOPE_SELECTOR),
  ).find((element) => element.checkVisibility());
  if (viewScope) return toViewScope(viewScope);
  return dialog ? { element: dialog, label: getDialogLabel(dialog) } : null;
};

export const isFindScopeAttached = (scope: FindScope): boolean =>
  scope.element.isConnected &&
  scope.element.getAttribute("data-state") !== "closed";

export const isFindScopeInteractive = (scope: FindScope): boolean => {
  if (!isFindScopeAttached(scope)) return false;
  const dialog = getTopOpenDialog();
  return !dialog || dialog.contains(scope.element);
};

const isPinnedInScope = (element: Element, scope: HTMLElement): boolean => {
  for (
    let node: Element | null = element;
    node && node !== scope;
    node = node.parentElement
  ) {
    const style = getComputedStyle(node);
    if (style.position === "sticky") return true;
    if (
      node !== element &&
      (style.overflowY === "auto" || style.overflowY === "scroll")
    ) {
      return false;
    }
  }
  return true;
};

export const getFindBarTop = (bar: HTMLElement, scope: HTMLElement): number => {
  const scopeTop = scope.getBoundingClientRect().top;
  const barRect = bar.getBoundingClientRect();
  let top = FIND_BAR_EDGE_PX;
  for (const element of scope.querySelectorAll(FIND_BAR_OBSTACLE_SELECTOR)) {
    const rect = element.getBoundingClientRect();
    if (
      rect.width <= rect.height ||
      rect.top - scopeTop > PINNED_BAR_MAX_OFFSET_PX ||
      rect.right <= barRect.left ||
      rect.left >= barRect.right ||
      !isPinnedInScope(element, scope)
    ) {
      continue;
    }
    top = Math.max(top, rect.bottom - scopeTop + FIND_BAR_GAP_PX);
  }
  return top;
};

const isCollapsedDetailsContent = (node: Node): boolean => {
  const parent = node.parentElement;
  return (
    parent instanceof HTMLDetailsElement &&
    !parent.open &&
    !(node instanceof HTMLElement && node.tagName === "SUMMARY")
  );
};

export const collectFindText = (scope: HTMLElement): FindTextIndex => {
  const infos = new Map<Element, ElementTextInfo>([
    [
      scope,
      {
        block: scope,
        visible: getComputedStyle(scope).visibility === "visible",
      },
    ],
  ]);
  const walker = document.createTreeWalker(
    scope,
    NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
    {
      acceptNode: (node) => {
        if (isCollapsedDetailsContent(node)) return NodeFilter.FILTER_REJECT;
        if (!(node instanceof Element)) return NodeFilter.FILTER_ACCEPT;
        if (node.matches(IGNORED_SELECTOR)) return NodeFilter.FILTER_REJECT;
        const style = getComputedStyle(node);
        if (style.display === "none" || style.contentVisibility === "hidden") {
          return NodeFilter.FILTER_REJECT;
        }
        const parentInfo = node.parentElement
          ? infos.get(node.parentElement)
          : undefined;
        const continuesLine =
          style.display === "inline" || style.display === "contents";
        infos.set(node, {
          block: continuesLine && parentInfo ? parentInfo.block : node,
          visible: style.visibility === "visible",
        });
        return NodeFilter.FILTER_ACCEPT;
      },
    },
  );
  const parts: string[] = [];
  const segments: FindTextSegment[] = [];
  let length = 0;
  let previousBlock: Element | null = null;
  const append = (value: string): void => {
    parts.push(value);
    length += value.length;
  };

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node instanceof HTMLBRElement) {
      append("\n");
      continue;
    }
    if (!(node instanceof Text) || node.data.length === 0) continue;
    const info = node.parentElement ? infos.get(node.parentElement) : undefined;
    if (!info?.visible) continue;
    if (previousBlock && previousBlock !== info.block) append(BLOCK_SEPARATOR);
    previousBlock = info.block;
    segments.push({ node, start: length, end: length + node.data.length });
    append(node.data);
  }

  return { text: parts.join(""), segments };
};

export const createFindRanges = (
  index: FindTextIndex,
  matches: readonly FindTextSpan[],
): Range[] =>
  matches.flatMap((match) => {
    const located = locateFindSpan(index.segments, match);
    if (!located) return [];
    const range = document.createRange();
    range.setStart(
      index.segments[located.start.segmentIndex]!.node,
      located.start.offset,
    );
    range.setEnd(
      index.segments[located.end.segmentIndex]!.node,
      located.end.offset,
    );
    return [range];
  });

const getVisibleBounds = (element: Element, scope: HTMLElement): DOMRect => {
  const scopeRect = scope.getBoundingClientRect();
  let top = scopeRect.top;
  let right = scopeRect.right;
  let bottom = scopeRect.bottom;
  let left = scopeRect.left;
  for (
    let ancestor = element.parentElement;
    ancestor && ancestor !== scope && scope.contains(ancestor);
    ancestor = ancestor.parentElement
  ) {
    const style = getComputedStyle(ancestor);
    if (style.overflowX === "visible" && style.overflowY === "visible") {
      continue;
    }
    const rect = ancestor.getBoundingClientRect();
    top = Math.max(top, rect.top);
    right = Math.min(right, rect.right);
    bottom = Math.min(bottom, rect.bottom);
    left = Math.max(left, rect.left);
  }
  return new DOMRect(left, top, right - left, bottom - top);
};

const isRangeComfortablyVisible = (
  range: Range,
  scope: HTMLElement,
): boolean => {
  const target = range.startContainer.parentElement;
  if (!target) return false;
  const rect = range.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return false;
  const bounds = getVisibleBounds(target, scope);
  return (
    rect.top >= bounds.top + REVEAL_MARGIN_PX &&
    rect.bottom <= bounds.bottom - REVEAL_MARGIN_PX / 2 &&
    rect.left >= bounds.left &&
    rect.right <= bounds.right
  );
};

export const revealFindRange = (range: Range, scope: HTMLElement): void => {
  const target = range.startContainer.parentElement;
  if (!target || isRangeComfortablyVisible(range, scope)) return;
  target.scrollIntoView({ block: "center", inline: "nearest" });
  window.requestAnimationFrame(() => {
    if (!range.collapsed && !isRangeComfortablyVisible(range, scope)) {
      target.scrollIntoView({ block: "center", inline: "nearest" });
    }
  });
};

export const findFirstVisibleRangeIndex = (
  ranges: readonly Range[],
  scope: HTMLElement,
): number => {
  const top = scope.getBoundingClientRect().top;
  const index = findFirstIndex(
    ranges.length,
    (candidate) => ranges[candidate]!.getBoundingClientRect().bottom >= top,
  );
  return index === ranges.length ? 0 : index;
};

export const findRangeIndexAtOrAfter = (
  ranges: readonly Range[],
  anchor: Range,
): number => {
  const index = findFirstIndex(
    ranges.length,
    (candidate) =>
      ranges[candidate]!.compareBoundaryPoints(Range.START_TO_START, anchor) >=
      0,
  );
  return index === ranges.length ? 0 : index;
};

export const paintFindHighlights = (
  ranges: readonly Range[],
  activeRange: Range | null,
): void => {
  CSS.highlights.set(MATCH_HIGHLIGHT, new Highlight(...ranges));
  if (!activeRange) {
    CSS.highlights.delete(ACTIVE_HIGHLIGHT);
    return;
  }
  const active = new Highlight(activeRange);
  active.priority = 1;
  CSS.highlights.set(ACTIVE_HIGHLIGHT, active);
};

export const clearFindHighlights = (): void => {
  CSS.highlights.delete(MATCH_HIGHLIGHT);
  CSS.highlights.delete(ACTIVE_HIGHLIGHT);
};
