import { useEffect, useState } from "react";
import type { FilePreviewLanguage } from "./file-preview-language";
import {
  findFilePreviewMatches,
  type FilePreviewSearchResult,
} from "./file-preview-search";
import { runFilePreviewWorkerJob } from "./file-preview-worker-job";

const EMPTY_SEARCH: FilePreviewSearchResult = { matches: [], error: null };

export const useFilePreviewHighlight = (
  content: string | null,
  language: FilePreviewLanguage | null,
): string | null => {
  const [result, setResult] = useState<{
    content: string;
    language: FilePreviewLanguage;
    value: string | null;
  } | null>(null);
  useEffect(() => {
    if (
      !content ||
      !language ||
      content.length > 200_000 ||
      typeof Worker === "undefined"
    )
      return;
    const controller = new AbortController();
    void runFilePreviewWorkerJob<string | null>(
      () =>
        new Worker(
          new URL("./file-preview-highlight.worker.ts", import.meta.url),
          { type: "module" },
        ),
      { content, language },
      controller.signal,
      1_500,
      "Syntax highlighting took too long.",
    ).then(
      (value) => {
        if (!controller.signal.aborted) setResult({ content, language, value });
      },
      () => {
        if (!controller.signal.aborted)
          setResult({ content, language, value: null });
      },
    );
    return () => controller.abort();
  }, [content, language]);
  return result?.content === content && result?.language === language
    ? result.value
    : null;
};

export const useFilePreviewSearch = (
  content: string,
  query: string,
  isRegex: boolean,
): { result: FilePreviewSearchResult; pending: boolean } => {
  const [completed, setCompleted] = useState<{
    content: string;
    query: string;
    isRegex: boolean;
    result: FilePreviewSearchResult;
  } | null>(null);
  useEffect(() => {
    if (!query) return;
    const controller = new AbortController();
    const publish = (result: FilePreviewSearchResult) => {
      if (!controller.signal.aborted)
        setCompleted({ content, query, isRegex, result });
    };
    const timer = setTimeout(() => {
      if (typeof Worker === "undefined") {
        // Literal patterns are escaped; never run an arbitrary regex on the UI thread.
        publish(
          isRegex
            ? {
                matches: [],
                error:
                  "Regular expression search is unavailable in this environment.",
              }
            : findFilePreviewMatches(content, query, false),
        );
        return;
      }
      void runFilePreviewWorkerJob<FilePreviewSearchResult>(
        () =>
          new Worker(
            new URL("./file-preview-search.worker.ts", import.meta.url),
            { type: "module" },
          ),
        { content, query, isRegex },
        controller.signal,
        500,
        "Search took too long. Try a simpler expression.",
      ).then(publish, (error: unknown) =>
        publish(
          isRegex
            ? {
                matches: [],
                error:
                  error instanceof Error ? error.message : "Search failed.",
              }
            : findFilePreviewMatches(content, query, false),
        ),
      );
    }, 120);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [content, query, isRegex]);
  if (!query) return { result: EMPTY_SEARCH, pending: false };
  if (
    completed?.content === content &&
    completed.query === query &&
    completed.isRegex === isRegex
  )
    return { result: completed.result, pending: false };
  return { result: EMPTY_SEARCH, pending: true };
};
