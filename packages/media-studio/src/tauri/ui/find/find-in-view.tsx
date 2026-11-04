import { isTauri } from "@tauri-apps/api/core";
import * as React from "react";
import { createPortal } from "react-dom";

import {
  detectCommandPlatform,
  useRegisterCommands,
} from "../commands/command-context";
import {
  getDefaultCommandShortcut,
  type DefaultCommandShortcutId,
} from "../commands/command-defaults";
import { commandOverlayStore } from "../commands/command-overlay-store";
import {
  COMMAND_ENABLED,
  COMMAND_HIDDEN,
  type CommandDefinition,
  type CommandFocusKind,
  type ShortcutSpec,
} from "../commands/command-types";
import { eventMatchesShortcut } from "../commands/shortcut";
import { FindBar } from "./find-bar";
import {
  FIND_BAR_ATTRIBUTE,
  clearFindHighlights,
  collectFindText,
  createFindRanges,
  findFirstVisibleRangeIndex,
  findRangeIndexAtOrAfter,
  isFindBarTarget,
  isFindScopeAttached,
  isFindScopeInteractive,
  paintFindHighlights,
  resolveFindScope,
  revealFindRange,
  type FindScope,
  type FindTextIndex,
} from "./find-dom";
import {
  findTextMatches,
  stepFindIndex,
  type FindOptions,
} from "./find-text-matches";

interface FindResult {
  count: number;
  activeIndex: number;
  limited: boolean;
}

const EMPTY_RESULT: FindResult = { count: 0, activeIndex: -1, limited: false };
const MUTATION_SEARCH_DELAY_MS = 400;
const CONTENT_ATTRIBUTES = new Set(["hidden", "open"]);
const FIND_FOCUS: readonly CommandFocusKind[] = [
  "document",
  "text-entry",
  "editor",
  "terminal",
  "interactive-control",
];
const NATIVE_FIND_SHORTCUTS: readonly ShortcutSpec[] = [
  "Mod+F",
  "Mod+G",
  "Mod+Shift+G",
  "F3",
  "Shift+F3",
].map((chord) => ({ chord, allowRepeat: true }));

const findShortcut = (id: DefaultCommandShortcutId): ShortcutSpec => ({
  chord: getDefaultCommandShortcut(id),
  runtimes: ["tauri"],
  allowIn: FIND_FOCUS,
});

const isOwnMutation = (record: MutationRecord): boolean => {
  const target =
    record.target instanceof Element
      ? record.target
      : record.target.parentElement;
  if (isFindBarTarget(target)) return true;
  const changed = [...record.addedNodes, ...record.removedNodes];
  return (
    record.type === "childList" &&
    changed.length > 0 &&
    changed.every(
      (node) =>
        node instanceof Element && node.hasAttribute(FIND_BAR_ATTRIBUTE),
    )
  );
};

const isContentMutation = (record: MutationRecord): boolean =>
  record.type !== "attributes" ||
  CONTENT_ATTRIBUTES.has(record.attributeName ?? "");

const getFocusedElement = (): HTMLElement | null => {
  const active = document.activeElement;
  return active instanceof HTMLElement && active !== document.body
    ? active
    : null;
};

export const FindInView = ({
  activeView,
}: {
  activeView: string | null;
}): React.JSX.Element | null => {
  const [scope, setScope] = React.useState<FindScope | null>(null);
  const [query, setQuery] = React.useState("");
  const [options, setOptions] = React.useState<FindOptions>({
    matchCase: false,
    wholeWord: false,
  });
  const [result, setResult] = React.useState<FindResult>(EMPTY_RESULT);
  const [focusRequest, setFocusRequest] = React.useState(0);
  const overlays = React.useSyncExternalStore(
    commandOverlayStore.subscribe,
    commandOverlayStore.getSnapshot,
    commandOverlayStore.getSnapshot,
  );
  const inputRef = React.useRef<HTMLInputElement>(null);
  const restoreFocusRef = React.useRef<HTMLElement | null>(null);
  const textIndexRef = React.useRef<FindTextIndex | null>(null);
  const rangesRef = React.useRef<Range[]>([]);
  const activeIndexRef = React.useRef(-1);
  const searchRef = React.useRef({ scope, query, options });
  searchRef.current = { scope, query, options };

  const resetMatches = React.useCallback(() => {
    textIndexRef.current = null;
    rangesRef.current = [];
    activeIndexRef.current = -1;
    clearFindHighlights();
    setResult(EMPTY_RESULT);
  }, []);

  const runSearch = React.useCallback(
    (reveal: boolean) => {
      const { scope: current, query: text, options: flags } = searchRef.current;
      if (!current || !text.trim()) {
        resetMatches();
        return;
      }
      const anchor = rangesRef.current[activeIndexRef.current];
      const index = textIndexRef.current ?? collectFindText(current.element);
      textIndexRef.current = index;
      const { matches, limited } = findTextMatches(index.text, text, flags);
      const ranges = createFindRanges(index, matches);
      const activeIndex =
        ranges.length === 0
          ? -1
          : anchor
            ? findRangeIndexAtOrAfter(ranges, anchor)
            : findFirstVisibleRangeIndex(ranges, current.element);
      const activeRange = ranges[activeIndex] ?? null;
      rangesRef.current = ranges;
      activeIndexRef.current = activeIndex;
      paintFindHighlights(ranges, activeRange);
      setResult({ count: ranges.length, activeIndex, limited });
      if (reveal && activeRange) revealFindRange(activeRange, current.element);
    },
    [resetMatches],
  );

  const move = React.useCallback((direction: 1 | -1) => {
    const current = searchRef.current.scope;
    const ranges = rangesRef.current;
    if (!current || ranges.length === 0) return;
    const activeIndex = stepFindIndex(
      activeIndexRef.current,
      ranges.length,
      direction,
    );
    const activeRange = ranges[activeIndex]!;
    activeIndexRef.current = activeIndex;
    paintFindHighlights(ranges, activeRange);
    setResult((previous) => ({ ...previous, activeIndex }));
    revealFindRange(activeRange, current.element);
  }, []);

  const open = React.useCallback(() => {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        const focused = getFocusedElement();
        const next = resolveFindScope(focused);
        if (!next) return;
        if (!isFindBarTarget(focused)) restoreFocusRef.current = focused;
        setScope((current) =>
          current?.element === next.element ? current : next,
        );
        setFocusRequest((request) => request + 1);
      });
    });
  }, []);

  const close = React.useCallback(
    (restoreFocus: boolean) => {
      const target = restoreFocusRef.current;
      restoreFocusRef.current = null;
      resetMatches();
      setScope(null);
      if (restoreFocus && target?.isConnected) {
        target.focus({ preventScroll: true });
      }
    },
    [resetMatches],
  );

  const scopeElement = scope?.element;
  React.useEffect(() => {
    textIndexRef.current = null;
    rangesRef.current = [];
    activeIndexRef.current = -1;
  }, [scopeElement]);

  React.useEffect(() => {
    if (scope) runSearch(true);
  }, [scope, query, options, runSearch]);

  React.useEffect(() => {
    if (!scopeElement) return;
    let timer: number | null = null;
    const observer = new MutationObserver((records) => {
      const external = records.filter((record) => !isOwnMutation(record));
      if (external.length === 0) return;
      textIndexRef.current = null;
      if (timer !== null || !external.some(isContentMutation)) return;
      timer = window.setTimeout(() => {
        timer = null;
        runSearch(false);
      }, MUTATION_SEARCH_DELAY_MS);
    });
    observer.observe(scopeElement, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    });
    return () => {
      observer.disconnect();
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [scopeElement, runSearch]);

  React.useEffect(() => {
    if (scope && !isFindScopeAttached(scope)) close(false);
  }, [activeView, overlays, scope, close]);

  React.useEffect(() => {
    if (focusRequest === 0) return;
    inputRef.current?.focus({ preventScroll: true });
    inputRef.current?.select();
  }, [focusRequest]);

  React.useEffect(() => {
    if (!isTauri()) return;
    const platform = detectCommandPlatform();
    const suppressNativeFind = (event: KeyboardEvent): void => {
      if (
        !event.defaultPrevented &&
        NATIVE_FIND_SHORTCUTS.some((spec) =>
          eventMatchesShortcut(event, spec, platform, "tauri"),
        )
      ) {
        event.preventDefault();
      }
    };
    window.addEventListener("keydown", suppressNativeFind);
    return () => window.removeEventListener("keydown", suppressNativeFind);
  }, []);

  React.useEffect(() => clearFindHighlights, []);

  const commands = React.useMemo<readonly CommandDefinition[]>(() => {
    const commandScope = { kind: "global", ownerId: "app" } as const;
    const navigationAvailability = () => {
      const current = searchRef.current.scope;
      return current &&
        rangesRef.current.length > 0 &&
        isFindScopeInteractive(current)
        ? COMMAND_ENABLED
        : COMMAND_HIDDEN;
    };
    return [
      {
        id: "app.find.open",
        title: "Find in view",
        group: "Navigation",
        keywords: ["search", "find in page"],
        scope: commandScope,
        shortcuts: [findShortcut("app.find.open")],
        palette: "visible",
        overlayPolicy: "contextual",
        execute: open,
      },
      {
        id: "app.find.next",
        title: "Find next match",
        group: "Navigation",
        scope: commandScope,
        shortcuts: [
          findShortcut("app.find.next"),
          findShortcut("app.find.next-alternate"),
        ],
        palette: "hidden",
        overlayPolicy: "contextual",
        availability: navigationAvailability,
        execute: () => move(1),
      },
      {
        id: "app.find.previous",
        title: "Find previous match",
        group: "Navigation",
        scope: commandScope,
        shortcuts: [
          findShortcut("app.find.previous"),
          findShortcut("app.find.previous-alternate"),
        ],
        palette: "hidden",
        overlayPolicy: "contextual",
        availability: navigationAvailability,
        execute: () => move(-1),
      },
    ];
  }, [move, open]);
  useRegisterCommands(commands);

  if (!scope) return null;
  return createPortal(
    <FindBar
      inputRef={inputRef}
      scopeElement={scope.element}
      label={scope.label}
      query={query}
      options={options}
      count={result.count}
      activeIndex={result.activeIndex}
      limited={result.limited}
      onQueryChange={setQuery}
      onOptionsChange={setOptions}
      onMove={move}
      onClose={() => close(true)}
    />,
    scope.element,
  );
};
