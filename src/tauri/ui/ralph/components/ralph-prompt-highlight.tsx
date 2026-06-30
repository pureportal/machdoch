import type { JSX } from "react";

interface RalphPromptHighlightProps {
  value: string;
}

const PLACEHOLDER_PATTERN = /\{\{\s*([^}]+?)\s*\}\}/gu;

export const RalphPromptHighlight = ({
  value,
}: RalphPromptHighlightProps): JSX.Element => {
  const parts: JSX.Element[] = [];
  let cursor = 0;

  for (const match of value.matchAll(PLACEHOLDER_PATTERN)) {
    const index = match.index ?? 0;
    const raw = match[0] ?? "";

    if (index > cursor) {
      parts.push(<span key={`text-${cursor}`}>{value.slice(cursor, index)}</span>);
    }

    parts.push(
      <span
        key={`var-${index}`}
        className="rounded bg-emerald-500/15 px-1 py-0.5 font-semibold text-emerald-200"
      >
        {raw}
      </span>,
    );
    cursor = index + raw.length;
  }

  if (cursor < value.length) {
    parts.push(<span key={`text-${cursor}`}>{value.slice(cursor)}</span>);
  }

  return <>{parts}</>;
};
