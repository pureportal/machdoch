export interface FilePreviewSearchMatch {
  start: number;
  end: number;
}

export interface FilePreviewSearchResult {
  matches: readonly FilePreviewSearchMatch[];
  error: string | null;
}

interface PreviewTextNodeRange {
  node: Text;
  start: number;
  end: number;
}

const escapeRegularExpression = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

export const findFilePreviewMatches = (
  content: string,
  query: string,
  isRegex: boolean,
): FilePreviewSearchResult => {
  if (!query) {
    return { matches: [], error: null };
  }

  try {
    const expression = new RegExp(
      isRegex ? query : escapeRegularExpression(query),
      "giu",
    );
    const matches: FilePreviewSearchMatch[] = [];

    for (const match of content.matchAll(expression)) {
      const value = match[0];

      if (!value) {
        continue;
      }

      matches.push({
        start: match.index,
        end: match.index + value.length,
      });
    }

    return { matches, error: null };
  } catch (error) {
    return {
      matches: [],
      error:
        error instanceof Error ? error.message : "Invalid regular expression.",
    };
  }
};

export const addSearchMatchesToHighlightedHtml = (
  highlightedContent: string | null,
  content: string,
  matches: readonly FilePreviewSearchMatch[],
  activeMatchIndex: number,
): string | null => {
  if (matches.length === 0 || typeof document === "undefined") {
    return highlightedContent;
  }

  const root = document.createElement("div");

  if (highlightedContent === null) {
    root.textContent = content;
  } else {
    root.innerHTML = highlightedContent;
  }

  const textNodeRanges: PreviewTextNodeRange[] = [];
  const textNodeWalker = document.createTreeWalker(root, 4);
  let textOffset = 0;
  let currentNode = textNodeWalker.nextNode();

  while (currentNode) {
    const textNode = currentNode as Text;
    const textLength = textNode.data.length;

    textNodeRanges.push({
      node: textNode,
      start: textOffset,
      end: textOffset + textLength,
    });
    textOffset += textLength;
    currentNode = textNodeWalker.nextNode();
  }

  let firstPossibleMatchIndex = 0;

  for (const textNodeRange of textNodeRanges) {
    while (
      firstPossibleMatchIndex < matches.length &&
      matches[firstPossibleMatchIndex]!.end <= textNodeRange.start
    ) {
      firstPossibleMatchIndex += 1;
    }

    let matchIndex = firstPossibleMatchIndex;
    let nodeOffset = 0;
    let hasNodeMatches = false;
    const fragment = document.createDocumentFragment();

    while (
      matchIndex < matches.length &&
      matches[matchIndex]!.start < textNodeRange.end
    ) {
      const match = matches[matchIndex]!;
      const matchStart = Math.max(match.start, textNodeRange.start);
      const matchEnd = Math.min(match.end, textNodeRange.end);
      const localMatchStart = matchStart - textNodeRange.start;
      const localMatchEnd = matchEnd - textNodeRange.start;

      if (localMatchEnd <= localMatchStart) {
        matchIndex += 1;
        continue;
      }

      hasNodeMatches = true;
      fragment.append(
        document.createTextNode(
          textNodeRange.node.data.slice(nodeOffset, localMatchStart),
        ),
      );

      const mark = document.createElement("mark");
      const isActive = matchIndex === activeMatchIndex;

      mark.className = isActive
        ? "app-file-preview-match app-file-preview-match-active"
        : "app-file-preview-match";
      mark.dataset.filePreviewMatch = isActive ? "active" : "match";
      mark.dataset.matchIndex = String(matchIndex);
      mark.textContent = textNodeRange.node.data.slice(
        localMatchStart,
        localMatchEnd,
      );
      fragment.append(mark);
      nodeOffset = localMatchEnd;
      matchIndex += 1;
    }

    if (!hasNodeMatches) {
      continue;
    }

    fragment.append(
      document.createTextNode(textNodeRange.node.data.slice(nodeOffset)),
    );
    textNodeRange.node.parentNode?.replaceChild(fragment, textNodeRange.node);
  }

  return root.innerHTML;
};
