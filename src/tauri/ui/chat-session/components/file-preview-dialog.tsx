import {
  ChevronDown,
  ChevronUp,
  ExternalLink,
  FileText,
  Loader2,
  Regex,
  Search,
  TriangleAlert,
} from "lucide-react";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  FILE_PREVIEW_SYNTAX_OPTIONS,
  type FilePreviewLanguage,
  type FilePreviewSyntax,
} from "../_helpers/file-preview-language";
import { highlightFilePreviewContent } from "../_helpers/file-preview-highlight";
import {
  addSearchMatchesToHighlightedHtml,
  findFilePreviewMatches,
} from "../_helpers/file-preview-search";
import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
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
}

export interface FilePreviewDialogProps {
  preview: FilePreview | null;
  onOpenChange: (open: boolean) => void;
  onOpenExternal: () => void;
}

const FilePreviewStatus = ({
  preview,
}: {
  preview: FilePreview;
}): JSX.Element | null => {
  if (preview.mode !== "text" || preview.loading || preview.error) {
    return null;
  }

  if (!preview.truncated && !preview.lossy) {
    return null;
  }

  return (
    <div className="mt-1 flex min-w-0 flex-wrap items-center gap-2 text-xs text-slate-500">
      {preview.truncated ? <span>Preview truncated</span> : null}
      {preview.lossy ? <span>Encoding normalized</span> : null}
    </div>
  );
};

const getFilePreviewSyntaxOption = (value: string): FilePreviewSyntax =>
  FILE_PREVIEW_SYNTAX_OPTIONS.find(
    (option) => (option.language ?? "plaintext") === value,
  ) ?? FILE_PREVIEW_SYNTAX_OPTIONS[0];

const TextPreviewContent = ({
  preview,
}: {
  preview: FilePreview;
}): JSX.Element => {
  const [selectedLanguage, setSelectedLanguage] =
    useState<FilePreviewLanguage | null>(preview.language);
  const [searchQuery, setSearchQuery] = useState("");
  const [isRegexSearch, setIsRegexSearch] = useState(false);
  const [activeMatchIndex, setActiveMatchIndex] = useState(0);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLElement>(null);
  const searchStatusId = useId();
  const highlightedContent = useMemo(
    () =>
      preview.content === null
        ? null
        : highlightFilePreviewContent(preview.content, selectedLanguage),
    [preview.content, selectedLanguage],
  );
  const searchResult = useMemo(
    () =>
      findFilePreviewMatches(
        preview.content ?? "",
        searchQuery,
        isRegexSearch,
      ),
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
    setSelectedLanguage(preview.language);
    setSearchQuery("");
    setIsRegexSearch(false);
  }, [preview.language, preview.path]);

  useEffect(() => {
    setActiveMatchIndex(0);
  }, [isRegexSearch, preview.content, searchQuery]);

  useEffect(() => {
    if (safeActiveMatchIndex < 0) {
      return;
    }

    const activeMatch = codeRef.current?.querySelector<HTMLElement>(
      '[data-file-preview-match="active"]',
    );

    if (activeMatch && typeof activeMatch.scrollIntoView === "function") {
      activeMatch.scrollIntoView({ block: "center", inline: "nearest" });
    }
  }, [renderedContent, safeActiveMatchIndex]);

  useEffect(() => {
    const focusSearch = (event: KeyboardEvent): void => {
      if (
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === "f"
      ) {
        event.preventDefault();
        searchInputRef.current?.focus();
      }
    };

    window.addEventListener("keydown", focusSearch);

    return () => window.removeEventListener("keydown", focusSearch);
  }, []);

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

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-slate-950">
      <div
        role="toolbar"
        aria-label="File preview controls"
        className="flex flex-wrap items-center gap-2 border-b border-slate-800/80 bg-slate-950 px-4 py-2"
      >
        <select
          aria-label="Syntax highlighting"
          value={selectedLanguage ?? "plaintext"}
          onChange={(event) =>
            setSelectedLanguage(
              getFilePreviewSyntaxOption(event.currentTarget.value).language,
            )
          }
          className="h-8 w-40 rounded-md border border-slate-800 bg-slate-900 px-2 text-xs text-slate-300 outline-none focus-visible:border-sky-500/70 focus-visible:ring-1 focus-visible:ring-sky-500/40"
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

        <div className="ml-auto flex min-w-[min(100%,22rem)] flex-1 items-center justify-end gap-1">
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
            title={regexSearchButtonLabel}
            onClick={() => setIsRegexSearch((current) => !current)}
            className={cn(
              "text-slate-400 hover:bg-slate-800 hover:text-slate-100",
              isRegexSearch && "bg-sky-500/15 text-sky-200",
            )}
          >
            <Regex className="h-3.5 w-3.5" />
          </Button>
          <span
            id={searchStatusId}
            aria-live="polite"
            title={searchResult.error ?? undefined}
            className={cn(
              "min-w-16 text-center text-[11px] tabular-nums text-slate-500",
              searchResult.error && "text-rose-300",
            )}
          >
            {searchStatus}
          </span>
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

      <div className="min-h-0 flex-1 overflow-auto">
        <pre
          aria-label={`Contents of ${preview.title}`}
          className={cn(
            "app-file-preview-code m-0 min-h-full w-max min-w-full select-text overflow-visible p-4 font-mono text-xs leading-5 text-slate-200",
            "whitespace-pre [tab-size:2]",
          )}
        >
          {renderedContent !== null ? (
            <code
              ref={codeRef}
              className={`language-${selectedLanguage ?? "plaintext"}`}
              dangerouslySetInnerHTML={{ __html: renderedContent }}
            />
          ) : (
            <code ref={codeRef}>{preview.content ?? ""}</code>
          )}
        </pre>
      </div>
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
    return <TextPreviewContent preview={preview} />;
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
  return (
    <Dialog open={Boolean(preview)} onOpenChange={onOpenChange}>
      {preview ? (
        <DialogContent className="app-file-preview-dialog flex h-[min(860px,calc(100vh-32px))] w-[min(1120px,calc(100vw-32px))] max-w-none flex-col gap-0 overflow-hidden rounded-xl border-slate-800 bg-slate-950 p-0 text-slate-100 shadow-2xl sm:max-w-none">
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
