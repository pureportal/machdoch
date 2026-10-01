import { createCliStyle, type CliStyle } from "./cli-terminal.js";
import { safeTerminalText } from "./cli-terminal-text.js";

export const renderTerminalMarkdown = (
  markdown: string,
  style: CliStyle = createCliStyle(),
): string => {
  const clean = safeTerminalText(markdown);
  if (!style.enabled) return clean;
  let fenced = false;
  return clean
    .split("\n")
    .map((line) => {
      if (/^\s*(```|~~~)/u.test(line)) {
        fenced = !fenced;
        return style.muted(line);
      }
      if (fenced) return style.command(line);
      const heading = /^#{1,6}\s+(.+)$/u.exec(line);
      if (heading) return style.heading(heading[1]!);
      return line
        .replace(/\*\*([^*]+)\*\*/gu, (_, value: string) => style.label(value))
        .replace(/`([^`]+)`/gu, (_, value: string) => style.command(value));
    })
    .join("\n");
};
