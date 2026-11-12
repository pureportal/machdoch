export interface TextSelection {
  start: number;
  end: number;
}

export interface TextEdit {
  from: number;
  to: number;
  insert: string;
  selection: TextSelection;
}

export type InlineFormat = "bold" | "italic" | "strike" | "code";
export type LineFormat = "heading" | "bullet" | "number" | "task" | "quote";

const inlineMarkers: Record<InlineFormat, string> = {
  bold: "**",
  italic: "_",
  strike: "~~",
  code: "`",
};

const linePatterns: Record<LineFormat, RegExp> = {
  heading: /^#{1,6} /,
  task: /^[-*+] \[[ xX]\] /,
  bullet: /^[-*+] (?!\[[ xX]\] )/,
  number: /^\d+[.)] /,
  quote: /^> ?/,
};

const blockPrefix = /^(#{1,6} |[-*+] \[[ xX]\] |[-*+] |\d+[.)] |> ?)/;
const listItem = /^(\s*)([-*+] \[[ xX]\] |[-*+] |\d+[.)] |> )/;
const urlPattern = /^https?:\/\/\S+$/;

export function toggleInline(
  text: string,
  selection: TextSelection,
  format: InlineFormat,
): TextEdit {
  const marker = inlineMarkers[format];
  const { start, end } = selection;
  const selected = text.slice(start, end);
  const outerStart = start - marker.length;
  if (
    outerStart >= 0 &&
    text.slice(outerStart, start) === marker &&
    text.slice(end, end + marker.length) === marker
  )
    return {
      from: outerStart,
      to: end + marker.length,
      insert: selected,
      selection: { start: outerStart, end: outerStart + selected.length },
    };
  if (
    selected.length >= marker.length * 2 &&
    selected.startsWith(marker) &&
    selected.endsWith(marker)
  ) {
    const inner = selected.slice(marker.length, -marker.length);
    return {
      from: start,
      to: end,
      insert: inner,
      selection: { start, end: start + inner.length },
    };
  }
  return {
    from: start,
    to: end,
    insert: `${marker}${selected}${marker}`,
    selection: {
      start: start + marker.length,
      end: end + marker.length,
    },
  };
}

function lineBounds(text: string, selection: TextSelection) {
  const end =
    selection.end > selection.start && text[selection.end - 1] === "\n"
      ? selection.end - 1
      : selection.end;
  const from = text.lastIndexOf("\n", selection.start - 1) + 1;
  const lineEnd = text.indexOf("\n", end);
  return { from, to: lineEnd === -1 ? text.length : lineEnd };
}

export function toggleLines(
  text: string,
  selection: TextSelection,
  format: LineFormat,
): TextEdit {
  const { from, to } = lineBounds(text, selection);
  const lines = text.slice(from, to).split("\n");
  const content = lines.filter((line) => line.trim());
  const active =
    content.length > 0 &&
    content.every((line) => linePatterns[format].test(line));
  let number = 0;
  const insert = lines
    .map((line) => {
      if (active) return line.replace(linePatterns[format], "");
      if (!line.trim() && lines.length > 1) return line;
      const bare = format === "quote" ? line : line.replace(blockPrefix, "");
      number += 1;
      const prefix = {
        heading: "## ",
        bullet: "- ",
        number: `${number}. `,
        task: "- [ ] ",
        quote: "> ",
      }[format];
      return `${prefix}${bare}`;
    })
    .join("\n");
  return {
    from,
    to,
    insert,
    selection:
      selection.start === selection.end && lines.length === 1
        ? { start: from + insert.length, end: from + insert.length }
        : { start: from, end: from + insert.length },
  };
}

export function insertLink(text: string, selection: TextSelection): TextEdit {
  const selected = text.slice(selection.start, selection.end);
  const label = selected || "link";
  const insert = `[${label}](https://)`;
  const urlStart = selection.start + label.length + 3;
  return {
    from: selection.start,
    to: selection.end,
    insert,
    selection: selected
      ? { start: urlStart, end: urlStart + "https://".length }
      : { start: selection.start + 1, end: selection.start + 1 + label.length },
  };
}

export function pasteLink(
  text: string,
  selection: TextSelection,
  pasted: string,
): TextEdit | null {
  const url = pasted.trim();
  const selected = text.slice(selection.start, selection.end);
  if (
    !selected.trim() ||
    selected.includes("\n") ||
    !urlPattern.test(url) ||
    urlPattern.test(selected.trim())
  )
    return null;
  const insert = `[${selected}](${url})`;
  const caret = selection.start + insert.length;
  return {
    from: selection.start,
    to: selection.end,
    insert,
    selection: { start: caret, end: caret },
  };
}

export function continueList(
  text: string,
  selection: TextSelection,
): TextEdit | null {
  if (selection.start !== selection.end) return null;
  const caret = selection.start;
  const from = text.lastIndexOf("\n", caret - 1) + 1;
  const lineEnd = text.indexOf("\n", caret);
  const to = lineEnd === -1 ? text.length : lineEnd;
  const line = text.slice(from, to);
  const match = listItem.exec(line);
  if (!match) return null;
  const [prefix, indent = "", marker = ""] = match;
  if (caret < from + prefix.length) return null;
  if (!line.slice(prefix.length).trim()) {
    const insert = indent || "\n";
    return {
      from,
      to,
      insert,
      selection: { start: from + insert.length, end: from + insert.length },
    };
  }
  const ordered = /^(\d+)([.)]) $/.exec(marker);
  const next = ordered
    ? `${Number(ordered[1]) + 1}${ordered[2]} `
    : marker.replace(/\[[xX]\]/, "[ ]");
  const insert = `\n${indent}${next}`;
  return {
    from: caret,
    to: caret,
    insert,
    selection: { start: caret + insert.length, end: caret + insert.length },
  };
}
