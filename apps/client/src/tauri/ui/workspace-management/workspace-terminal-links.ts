export interface TerminalFileLink {
  start: number;
  end: number;
  path: string;
  line: number | null;
  column: number | null;
}

export type ResolvedTerminalLink =
  | { relativePath: string }
  | { absolutePath: string };

const FILE_LINK =
  /(?<![\w/\\.:-])((?:[a-zA-Z]:[\\/]|\.{1,2}[\\/]|[\\/])?(?:[\w@.+-]+[\\/])*[\w@+-][\w@.+-]*\.[a-zA-Z0-9]{1,10})(?::(\d+)(?::(\d+))?|\((\d+)(?:,\s*(\d+))?\))?/gu;

const positive = (value: string | undefined): number | null => {
  const parsed = Number(value);
  return value !== undefined && Number.isInteger(parsed) && parsed > 0
    ? parsed
    : null;
};

const insideUrl = (text: string, start: number): boolean => {
  const tokenStart =
    Math.max(
      text.lastIndexOf(" ", start - 1),
      text.lastIndexOf("\t", start - 1),
    ) + 1;
  return text.slice(tokenStart, start).includes("://");
};

export const findTerminalFileLinks = (text: string): TerminalFileLink[] => {
  const links: TerminalFileLink[] = [];
  for (const match of text.matchAll(FILE_LINK)) {
    const [whole, path = "", line, column, parenLine, parenColumn] = match;
    const start = match.index ?? 0;
    if (insideUrl(text, start) || /^v?\d+(\.\d+)+$/iu.test(path)) continue;
    links.push({
      start,
      end: start + whole.length,
      path,
      line: positive(line ?? parenLine),
      column: positive(column ?? parenColumn),
    });
  }
  return links;
};

const isAbsolute = (path: string): boolean =>
  /^(?:[a-zA-Z]:[\\/]|[\\/])/u.test(path);

const slashes = (path: string): string =>
  path.replaceAll("\\", "/").replace(/\/+$/u, "");

const normalizeSegments = (path: string): string => {
  const prefix = /^(?:[a-zA-Z]:)?\//u.exec(path)?.[0] ?? "";
  const parts: string[] = [];
  for (const part of path.slice(prefix.length).split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `${prefix}${parts.join("/")}`;
};

export const resolveTerminalLinkPath = (
  link: Pick<TerminalFileLink, "path">,
  workspaceRoot: string,
  cwd: string | null,
): ResolvedTerminalLink | null => {
  const root = slashes(workspaceRoot);
  const base = slashes(cwd ?? workspaceRoot);
  const absolute = normalizeSegments(
    isAbsolute(link.path)
      ? slashes(link.path)
      : `${base}/${slashes(link.path)}`,
  );
  const windows = /^[a-zA-Z]:\//u.test(root);
  const comparable = (value: string) => (windows ? value.toLowerCase() : value);
  if (comparable(absolute).startsWith(comparable(`${root}/`))) {
    const relativePath = absolute.slice(root.length + 1);
    return relativePath ? { relativePath } : null;
  }
  return isAbsolute(absolute) ? { absolutePath: absolute } : null;
};
