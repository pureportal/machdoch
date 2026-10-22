import { useState, type JSX } from "react";

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
        <span
          key={`heading-${lineIndex}`}
          className="font-semibold text-cyan-200"
        >
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
              className="rounded bg-emerald-500/15 px-1 py-0.5 font-semibold text-emerald-200"
            >
              {raw}
            </span>,
          );
        } else if (raw.startsWith("`")) {
          parts.push(
            <span
              key={`code-${lineIndex}-${index}`}
              className="text-violet-200"
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
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}): JSX.Element => {
  const [scrollTop, setScrollTop] = useState(0);

  return (
    <div className="group/prompt-editor relative min-h-52 overflow-hidden rounded-xl border border-slate-800 bg-slate-900/70">
      <pre
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 m-0 overflow-hidden whitespace-pre-wrap break-words px-3 py-2 font-mono text-sm leading-6 text-slate-300 group-focus-within/prompt-editor:invisible"
      >
        <span
          className="block"
          style={{ transform: `translateY(-${scrollTop}px)` }}
        >
          <ContextPackPromptHighlight value={value || " "} />
        </span>
      </pre>
      <textarea
        aria-label="Prompt"
        value={value}
        spellCheck={false}
        placeholder="Review {target_file} and summarize release risk."
        onChange={(event) => onChange(event.target.value)}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        className="absolute inset-0 min-h-52 w-full resize-none overflow-auto rounded-xl border-0 bg-transparent px-3 py-2 font-mono text-sm leading-6 text-transparent caret-slate-100 outline-none placeholder:font-sans placeholder:text-slate-600 selection:bg-sky-500/35 selection:text-slate-100 focus:text-slate-300 focus:ring-1 focus:ring-sky-500/30"
      />
    </div>
  );
};
