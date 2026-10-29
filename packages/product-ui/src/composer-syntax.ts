export interface ComposerToken {
  text: string;
  kind?: "command" | "link" | "code" | "heading" | "emphasis" | "list";
}

export function tokenizeComposer(value: string): ComposerToken[] {
  const pattern =
    /```[^\n]*\n[\s\S]*?(?:```|(?![\s\S]))|`[^`\n]+`|^\s*\/[a-z][\w-]*(?=\s|$)|https?:\/\/[^\s<>`]+|\*\*[^*\n]+\*\*|__[^_\n]+__|^#{1,6}(?=\s)[^\n]*|^(?:[-*+] |\d+\. )/gim;
  const tokens: ComposerToken[] = [];
  let offset = 0;
  for (const match of value.matchAll(pattern)) {
    if (match.index > offset)
      tokens.push({ text: value.slice(offset, match.index) });
    let text = match[0];
    const trimmed = text.trimStart();
    const kind = trimmed.startsWith("`")
      ? "code"
      : trimmed.startsWith("/")
        ? "command"
        : /^https?:/i.test(trimmed)
          ? "link"
          : trimmed.startsWith("#")
            ? "heading"
            : /^(?:\*\*|__)/.test(trimmed)
              ? "emphasis"
              : "list";
    if (kind === "link") {
      text = text.replace(/[.,!?;:]+$/, "");
      while (
        text.endsWith(")") &&
        (text.match(/\)/g)?.length ?? 0) > (text.match(/\(/g)?.length ?? 0)
      )
        text = text.slice(0, -1);
    }
    tokens.push({ text, kind });
    offset = match.index + text.length;
  }
  if (offset < value.length) tokens.push({ text: value.slice(offset) });
  return tokens;
}
