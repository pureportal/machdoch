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
const PATH_SAFETY_ESCAPE_PATTERN = /%(?:2e|2f|5c)/giu;

export interface WorkspaceMarkdownLinkTarget {
  relativePath: string;
}

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
  stripSourceLocation(normalizeLocalPath(decodeMarkdownHref(stripFileUrlPrefix(href))));

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

  const path = normalizeHrefPath(normalizedHref);

  const openableRelativePath = toOpenableWorkspaceRelativePath(path);

  if (openableRelativePath) {
    return { relativePath: openableRelativePath };
  }

  if (!workspaceRoot || !isAbsoluteLocalPath(path)) {
    return null;
  }

  const relativePath = toWorkspaceRelativePath(path, workspaceRoot);

  if (!relativePath || hasUnsafeWorkspacePathSegment(relativePath)) {
    return null;
  }

  return { relativePath };
};
