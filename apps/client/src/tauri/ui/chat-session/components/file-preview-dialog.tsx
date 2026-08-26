import {
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  ExternalLink,
  FileText,
  Loader2,
  Regex,
  Search,
  TriangleAlert,
} from "lucide-react";
import {
  memo,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import {
  FILE_PREVIEW_SYNTAX_OPTIONS,
  getFilePreviewVisualKind,
  type FilePreviewLanguage,
  type FilePreviewSyntax,
  type FilePreviewVisualKind,
} from "../_helpers/file-preview-language";
import { highlightFilePreviewContent } from "../_helpers/file-preview-highlight";
import {
  addSearchMatchesToHighlightedHtml,
  findFilePreviewMatches,
} from "../_helpers/file-preview-search";
import {
  getFilePreviewTargetLineIndex,
  scrollFilePreviewTargetLineIntoView,
} from "../_helpers/file-preview-target-line";
import { MarkdownContent } from "../../components/markdown-content";
import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { ControlTooltip } from "../../components/ui/tooltip";
import { useOptionalRegisterCommands } from "../../commands/command-context";
import { getDefaultCommandShortcut } from "../../commands/command-defaults";
import {
  asPaletteCommands,
  type CommandDefinition,
  type CommandPageItem,
} from "../../commands/command-types";
import { cn } from "../../lib/utils";

export type FilePreviewMode = "image" | "pdf" | "text";

export interface FilePreview {
  title: string;
  path: string;
  mode: FilePreviewMode;
  loading: boolean;
  error: string | null;
  source: string | null;
  content: string | null;
  language: FilePreviewLanguage | null;
  languageLabel: string;
  truncated: boolean;
  lossy: boolean;
  targetLine: number | null;
}

export interface FilePreviewDialogProps {
  preview: FilePreview | null;
  onOpenChange: (open: boolean) => void;
  onOpenExternal: () => void;
}

type FilePreviewCopyState = "idle" | "copied" | "failed";
type FilePreviewViewMode = "text" | "visual";

interface FilePreviewSelectionPosition {
  left: number;
  top: number;
}

interface NativeFilePreviewSelection {
  kind: "native";
  text: string;
  position: FilePreviewSelectionPosition;
}

interface LineFilePreviewSelection {
  kind: "lines";
  text: string;
  startLineIndex: number;
  endLineIndex: number;
  position: FilePreviewSelectionPosition;
}

type FilePreviewSelection =
  | NativeFilePreviewSelection
  | LineFilePreviewSelection;

const FILE_PREVIEW_GUTTER_WIDTH = 40;
const FILE_PREVIEW_LINE_HEIGHT = 20;
const FILE_PREVIEW_VERTICAL_PADDING = 16;
const FILE_PREVIEW_COPY_BUTTON_HEIGHT = 28;

const getLineSelectionText = (
  lines: readonly string[],
  startLineIndex: number,
  endLineIndex: number,
): string => lines.slice(startLineIndex, endLineIndex + 1).join("\n");

const getLineSelectionPosition = (
  endpointLineIndex: number,
): FilePreviewSelectionPosition => {
  const selectionTop =
    FILE_PREVIEW_VERTICAL_PADDING +
    endpointLineIndex * FILE_PREVIEW_LINE_HEIGHT;
  const topAboveSelection = selectionTop - FILE_PREVIEW_COPY_BUTTON_HEIGHT - 4;

  return {
    left: FILE_PREVIEW_GUTTER_WIDTH + 8,
    top: Math.max(4, topAboveSelection),
  };
};

const getRangeRectangles = (range: Range): readonly DOMRect[] =>
  typeof range.getClientRects === "function"
    ? Array.from(range.getClientRects())
    : [];

const isSelectionBackward = (selection: Selection): boolean => {
  if (!selection.anchorNode || !selection.focusNode) {
    return false;
  }

  if (selection.anchorNode === selection.focusNode) {
    return selection.anchorOffset > selection.focusOffset;
  }

  return Boolean(
    selection.anchorNode.compareDocumentPosition(selection.focusNode) &
    Node.DOCUMENT_POSITION_PRECEDING,
  );
};

const getSelectionEndpointRectangle = (
  selection: Selection,
  selectionRectangles: readonly DOMRect[],
): DOMRect | undefined => {
  if (selection.focusNode) {
    const endpointRange = document.createRange();

    endpointRange.setStart(selection.focusNode, selection.focusOffset);
    endpointRange.collapse(true);

    const endpointRectangle = getRangeRectangles(endpointRange).at(-1);

    if (endpointRectangle) {
      return endpointRectangle;
    }

    if (typeof endpointRange.getBoundingClientRect === "function") {
      const boundingRectangle = endpointRange.getBoundingClientRect();

      if (boundingRectangle.width > 0 || boundingRectangle.height > 0) {
        return boundingRectangle;
      }
    }
  }

  return isSelectionBackward(selection)
    ? selectionRectangles[0]
    : selectionRectangles.at(-1);
};

export const FilePreviewStatus = ({
  preview,
}: {
  preview: FilePreview;
}): JSX.Element | null => {
  if (preview.mode !== "text" || preview.loading || preview.error) {
    return null;
  }

  const showTargetLine = preview.targetLine !== null && preview.targetLine > 1;

  if (!showTargetLine && !preview.truncated && !preview.lossy) {
    return null;
  }

  return (
    <div className="mt-1 flex min-w-0 flex-wrap items-center gap-2 text-xs text-slate-500">
      {showTargetLine ? (
        <span className="font-medium text-sky-300">
          Opened at line {preview.targetLine}
        </span>
      ) : null}
      {preview.truncated ? <span>Preview truncated</span> : null}
      {preview.lossy ? <span>Encoding normalized</span> : null}
    </div>
  );
};

export const FilePreviewVisualContent = ({
  preview,
  visualKind,
}: {
  preview: FilePreview;
  visualKind: FilePreviewVisualKind;
}): JSX.Element => {
  const content = preview.content ?? "";

  if (visualKind === "markdown") {
    return (
      <div
        role="document"
        aria-label={`Rendered preview of ${preview.title}`}
        className="min-h-0 flex-1 overflow-auto bg-slate-950"
      >
        <MarkdownContent
          content={content}
          className="app-file-preview-markdown mx-auto w-full max-w-5xl px-6 py-8 text-sm text-slate-200 sm:px-10"
        />
      </div>
    );
  }

  return (
    <iframe
      sandbox=""
      referrerPolicy="no-referrer"
      srcDoc={content}
      title={`Rendered preview of ${preview.title}`}
      className="min-h-0 w-full flex-1 border-0 bg-white"
    />
  );
};

const getFilePreviewSyntaxOption = (value: string): FilePreviewSyntax =>
  FILE_PREVIEW_SYNTAX_OPTIONS.find(
    (option) => (option.language ?? "plaintext") === value,
  ) ?? FILE_PREVIEW_SYNTAX_OPTIONS[0];

interface StableFilePreviewCodeProps {
  codeRef: RefObject<HTMLElement | null>;
  content: string;
  renderedContent: string | null;
  selectedLanguage: FilePreviewLanguage | null;
}

const StableFilePreviewCode = memo(function StableFilePreviewCode({
  codeRef,
  content,
  renderedContent,
  selectedLanguage,
}: StableFilePreviewCodeProps): JSX.Element {
  if (renderedContent === null) {
    return <code ref={codeRef}>{content}</code>;
  }

  return (
    <code
      ref={codeRef}
      className={`language-${selectedLanguage ?? "plaintext"}`}
      dangerouslySetInnerHTML={{ __html: renderedContent }}
    />
  );
});

export const FilePreviewTextContent = ({
  preview,
}: {
  preview: FilePreview;
}): JSX.Element => {
  const visualKind = getFilePreviewVisualKind(preview.title || preview.path);
  const [viewMode, setViewMode] = useState<FilePreviewViewMode>("text");
  const [selectedLanguage, setSelectedLanguage] =
    useState<FilePreviewLanguage | null>(preview.language);
  const [searchQuery, setSearchQuery] = useState("");
  const [isRegexSearch, setIsRegexSearch] = useState(false);
  const [activeMatchIndex, setActiveMatchIndex] = useState(0);
  const [previewSelection, setPreviewSelection] =
    useState<FilePreviewSelection | null>(null);
  const [copyState, setCopyState] = useState<FilePreviewCopyState>("idle");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLElement>(null);
  const codeSurfaceRef = useRef<HTMLDivElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);
  const targetLineRef = useRef<HTMLButtonElement>(null);
  const gutterDragAnchorRef = useRef<number | null>(null);
  const gutterDragLineRef = useRef<number | null>(null);
  const gutterDragPointerIdRef = useRef<number | null>(null);
  const isTextPointerSelectingRef = useRef(false);
  const lineSelectionAnchorRef = useRef<number | null>(null);
  const resetCopyStateTimeoutRef = useRef<number | null>(null);
  const searchStatusId = useId();
  const activeViewMode = visualKind ? viewMode : "text";
  const lines = useMemo(
    () => (preview.content ?? "").split("\n"),
    [preview.content],
  );
  const targetLineIndex = getFilePreviewTargetLineIndex(
    preview.targetLine,
    lines.length,
  );
  const highlightedContent = useMemo(
    () =>
      preview.content === null
        ? null
        : highlightFilePreviewContent(preview.content, selectedLanguage),
    [preview.content, selectedLanguage],
  );
  const searchResult = useMemo(
    () =>
      findFilePreviewMatches(preview.content ?? "", searchQuery, isRegexSearch),
    [isRegexSearch, preview.content, searchQuery],
  );
  const safeActiveMatchIndex =
    searchResult.matches.length === 0
      ? -1
      : Math.min(activeMatchIndex, searchResult.matches.length - 1);
  const renderedContent = useMemo(
    () =>
      addSearchMatchesToHighlightedHtml(
        highlightedContent,
        preview.content ?? "",
        searchResult.matches,
        safeActiveMatchIndex,
      ),
    [
      highlightedContent,
      preview.content,
      safeActiveMatchIndex,
      searchResult.matches,
    ],
  );

  useEffect(() => {
    setViewMode("text");
    setSelectedLanguage(preview.language);
    setSearchQuery("");
    setIsRegexSearch(false);
    setPreviewSelection(null);
    setCopyState("idle");
    lineSelectionAnchorRef.current = null;
  }, [preview.content, preview.language, preview.path]);

  useEffect(() => {
    return () => {
      if (resetCopyStateTimeoutRef.current !== null) {
        window.clearTimeout(resetCopyStateTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    setActiveMatchIndex(0);
  }, [isRegexSearch, preview.content, searchQuery]);

  useEffect(() => {
    if (activeViewMode !== "text") {
      return;
    }

    if (targetLineIndex === null) {
      return;
    }

    scrollFilePreviewTargetLineIntoView(targetLineRef.current);
  }, [activeViewMode, preview.content, preview.path, targetLineIndex]);

  useEffect(() => {
    if (activeViewMode !== "text" || safeActiveMatchIndex < 0) {
      return;
    }

    const activeMatch = codeRef.current?.querySelector<HTMLElement>(
      '[data-file-preview-match="active"]',
    );

    if (activeMatch && typeof activeMatch.scrollIntoView === "function") {
      activeMatch.scrollIntoView({ block: "center", inline: "nearest" });
    }
  }, [activeViewMode, renderedContent, safeActiveMatchIndex]);

  useEffect(() => {
    const updateNativeSelection = (): void => {
      const selection = window.getSelection();
      const code = codeRef.current;

      if (
        !selection ||
        selection.isCollapsed ||
        selection.rangeCount === 0 ||
        !code ||
        !selection.anchorNode ||
        !selection.focusNode ||
        !code.contains(selection.anchorNode) ||
        !code.contains(selection.focusNode)
      ) {
        setPreviewSelection((current) =>
          current?.kind === "native" ? null : current,
        );
        return;
      }

      const text = selection.toString();

      if (!text) {
        setPreviewSelection((current) =>
          current?.kind === "native" ? null : current,
        );
        return;
      }

      const range = selection.getRangeAt(0);
      const surfaceRectangle = codeSurfaceRef.current?.getBoundingClientRect();
      const rangeRectangles = getRangeRectangles(range);
      const endpointRectangle = getSelectionEndpointRectangle(
        selection,
        rangeRectangles,
      );
      const position =
        surfaceRectangle && endpointRectangle
          ? {
              left: Math.max(
                FILE_PREVIEW_GUTTER_WIDTH + 8,
                endpointRectangle.right - surfaceRectangle.left + 8,
              ),
              top: Math.max(
                4,
                endpointRectangle.top -
                  surfaceRectangle.top -
                  FILE_PREVIEW_COPY_BUTTON_HEIGHT -
                  4,
              ),
            }
          : {
              left: FILE_PREVIEW_GUTTER_WIDTH + 8,
              top: 4,
            };

      lineSelectionAnchorRef.current = null;
      setCopyState("idle");
      setPreviewSelection({ kind: "native", text, position });
    };

    const handleSelectionChange = (): void => {
      if (isTextPointerSelectingRef.current) {
        return;
      }

      updateNativeSelection();
    };

    const finishPointerSelection = (): void => {
      if (!isTextPointerSelectingRef.current) {
        return;
      }

      isTextPointerSelectingRef.current = false;
      updateNativeSelection();
    };

    document.addEventListener("selectionchange", handleSelectionChange);
    document.addEventListener("pointerup", finishPointerSelection);
    document.addEventListener("pointercancel", finishPointerSelection);

    return () => {
      document.removeEventListener("selectionchange", handleSelectionChange);
      document.removeEventListener("pointerup", finishPointerSelection);
      document.removeEventListener("pointercancel", finishPointerSelection);
    };
  }, [renderedContent]);

  const moveActiveMatch = (offset: number): void => {
    const matchCount = searchResult.matches.length;

    if (matchCount === 0) {
      return;
    }

    setActiveMatchIndex((current) => {
      const normalizedCurrent =
        current >= 0 && current < matchCount ? current : 0;

      return (normalizedCurrent + offset + matchCount) % matchCount;
    });
  };

  const handleSearchKeyDown = (
    event: ReactKeyboardEvent<HTMLInputElement>,
  ): void => {
    if (event.key !== "Enter") {
      return;
    }

    event.preventDefault();
    moveActiveMatch(event.shiftKey ? -1 : 1);
  };

  const handleCodePointerDown = (
    event: ReactPointerEvent<HTMLPreElement>,
  ): void => {
    if (event.button !== 0) {
      return;
    }

    isTextPointerSelectingRef.current = true;
    lineSelectionAnchorRef.current = null;
    setCopyState("idle");
    setPreviewSelection(null);
  };

  const selectLineRange = (
    anchorLineIndex: number,
    lineIndex: number,
  ): void => {
    const startLineIndex = Math.min(anchorLineIndex, lineIndex);
    const endLineIndex = Math.max(anchorLineIndex, lineIndex);

    window.getSelection()?.removeAllRanges();
    setCopyState("idle");
    setPreviewSelection({
      kind: "lines",
      text: getLineSelectionText(lines, startLineIndex, endLineIndex),
      startLineIndex,
      endLineIndex,
      position: getLineSelectionPosition(lineIndex),
    });
  };

  const selectLine = (lineIndex: number, extendSelection: boolean): void => {
    const anchorLineIndex =
      extendSelection && lineSelectionAnchorRef.current !== null
        ? lineSelectionAnchorRef.current
        : lineIndex;

    if (!extendSelection || lineSelectionAnchorRef.current === null) {
      lineSelectionAnchorRef.current = lineIndex;
    }

    selectLineRange(anchorLineIndex, lineIndex);
  };

  const startGutterDrag = (
    lineIndex: number,
    event: ReactPointerEvent<HTMLButtonElement>,
  ): void => {
    if (event.button !== 0) {
      return;
    }

    event.preventDefault();

    const anchorLineIndex =
      event.shiftKey && lineSelectionAnchorRef.current !== null
        ? lineSelectionAnchorRef.current
        : lineIndex;

    if (!event.shiftKey || lineSelectionAnchorRef.current === null) {
      lineSelectionAnchorRef.current = lineIndex;
    }

    gutterDragAnchorRef.current = anchorLineIndex;
    gutterDragLineRef.current = lineIndex;
    gutterDragPointerIdRef.current = event.pointerId;
    selectLineRange(anchorLineIndex, lineIndex);

    if (typeof gutterRef.current?.setPointerCapture === "function") {
      gutterRef.current.setPointerCapture(event.pointerId);
    }
  };

  const extendGutterDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (
      gutterDragPointerIdRef.current !== event.pointerId ||
      gutterDragAnchorRef.current === null ||
      !gutterRef.current
    ) {
      return;
    }

    const gutterRectangle = gutterRef.current.getBoundingClientRect();
    const relativePointerY =
      event.clientY - gutterRectangle.top - FILE_PREVIEW_VERTICAL_PADDING;
    const lineIndex = Math.max(
      0,
      Math.min(
        lines.length - 1,
        Math.floor(relativePointerY / FILE_PREVIEW_LINE_HEIGHT),
      ),
    );

    if (lineIndex === gutterDragLineRef.current) {
      return;
    }

    gutterDragLineRef.current = lineIndex;
    selectLineRange(gutterDragAnchorRef.current, lineIndex);
  };

  const finishGutterDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (gutterDragPointerIdRef.current !== event.pointerId) {
      return;
    }

    if (
      typeof gutterRef.current?.hasPointerCapture === "function" &&
      gutterRef.current.hasPointerCapture(event.pointerId)
    ) {
      gutterRef.current.releasePointerCapture(event.pointerId);
    }

    gutterDragAnchorRef.current = null;
    gutterDragLineRef.current = null;
    gutterDragPointerIdRef.current = null;
  };

  const copySelectedText = async (): Promise<void> => {
    if (!previewSelection) {
      return;
    }

    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error("Clipboard write access is unavailable.");
      }

      await navigator.clipboard.writeText(previewSelection.text);
      setCopyState("copied");

      if (resetCopyStateTimeoutRef.current !== null) {
        window.clearTimeout(resetCopyStateTimeoutRef.current);
      }

      resetCopyStateTimeoutRef.current = window.setTimeout(() => {
        setCopyState("idle");
        resetCopyStateTimeoutRef.current = null;
      }, 1_500);
    } catch (error) {
      console.error("Failed to copy selected preview text", error);
      setCopyState("failed");
    }
  };

  const searchStatus = searchQuery
    ? searchResult.error
      ? "Invalid regex"
      : searchResult.matches.length === 0
        ? "No matches"
        : `${safeActiveMatchIndex + 1} of ${searchResult.matches.length}`
    : "";
  const regexSearchButtonLabel = isRegexSearch
    ? "Use plain text search"
    : "Use regular expression search";
  const commandStateRef = useRef({
    activeViewMode,
    copySelectedText,
    hasSelection: previewSelection !== null,
    isRegexSearch,
    matchCount: searchResult.matches.length,
    moveActiveMatch,
    searchInputRef,
    searchQuery,
    selectedLanguage,
    setIsRegexSearch,
    setSearchQuery,
    setSelectedLanguage,
    setViewMode,
    visualKind,
  });
  commandStateRef.current = {
    activeViewMode,
    copySelectedText,
    hasSelection: previewSelection !== null,
    isRegexSearch,
    matchCount: searchResult.matches.length,
    moveActiveMatch,
    searchInputRef,
    searchQuery,
    selectedLanguage,
    setIsRegexSearch,
    setSearchQuery,
    setSelectedLanguage,
    setViewMode,
    visualKind,
  };
  const previewCommands = useMemo<readonly CommandDefinition[]>(() => {
    const state = () => commandStateRef.current;
    const scope = { kind: "overlay", ownerId: "file-preview" } as const;
    const numericKey = (index: number): CommandPageItem["numericKey"] =>
      index < 9 ? (`${index + 1}` as CommandPageItem["numericKey"]) : undefined;
    return asPaletteCommands([
      {
        id: "file-preview.view.select",
        title: "Choose preview mode",
        group: "File preview",
        scope,
        availability: () =>
          state().visualKind ? { state: "enabled" } : { state: "hidden" },
        children: () => ({
          id: "file-preview-view",
          title: "Preview mode",
          searchPlaceholder: "Choose preview mode",
          numericSelection: true,
          groups: [
            {
              id: "modes",
              items: (["text", "visual"] as const).map((mode, index) => ({
                id: mode,
                title: mode === "text" ? "Text" : "Visual",
                current: state().activeViewMode === mode,
                numericKey: numericKey(index),
                execute: () => state().setViewMode(mode),
              })),
            },
          ],
        }),
      },
      {
        id: "file-preview.syntax.select",
        title: "Choose syntax highlighting",
        group: "File preview",
        scope,
        availability: () =>
          state().activeViewMode === "text"
            ? { state: "enabled" }
            : { state: "hidden" },
        children: () => ({
          id: "file-preview-syntax",
          title: "Syntax highlighting",
          searchPlaceholder: "Choose language",
          groups: [
            {
              id: "languages",
              items: FILE_PREVIEW_SYNTAX_OPTIONS.map((option) => ({
                id: option.language ?? "plaintext",
                title: option.label,
                current: state().selectedLanguage === option.language,
                execute: () => state().setSelectedLanguage(option.language),
              })),
            },
          ],
        }),
      },
      {
        id: "file-preview.search.focus",
        title: "Find in file",
        group: "File preview",
        scope,
        shortcuts: [
          {
            chord: getDefaultCommandShortcut("file-preview.search.focus"),
            runtimes: ["tauri"],
            allowIn: [
              "document",
              "text-entry",
              "interactive-control",
              "command-surface",
            ],
          },
        ],
        availability: () =>
          state().activeViewMode === "text"
            ? { state: "enabled" }
            : { state: "hidden" },
        execute: () => {
          window.requestAnimationFrame(() => {
            window.requestAnimationFrame(() => {
              state().searchInputRef.current?.focus({ preventScroll: true });
              state().searchInputRef.current?.select();
            });
          });
        },
      },
      {
        id: "file-preview.search.regex.toggle",
        title: "Toggle regular expression search",
        group: "File preview",
        scope,
        current: () => state().isRegexSearch,
        availability: () =>
          state().activeViewMode === "text"
            ? { state: "enabled" }
            : { state: "hidden" },
        execute: () => state().setIsRegexSearch(!state().isRegexSearch),
      },
      {
        id: "file-preview.search.previous",
        title: "Previous search match",
        group: "File preview",
        scope,
        availability: () =>
          state().matchCount > 0
            ? { state: "enabled" }
            : { state: "disabled", reason: "No search matches" },
        execute: () => state().moveActiveMatch(-1),
      },
      {
        id: "file-preview.search.next",
        title: "Next search match",
        group: "File preview",
        scope,
        availability: () =>
          state().matchCount > 0
            ? { state: "enabled" }
            : { state: "disabled", reason: "No search matches" },
        execute: () => state().moveActiveMatch(1),
      },
      {
        id: "file-preview.search.clear",
        title: "Clear file search",
        group: "File preview",
        scope,
        availability: () =>
          state().searchQuery
            ? { state: "enabled" }
            : { state: "disabled", reason: "The search is empty" },
        execute: () => state().setSearchQuery(""),
      },
      {
        id: "file-preview.selection.copy",
        title: "Copy selected text",
        group: "File preview",
        scope,
        availability: () =>
          state().hasSelection
            ? { state: "enabled" }
            : { state: "disabled", reason: "Select text or lines first" },
        execute: () => state().copySelectedText(),
      },
    ]);
  }, []);
  useOptionalRegisterCommands(previewCommands);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-slate-950">
      <div
        role="toolbar"
        aria-label="File preview controls"
        className="flex flex-wrap items-center gap-2 border-b border-slate-800/80 bg-slate-950 px-4 py-2"
      >
        {visualKind ? (
          <div
            role="group"
            aria-label="File preview mode"
            className="flex h-8 items-center gap-0.5 rounded-md border border-slate-800 bg-slate-900 p-0.5"
          >
            {(["text", "visual"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                aria-pressed={activeViewMode === mode}
                aria-label={`Show ${mode} preview`}
                onClick={() => setViewMode(mode)}
                className={cn(
                  "h-6 rounded px-2.5 text-xs font-medium capitalize outline-none transition-colors focus-visible:ring-1 focus-visible:ring-sky-400/70",
                  activeViewMode === mode
                    ? "bg-slate-700 text-slate-100 shadow-sm"
                    : "text-slate-500 hover:bg-slate-800 hover:text-slate-300",
                )}
              >
                {mode}
              </button>
            ))}
          </div>
        ) : null}

        <select
          aria-label="Syntax highlighting"
          value={selectedLanguage ?? "plaintext"}
          onChange={(event) =>
            setSelectedLanguage(
              getFilePreviewSyntaxOption(event.currentTarget.value).language,
            )
          }
          className={cn(
            "h-8 w-40 rounded-md border border-slate-800 bg-slate-900 px-2 text-xs text-slate-300 outline-none focus-visible:border-sky-500/70 focus-visible:ring-1 focus-visible:ring-sky-500/40",
            activeViewMode === "visual" && "hidden",
          )}
        >
          {FILE_PREVIEW_SYNTAX_OPTIONS.map((option) => (
            <option
              key={option.language ?? "plaintext"}
              value={option.language ?? "plaintext"}
            >
              {option.label}
            </option>
          ))}
        </select>

        <div
          className={cn(
            "ml-auto min-w-[min(100%,22rem)] flex-1 items-center justify-end gap-1",
            activeViewMode === "visual" ? "hidden" : "flex",
          )}
        >
          <div className="relative w-full max-w-sm">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
            <Input
              ref={searchInputRef}
              type="search"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.currentTarget.value)}
              onKeyDown={handleSearchKeyDown}
              aria-label="Find in file"
              aria-describedby={searchStatusId}
              aria-invalid={Boolean(searchResult.error)}
              placeholder="Find in file"
              autoComplete="off"
              spellCheck={false}
              className="h-8 border-slate-800 bg-slate-900 pr-2 pl-8 text-xs text-slate-200 shadow-none placeholder:text-slate-500 focus-visible:border-sky-500/60 focus-visible:ring-sky-500/30"
            />
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={regexSearchButtonLabel}
            aria-pressed={isRegexSearch}
            tooltip={regexSearchButtonLabel}
            onClick={() => setIsRegexSearch((current) => !current)}
            className={cn(
              "text-slate-400 hover:bg-slate-800 hover:text-slate-100",
              isRegexSearch && "bg-sky-500/15 text-sky-200",
            )}
          >
            <Regex className="h-3.5 w-3.5" />
          </Button>
          <ControlTooltip content={searchResult.error}>
            <span
              id={searchStatusId}
              aria-live="polite"
              className={cn(
                "min-w-16 text-center text-[11px] tabular-nums text-slate-500",
                searchResult.error && "text-rose-300",
              )}
            >
              {searchStatus}
            </span>
          </ControlTooltip>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Previous match"
            disabled={searchResult.matches.length === 0}
            onClick={() => moveActiveMatch(-1)}
            className="text-slate-400 hover:bg-slate-800 hover:text-slate-100"
          >
            <ChevronUp className="h-3.5 w-3.5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Next match"
            disabled={searchResult.matches.length === 0}
            onClick={() => moveActiveMatch(1)}
            className="text-slate-400 hover:bg-slate-800 hover:text-slate-100"
          >
            <ChevronDown className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      <div
        className={cn(
          "min-h-0 flex-1 overflow-auto",
          activeViewMode === "visual" && "hidden",
        )}
      >
        <div
          ref={codeSurfaceRef}
          className="relative grid min-h-full w-max min-w-full grid-cols-[2.5rem_minmax(max-content,1fr)] bg-slate-950"
        >
          {targetLineIndex !== null ? (
            <div
              aria-hidden="true"
              data-file-preview-target-line={targetLineIndex + 1}
              className="pointer-events-none absolute right-0 left-0 z-0 border-y border-amber-300/25 bg-amber-300/10"
              style={{
                top:
                  FILE_PREVIEW_VERTICAL_PADDING +
                  targetLineIndex * FILE_PREVIEW_LINE_HEIGHT,
                height: FILE_PREVIEW_LINE_HEIGHT,
              }}
            />
          ) : null}

          {previewSelection?.kind === "lines" ? (
            <div
              aria-hidden="true"
              className="pointer-events-none absolute right-0 left-0 z-0 border-y border-sky-400/15 bg-sky-400/10"
              style={{
                top:
                  FILE_PREVIEW_VERTICAL_PADDING +
                  previewSelection.startLineIndex * FILE_PREVIEW_LINE_HEIGHT,
                height:
                  (previewSelection.endLineIndex -
                    previewSelection.startLineIndex +
                    1) *
                  FILE_PREVIEW_LINE_HEIGHT,
              }}
            />
          ) : null}

          <div
            ref={gutterRef}
            role="group"
            aria-label="Select complete lines"
            onPointerMove={extendGutterDrag}
            onPointerUp={finishGutterDrag}
            onPointerCancel={finishGutterDrag}
            className="sticky left-0 z-20 col-start-1 row-start-1 min-h-full touch-none border-r border-slate-800/60 bg-slate-950/95 py-4 backdrop-blur-sm select-none"
          >
            {lines.map((_, lineIndex) => {
              const isSelected =
                previewSelection?.kind === "lines" &&
                lineIndex >= previewSelection.startLineIndex &&
                lineIndex <= previewSelection.endLineIndex;
              const isTargetLine = lineIndex === targetLineIndex;
              const lineTooltip = isTargetLine
                ? `Opened at line ${lineIndex + 1}; drag to select a range`
                : `Select line ${lineIndex + 1}; drag to select a range`;

              return (
                <ControlTooltip key={lineIndex} content={lineTooltip}>
                  <button
                    ref={isTargetLine ? targetLineRef : undefined}
                    type="button"
                    aria-label={`Select line ${lineIndex + 1}${
                      isTargetLine ? " (opened location)" : ""
                    }`}
                    aria-pressed={isSelected}
                    aria-current={isTargetLine ? "location" : undefined}
                    onPointerDown={(event) => startGutterDrag(lineIndex, event)}
                    onClick={(event) => {
                      if (event.detail === 0) {
                        selectLine(lineIndex, event.shiftKey);
                      }
                    }}
                    className={cn(
                      "group/line flex h-5 w-10 cursor-ns-resize items-center justify-center outline-none transition-colors focus-visible:bg-sky-400/15",
                      isTargetLine && "bg-amber-300/15",
                      isSelected && "bg-sky-400/10",
                    )}
                  >
                    <span
                      aria-hidden="true"
                      className={cn(
                        "h-1.5 w-1.5 rounded-full bg-slate-700 transition-all group-hover/line:scale-125 group-hover/line:bg-sky-300 group-focus-visible/line:scale-125 group-focus-visible/line:bg-sky-300",
                        isTargetLine &&
                          "scale-125 bg-amber-300 ring-2 ring-amber-300/20",
                        isSelected && "scale-125 bg-sky-300",
                      )}
                    />
                  </button>
                </ControlTooltip>
              );
            })}
          </div>

          <pre
            aria-label={`Contents of ${preview.title}`}
            onPointerDown={handleCodePointerDown}
            className={cn(
              "app-file-preview-code relative z-10 col-start-2 row-start-1 m-0 min-h-full min-w-0 select-text overflow-visible py-4 pr-4 pl-3 font-mono text-xs leading-5 text-slate-200",
              "whitespace-pre [tab-size:2]",
            )}
          >
            <StableFilePreviewCode
              codeRef={codeRef}
              content={preview.content ?? ""}
              renderedContent={renderedContent}
              selectedLanguage={selectedLanguage}
            />
          </pre>

          {previewSelection ? (
            <Button
              type="button"
              size="xs"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => void copySelectedText()}
              aria-label={
                copyState === "copied"
                  ? "Selected text copied"
                  : copyState === "failed"
                    ? "Unable to copy selected text"
                    : "Copy selected text"
              }
              className={cn(
                "absolute z-30 h-7 border border-slate-700 bg-slate-800 px-2 text-[11px] text-slate-100 shadow-lg hover:bg-slate-700",
                copyState === "failed" &&
                  "border-rose-500/50 text-rose-100 hover:bg-slate-700",
              )}
              style={{
                left: previewSelection.position.left,
                top: previewSelection.position.top,
              }}
            >
              {copyState === "copied" ? (
                <Check className="h-3 w-3 text-emerald-300" />
              ) : (
                <Copy className="h-3 w-3" />
              )}
              {copyState === "copied"
                ? "Copied"
                : copyState === "failed"
                  ? "Copy failed"
                  : "Copy"}
            </Button>
          ) : null}
        </div>
      </div>

      {activeViewMode === "visual" && visualKind ? (
        <FilePreviewVisualContent preview={preview} visualKind={visualKind} />
      ) : null}
    </div>
  );
};

const PreviewBody = ({ preview }: { preview: FilePreview }): JSX.Element => {
  if (preview.loading) {
    return (
      <div
        role="status"
        className="flex min-h-72 items-center justify-center gap-2 text-sm text-slate-400"
      >
        <Loader2 className="h-4 w-4 animate-spin text-sky-300" />
        Loading preview...
      </div>
    );
  }

  if (preview.error) {
    return (
      <div className="grid min-h-72 place-items-center bg-slate-950 p-4">
        <div
          role="alert"
          className="flex max-w-lg items-start gap-3 rounded-lg border border-rose-500/25 bg-rose-500/10 p-4 text-sm text-rose-100"
        >
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-rose-300" />
          <span>{preview.error}</span>
        </div>
      </div>
    );
  }

  if (preview.mode === "image" && preview.source) {
    return (
      <div className="grid min-h-72 place-items-center overflow-auto bg-slate-950 p-4">
        <img
          src={preview.source}
          alt={`Preview of ${preview.title}`}
          className="max-h-[calc(100vh-224px)] max-w-full object-contain"
        />
      </div>
    );
  }

  if (preview.mode === "pdf" && preview.source) {
    return (
      <iframe
        src={preview.source}
        title={`Preview of ${preview.title}`}
        className="min-h-[min(720px,calc(100vh-220px))] w-full flex-1 border-0 bg-slate-950"
      />
    );
  }

  if (preview.mode === "text") {
    return <FilePreviewTextContent preview={preview} />;
  }

  return (
    <div className="grid min-h-72 place-items-center bg-slate-950 p-4">
      <div className="flex max-w-lg items-start gap-3 rounded-lg border border-slate-800 bg-slate-900/70 p-4 text-sm text-slate-300">
        <FileText className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />
        <span>No in-app preview is available for this file.</span>
      </div>
    </div>
  );
};

export const FilePreviewDialog = ({
  preview,
  onOpenChange,
  onOpenExternal,
}: FilePreviewDialogProps): JSX.Element => {
  const commandStateRef = useRef({ onOpenChange, onOpenExternal, preview });
  commandStateRef.current = { onOpenChange, onOpenExternal, preview };
  const dialogCommands = useMemo<readonly CommandDefinition[]>(() => {
    const state = () => commandStateRef.current;
    const scope = { kind: "overlay", ownerId: "file-preview" } as const;
    return asPaletteCommands([
      {
        id: "file-preview.external.open",
        title: "Open file externally",
        group: "File preview",
        scope,
        availability: () =>
          state().preview ? { state: "enabled" } : { state: "hidden" },
        execute: () => state().onOpenExternal(),
      },
      {
        id: "file-preview.close",
        title: "Close file preview",
        group: "File preview",
        scope,
        availability: () =>
          state().preview ? { state: "enabled" } : { state: "hidden" },
        execute: () => state().onOpenChange(false),
      },
    ]);
  }, []);
  useOptionalRegisterCommands(dialogCommands);

  return (
    <Dialog
      open={Boolean(preview)}
      onOpenChange={onOpenChange}
      commandOverlayId="file-preview"
      commandOverlayAllowGlobalCommands={["app.palette.toggle"]}
    >
      {preview ? (
        <DialogContent
          data-command-owner="file-preview"
          className="app-file-preview-dialog flex h-[min(860px,calc(100vh-32px))] w-[min(1120px,calc(100vw-32px))] max-w-none flex-col gap-0 overflow-hidden rounded-xl border-slate-800 bg-slate-950 p-0 text-slate-100 shadow-2xl sm:max-w-none"
        >
          <DialogHeader className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-4 border-b border-slate-800/80 px-5 py-4 pr-12 text-left">
            <div className="min-w-0">
              <DialogTitle className="truncate text-base font-semibold text-white">
                {preview.title}
              </DialogTitle>
              <DialogDescription className="truncate font-mono text-xs text-slate-500">
                {preview.path}
              </DialogDescription>
              <FilePreviewStatus preview={preview} />
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onOpenExternal}
              className="h-8 rounded-full border-slate-800 bg-slate-900/80 px-3 text-xs text-slate-300 hover:bg-slate-800 hover:text-slate-100"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              Open externally
            </Button>
          </DialogHeader>

          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <PreviewBody preview={preview} />
          </div>
        </DialogContent>
      ) : null}
    </Dialog>
  );
};
