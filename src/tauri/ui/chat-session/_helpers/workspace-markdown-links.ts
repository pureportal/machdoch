const WINDOWS_DRIVE_PATH_PATTERN = /^[A-Za-z]:[\\/]/u;
const WINDOWS_EXTENDED_PREFIX_PATTERN = /^\/\/\?\/(?!UNC\/)/iu;
const WINDOWS_EXTENDED_UNC_PREFIX_PATTERN = /^\/\/\?\/UNC\//iu;
const UNC_PATH_PATTERN = /^\/\/[^/]+\/[^/]+/u;
const FILE_URL_DRIVE_PATH_PATTERN = /^\/[A-Za-z]:\//u;
const URL_PROTOCOL_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:/u;
const SOURCE_LINE_SUFFIX_PATTERN = /^(?<path>.+):\d+(?::\d+)?$/u;
const SOURCE_LINE_HASH_PATTERN = /^(?<path>.+)#L\d+(?:-L?\d+)?$/iu;
const WORKSPACE_RELATIVE_PATH_PATTERN =
  /^(?:\.\/)?(?:[\w .@()[\]-]+\/)*[\w .@()[\]-]+\.[A-Za-z0-9]{1,16}$/u;
const WORKSPACE_RELATIVE_SEGMENT_PATH_PATTERN =
  /^(?:\.\/)?(?:[^\\/#?:]+\/)+[^\\/#?:]+$/u;
const COMMON_WORKSPACE_FILE_NAME_PATTERN =
  /^(?:\.env(?:\.[\w.-]+)?|AGENTS|Containerfile|Dockerfile|Gemfile|LICENSE|Makefile|NOTICE|Procfile|README|Rakefile)(?:\.[A-Za-z0-9]+)?$/iu;

export interface WorkspaceMarkdownLinkTarget {
  relativePath: string;
}

const decodeMarkdownHref = (href: string): string => {
  try {
    return decodeURI(href);
  } catch {
    return href;
  }
};

const stripFileUrlPrefix = (href: string): string => {
  if (!href.toLowerCase().startsWith("file:")) {
    return href;
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
    .replace(WINDOWS_EXTENDED_PREFIX_PATTERN, "");
  const hasUncPrefix = UNC_PATH_PATTERN.test(normalizedPath);
  const pathWithoutDuplicateSlashes = hasUncPrefix
    ? `//${normalizedPath.slice(2).replace(/\/+/gu, "/")}`
    : normalizedPath.replace(/\/+/gu, "/");

  return pathWithoutDuplicateSlashes;
};

const trimWorkspaceRoot = (workspaceRoot: string): string =>
  normalizeLocalPath(workspaceRoot).replace(/\/+$/u, "");

const stripSourceLocation = (path: string): string => {
  const hashMatch = SOURCE_LINE_HASH_PATTERN.exec(path);

  if (hashMatch?.groups?.path) {
    return hashMatch.groups.path;
  }

  const suffixMatch = SOURCE_LINE_SUFFIX_PATTERN.exec(path);

  return suffixMatch?.groups?.path ?? path;
};

const normalizeHrefPath = (href: string): string =>
  stripSourceLocation(normalizeLocalPath(stripFileUrlPrefix(decodeMarkdownHref(href))));

const isAbsoluteLocalPath = (path: string): boolean =>
  WINDOWS_DRIVE_PATH_PATTERN.test(path) ||
  UNC_PATH_PATTERN.test(path) ||
  path.startsWith("/");

const isWorkspaceRelativePath = (path: string): boolean => {
  if (
    !path ||
    path.startsWith("#") ||
    path.startsWith("?") ||
    path.startsWith("/") ||
    path.startsWith("../") ||
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

const toWorkspaceRelativePath = (
  absolutePath: string,
  workspaceRoot: string,
): string | null => {
  const normalizedPath = normalizeLocalPath(absolutePath).replace(/\/+$/u, "");
  const normalizedRoot = trimWorkspaceRoot(workspaceRoot);

  if (!normalizedRoot) {
    return null;
  }

  const pathKey = normalizedPath.toLowerCase();
  const rootKey = normalizedRoot.toLowerCase();

  if (pathKey === rootKey) {
    return ".";
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

  const path = normalizeHrefPath(normalizedHref);

  return isAbsoluteLocalPath(path) || isWorkspaceRelativePath(path);
};

export const getWorkspaceMarkdownLinkTarget = (
  href: string | undefined,
  workspaceRoot: string | null | undefined,
): WorkspaceMarkdownLinkTarget | null => {
  const normalizedHref = href?.trim();

  if (!normalizedHref) {
    return null;
  }

  const path = normalizeHrefPath(normalizedHref);

  if (isWorkspaceRelativePath(path)) {
    return {
      relativePath: path.replace(/^\.\//u, ""),
    };
  }

  if (!workspaceRoot || !isAbsoluteLocalPath(path)) {
    return null;
  }

  const relativePath = toWorkspaceRelativePath(path, workspaceRoot);

  return relativePath ? { relativePath } : null;
};
