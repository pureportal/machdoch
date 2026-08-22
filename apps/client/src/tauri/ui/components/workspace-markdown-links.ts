const WINDOWS_DRIVE_PATH_PATTERN = /^[A-Za-z]:[\\/]/u;
const WINDOWS_URI_DRIVE_PATH_PATTERN = /^\/(?=[A-Za-z]:\/)/u;
const WINDOWS_EXTENDED_PREFIX_PATTERN = /^\/\/\?\/(?!UNC\/)/iu;
const WINDOWS_EXTENDED_UNC_PREFIX_PATTERN = /^\/\/\?\/UNC\//iu;
const UNC_PATH_PATTERN = /^\/\/[^/]+\/[^/]+/u;
const FILE_URL_DRIVE_PATH_PATTERN = /^\/[A-Za-z]:\//u;
const URL_PROTOCOL_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:/u;
const SOURCE_LINE_SUFFIX_PATTERN =
  /^(?<path>.+?):(?<line>[1-9]\d*)(?::(?<column>[1-9]\d*))?$/u;
const SOURCE_LINE_HASH_PATTERN =
  /^(?<path>.+)#L(?<line>[1-9]\d*)(?:C(?<column>[1-9]\d*))?(?:-L?[1-9]\d*(?:C[1-9]\d*)?)?$/iu;
const WORKSPACE_RELATIVE_PATH_PATTERN =
  /^(?:\.\/)?(?:[\w .@()[\]-]+\/)*[\w .@()[\]-]+\.[A-Za-z0-9]{1,16}$/u;
const WORKSPACE_RELATIVE_SEGMENT_PATH_PATTERN =
  /^(?:\.\/)?(?:[^\\/#?:]+\/)+[^\\/#?:]+$/u;
const COMMON_WORKSPACE_FILE_NAME_PATTERN =
  /^(?:\.env(?:\.[\w.-]+)?|AGENTS|Containerfile|Dockerfile|Gemfile|LICENSE|Makefile|NOTICE|Procfile|README|Rakefile)(?:\.[A-Za-z0-9]+)?$/iu;
const PATH_SAFETY_ESCAPE_PATTERN = /%(?:2e|2f|5c)/giu;
const MARKDOWN_TEXT_TOKEN_PATTERN = /\S+/gu;
const PATH_TOKEN_LEADING_PUNCTUATION_PATTERN = /^[([{"'<]+/u;
const PATH_TOKEN_TRAILING_PUNCTUATION_PATTERN = /[)\]}>"',;!?.]+$/u;

export interface WorkspaceMarkdownLinkTarget {
  relativePath: string;
  line?: number;
  column?: number;
}

export type WorkspaceMarkdownLinkOpenHandler = (
  relativePath: string,
  line?: number,
) => void;

interface SourceLocation {
  path: string;
  line?: number;
  column?: number;
}

interface MarkdownAstNode {
  type: string;
  value?: string;
  url?: string;
  children?: MarkdownAstNode[];
}

type WorkspacePathLinkRemarkPlugin = () => (tree: MarkdownAstNode) => void;

const decodeMarkdownHref = (href: string): string => {
  try {
    return decodeURIComponent(href);
  } catch {
    return href.replace(PATH_SAFETY_ESCAPE_PATTERN, (escape) =>
      decodeURIComponent(escape),
    );
  }
};

const stripFileUrlSearchAndHash = (path: string): string =>
  path.replace(/[?#].*$/u, "");

const getRawFileUrlPath = (href: string): string => {
  const pathWithAuthority = href.slice("file:".length);

  if (!pathWithAuthority.startsWith("//")) {
    return stripFileUrlSearchAndHash(pathWithAuthority);
  }

  const slashAfterAuthority = pathWithAuthority.indexOf("/", 2);

  if (slashAfterAuthority === 2) {
    return stripFileUrlSearchAndHash(pathWithAuthority.slice(2));
  }

  if (slashAfterAuthority === -1) {
    return "";
  }

  const authority = pathWithAuthority.slice(2, slashAfterAuthority);
  const path = stripFileUrlSearchAndHash(
    pathWithAuthority.slice(slashAfterAuthority),
  );

  return authority && authority.toLowerCase() !== "localhost"
    ? `//${authority}${path}`
    : path;
};

const stripFileUrlPrefix = (href: string): string => {
  if (!href.toLowerCase().startsWith("file:")) {
    return href;
  }

  const rawFilePath = getRawFileUrlPath(href);

  if (
    hasUnsafeWorkspacePathSegment(
      normalizeLocalPath(decodeMarkdownHref(rawFilePath)),
    )
  ) {
    return rawFilePath;
  }

  try {
    const parsedUrl = new URL(href);
    const pathname = decodeURIComponent(parsedUrl.pathname);

    return FILE_URL_DRIVE_PATH_PATTERN.test(pathname)
      ? pathname.slice(1)
      : pathname;
  } catch {
    return href;
  }
};

const normalizeLocalPath = (path: string): string => {
  const normalizedPath = path
    .trim()
    .replace(/\\/gu, "/")
    .replace(WINDOWS_EXTENDED_UNC_PREFIX_PATTERN, "//")
    .replace(WINDOWS_EXTENDED_PREFIX_PATTERN, "")
    .replace(WINDOWS_URI_DRIVE_PATH_PATTERN, "");
  const hasUncPrefix = UNC_PATH_PATTERN.test(normalizedPath);
  const pathWithoutDuplicateSlashes = hasUncPrefix
    ? `//${normalizedPath.slice(2).replace(/\/+/gu, "/")}`
    : normalizedPath.replace(/\/+/gu, "/");

  return pathWithoutDuplicateSlashes;
};

const trimWorkspaceRoot = (workspaceRoot: string): string => {
  const normalizedRoot = normalizeLocalPath(workspaceRoot);

  return normalizedRoot === "/"
    ? normalizedRoot
    : normalizedRoot.replace(/\/+$/u, "");
};

const parseSourceLocationMatch = (
  match: RegExpExecArray | null,
): SourceLocation | null => {
  const path = match?.groups?.path;
  const line = Number(match?.groups?.line);
  const column = Number(match?.groups?.column);

  if (!path || !Number.isSafeInteger(line) || line < 1) {
    return null;
  }

  return {
    path,
    line,
    ...(Number.isSafeInteger(column) && column > 0 ? { column } : {}),
  };
};

const parseSourceLocation = (href: string): SourceLocation => {
  const hashLocation = parseSourceLocationMatch(
    SOURCE_LINE_HASH_PATTERN.exec(href),
  );

  if (hashLocation) {
    return hashLocation;
  }

  return (
    parseSourceLocationMatch(SOURCE_LINE_SUFFIX_PATTERN.exec(href)) ?? {
      path: href,
    }
  );
};

const normalizeHrefTarget = (href: string): SourceLocation => {
  const sourceLocation = parseSourceLocation(href);
  const normalizedPath = normalizeLocalPath(
    decodeMarkdownHref(
      stripFileUrlSearchAndHash(stripFileUrlPrefix(sourceLocation.path)),
    ),
  );

  return sourceLocation.line
    ? {
        ...sourceLocation,
        path: normalizedPath,
      }
    : parseSourceLocation(normalizedPath);
};

const isAbsoluteLocalPath = (path: string): boolean =>
  WINDOWS_DRIVE_PATH_PATTERN.test(path) ||
  UNC_PATH_PATTERN.test(path) ||
  path.startsWith("/");

const hasUnsafeWorkspacePathSegment = (path: string): boolean =>
  path.split("/").some((segment) => segment === "." || segment === "..");

const isWorkspaceRelativePathLike = (path: string): boolean => {
  if (
    !path ||
    path.startsWith("#") ||
    path.startsWith("?") ||
    path.startsWith("/") ||
    URL_PROTOCOL_PATTERN.test(path)
  ) {
    return false;
  }

  return (
    WORKSPACE_RELATIVE_PATH_PATTERN.test(path) ||
    WORKSPACE_RELATIVE_SEGMENT_PATH_PATTERN.test(path) ||
    COMMON_WORKSPACE_FILE_NAME_PATTERN.test(path)
  );
};

const toOpenableWorkspaceRelativePath = (path: string): string | null => {
  if (!isWorkspaceRelativePathLike(path)) {
    return null;
  }

  const relativePath = path.replace(/^\.\//u, "");

  if (hasUnsafeWorkspacePathSegment(relativePath)) {
    return null;
  }

  return relativePath;
};

const toWorkspaceRelativePath = (
  absolutePath: string,
  workspaceRoot: string,
): string | null => {
  const normalizedPath = normalizeLocalPath(absolutePath).replace(/\/+$/u, "");
  const normalizedRoot = trimWorkspaceRoot(workspaceRoot);

  if (!normalizedRoot) {
    return null;
  }

  const caseInsensitive =
    WINDOWS_DRIVE_PATH_PATTERN.test(normalizedRoot) ||
    UNC_PATH_PATTERN.test(normalizedRoot);
  const pathKey = caseInsensitive
    ? normalizedPath.toLowerCase()
    : normalizedPath;
  const rootKey = caseInsensitive
    ? normalizedRoot.toLowerCase()
    : normalizedRoot;

  if (pathKey === rootKey) {
    return ".";
  }

  if (rootKey === "/") {
    return pathKey.startsWith("/") ? normalizedPath.slice(1) : null;
  }

  if (!pathKey.startsWith(`${rootKey}/`)) {
    return null;
  }

  return normalizedPath.slice(normalizedRoot.length + 1);
};

export const isLocalMarkdownLinkHref = (href: string | undefined): boolean => {
  const normalizedHref = href?.trim();

  if (!normalizedHref) {
    return false;
  }

  const { path } = normalizeHrefTarget(normalizedHref);

  return isAbsoluteLocalPath(path) || isWorkspaceRelativePathLike(path);
};

export const getWorkspaceMarkdownLinkTarget = (
  href: string | undefined,
  workspaceRoot: string | null | undefined,
): WorkspaceMarkdownLinkTarget | null => {
  const normalizedHref = href?.trim();

  if (!normalizedHref) {
    return null;
  }

  const { path, line, column } = normalizeHrefTarget(normalizedHref);
  const sourceLocation = {
    ...(line ? { line } : {}),
    ...(column ? { column } : {}),
  };

  const openableRelativePath = toOpenableWorkspaceRelativePath(path);

  if (openableRelativePath) {
    return {
      relativePath: openableRelativePath,
      ...sourceLocation,
    };
  }

  if (!workspaceRoot || !isAbsoluteLocalPath(path)) {
    return null;
  }

  const relativePath = toWorkspaceRelativePath(path, workspaceRoot);

  if (!relativePath || hasUnsafeWorkspacePathSegment(relativePath)) {
    return null;
  }

  return {
    relativePath,
    ...sourceLocation,
  };
};

export const openWorkspaceMarkdownLinkTarget = (
  target: WorkspaceMarkdownLinkTarget,
  onOpen: WorkspaceMarkdownLinkOpenHandler,
): void => {
  onOpen(target.relativePath, target.line);
};

const isStrongTextPathCandidate = (href: string): boolean => {
  const { path } = normalizeHrefTarget(href);

  if (isAbsoluteLocalPath(path)) {
    return true;
  }

  if (href.startsWith("./") || href.startsWith(".\\")) {
    return true;
  }

  return (
    (path.includes("/") && WORKSPACE_RELATIVE_PATH_PATTERN.test(path)) ||
    COMMON_WORKSPACE_FILE_NAME_PATTERN.test(path)
  );
};

const trimPathToken = (
  value: string,
): { path: string; leadingLength: number; trailingLength: number } => {
  const leadingLength =
    PATH_TOKEN_LEADING_PUNCTUATION_PATTERN.exec(value)?.[0].length ?? 0;
  const withoutLeadingPunctuation = value.slice(leadingLength);
  const trailingLength =
    PATH_TOKEN_TRAILING_PUNCTUATION_PATTERN.exec(withoutLeadingPunctuation)?.[0]
      .length ?? 0;
  const path = withoutLeadingPunctuation.slice(
    0,
    trailingLength > 0 ? -trailingLength : undefined,
  );

  return {
    path,
    leadingLength,
    trailingLength: value.length - leadingLength - path.length,
  };
};

const createWorkspacePathLinkedTextNodes = (
  value: string,
  workspaceRoot: string | null | undefined,
): MarkdownAstNode[] => {
  const nodes: MarkdownAstNode[] = [];
  let cursor = 0;

  for (const match of value.matchAll(MARKDOWN_TEXT_TOKEN_PATTERN)) {
    const token = match[0];
    const tokenStart = match.index;
    const { path, leadingLength, trailingLength } = trimPathToken(token);
    const pathStart = tokenStart + leadingLength;
    const pathEnd = tokenStart + token.length - trailingLength;
    const workspaceTarget =
      path && isStrongTextPathCandidate(path)
        ? getWorkspaceMarkdownLinkTarget(path, workspaceRoot)
        : null;

    if (!workspaceTarget) {
      continue;
    }

    if (pathStart > cursor) {
      nodes.push({
        type: "text",
        value: value.slice(cursor, pathStart),
      });
    }

    nodes.push({
      type: "link",
      url: path,
      children: [{ type: "text", value: path }],
    });
    cursor = pathEnd;
  }

  if (cursor === 0) {
    return [{ type: "text", value }];
  }

  if (cursor < value.length) {
    nodes.push({
      type: "text",
      value: value.slice(cursor),
    });
  }

  return nodes;
};

const MARKDOWN_PATH_LINK_RECURSION_SKIP_TYPES = new Set([
  "code",
  "html",
  "inlineCode",
  "link",
  "linkReference",
]);

const linkWorkspacePathsInMarkdownNode = (
  node: MarkdownAstNode,
  workspaceRoot: string | null | undefined,
): void => {
  if (
    MARKDOWN_PATH_LINK_RECURSION_SKIP_TYPES.has(node.type) ||
    !node.children
  ) {
    return;
  }

  const nextChildren: MarkdownAstNode[] = [];

  for (const child of node.children) {
    if (child.type === "text" && typeof child.value === "string") {
      nextChildren.push(
        ...createWorkspacePathLinkedTextNodes(child.value, workspaceRoot),
      );
      continue;
    }

    linkWorkspacePathsInMarkdownNode(child, workspaceRoot);
    nextChildren.push(child);
  }

  node.children = nextChildren;
};

export const createWorkspacePathLinkRemarkPlugin = (
  workspaceRoot: string | null | undefined,
): WorkspacePathLinkRemarkPlugin => {
  return () =>
    (tree): void => {
      linkWorkspacePathsInMarkdownNode(tree, workspaceRoot);
    };
};
