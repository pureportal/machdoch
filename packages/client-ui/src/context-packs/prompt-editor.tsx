import { useState, type JSX } from "react";
import "./prompt-editor.css";

const CONTEXT_PACK_INLINE_TOKEN_PATTERN =
  /\{[A-Za-z][A-Za-z0-9_-]{0,39}\}|`[^`\n]+`/gu;
const CONTEXT_PACK_HEADING_PATTERN = /^#{1,6}\s+\S/u;

const ContextPackPromptHighlight = ({
  value,
}: {
  value: string;
}): JSX.Element => {
  const lines = value.split("\n");
  const parts: JSX.Element[] = [];

  lines.forEach((line, lineIndex) => {
    if (CONTEXT_PACK_HEADING_PATTERN.test(line)) {
      parts.push(
        <span key={`heading-${lineIndex}`} className="app-pack-prompt-heading">
          {line}
        </span>,
      );
    } else {
      let cursor = 0;

      for (const match of line.matchAll(CONTEXT_PACK_INLINE_TOKEN_PATTERN)) {
        const index = match.index ?? 0;
        const raw = match[0] ?? "";

        if (index > cursor) {
          parts.push(
            <span key={`text-${lineIndex}-${cursor}`}>
              {line.slice(cursor, index)}
            </span>,
          );
        }

        const isVariable =
          raw.startsWith("{") &&
          line[index - 1] !== "{" &&
          line[index + raw.length] !== "}";

        if (isVariable) {
          parts.push(
            <span
              key={`variable-${lineIndex}-${index}`}
              className="app-pack-prompt-variable"
            >
              {raw}
            </span>,
          );
        } else if (raw.startsWith("`")) {
          parts.push(
            <span
              key={`code-${lineIndex}-${index}`}
              className="app-pack-prompt-code"
            >
              {raw}
            </span>,
          );
        } else {
          parts.push(<span key={`raw-${lineIndex}-${index}`}>{raw}</span>);
        }

        cursor = index + raw.length;
      }

      if (cursor < line.length) {
        parts.push(
          <span key={`text-${lineIndex}-${cursor}`}>{line.slice(cursor)}</span>,
        );
      }
    }

    if (lineIndex < lines.length - 1) {
      parts.push(<span key={`newline-${lineIndex}`}>{"\n"}</span>);
    }
  });

  return <>{parts.length > 0 ? parts : " "}</>;
};

export const ContextPackPromptEditor = ({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
}): JSX.Element => {
  const [scrollTop, setScrollTop] = useState(0);

  return (
    <div className="app-pack-prompt-editor">
      <pre aria-hidden="true" className="app-pack-prompt-highlight">
        <span
          className="app-pack-prompt-lines"
          style={{ transform: `translateY(-${scrollTop}px)` }}
        >
          <ContextPackPromptHighlight value={value || " "} />
        </span>
      </pre>
      <textarea
        id={id}
        value={value}
        spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        className="app-pack-prompt-input"
      />
    </div>
  );
};
