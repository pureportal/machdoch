import type {
  WorkspaceTextReplaceResult,
  WorkspaceTextSearch,
  WorkspaceTextSearchOptions,
} from "@machdoch/fleet-protocol/workspace-contract";

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

const searchExpression = (options: WorkspaceTextSearchOptions): RegExp => {
  const source = options.regex ? options.query : escapeRegExp(options.query);
  const bounded = options.wholeWord ? `\\b(?:${source})\\b` : source;
  return new RegExp(bounded, options.caseSensitive ? "gu" : "giu");
};

export const searchPreviewText = (
  files: [string, string][],
  options: WorkspaceTextSearchOptions,
  replacement?: string,
): { search: WorkspaceTextSearch; replace: WorkspaceTextReplaceResult } => {
  const expression = searchExpression(options);
  const search: WorkspaceTextSearch = {
    files: [],
    totalMatches: 0,
    searchedFiles: files.length,
    limitReached: false,
  };
  const replace: WorkspaceTextReplaceResult = {
    files: [],
    applied: false,
  };
  for (const [path, content] of files) {
    const matches = content.split("\n").flatMap((text, index) =>
      [...text.matchAll(expression)]
        .filter((match) => match[0].length > 0)
        .map((match) => ({
          line: index + 1,
          column: (match.index ?? 0) + 1,
          length: match[0].length,
          preview: text,
          previewColumn: (match.index ?? 0) + 1,
        })),
    );
    if (matches.length === 0) continue;
    search.files.push({ path, revision: "preview", matches });
    search.totalMatches += matches.length;
    if (replacement !== undefined) {
      replace.files.push({
        path,
        status: "preview",
        replacements: matches.length,
        lines: [...new Set(matches.map((match) => match.line))].map((line) => {
          const before = content.split("\n")[line - 1] ?? "";
          return {
            line,
            before,
            after: before.replace(expression, replacement),
          };
        }),
      });
    }
  }
  return { search, replace };
};
