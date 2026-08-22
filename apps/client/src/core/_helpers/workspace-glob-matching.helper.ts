const normalizeWorkspacePath = (value: string): string => {
  const normalized = value
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/g, "")
    .replace(/\/+/g, "/")
    .replace(/\/$/, "");

  return normalized === "." ? "" : normalized;
};

const createSegmentMatcher = (patternSegment: string): RegExp => {
  let output = "^";

  for (const character of patternSegment) {
    if (character === "*") {
      output += "[^/]*";
      continue;
    }

    if (character === "?") {
      output += "[^/]";
      continue;
    }

    output += character.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  }

  output += "$";

  return new RegExp(output);
};

const segmentMatchCache = new Map<string, RegExp>();

const matchesPatternSegment = (
  patternSegment: string,
  pathSegment: string,
): boolean => {
  const cachedMatcher = segmentMatchCache.get(patternSegment);
  const matcher = cachedMatcher ?? createSegmentMatcher(patternSegment);

  if (!cachedMatcher) {
    segmentMatchCache.set(patternSegment, matcher);
  }

  return matcher.test(pathSegment);
};

const splitGlobSegments = (value: string): string[] => {
  const normalized = normalizeWorkspacePath(value);

  return normalized.length === 0 ? [] : normalized.split("/");
};

const matchGlobSegments = (
  patternSegments: string[],
  pathSegments: string[],
  patternIndex: number,
  pathIndex: number,
  memo: Map<string, boolean>,
): boolean => {
  const memoKey = `${patternIndex}:${pathIndex}`;
  const cached = memo.get(memoKey);

  if (cached !== undefined) {
    return cached;
  }

  if (patternIndex === patternSegments.length) {
    const result = pathIndex === pathSegments.length;
    memo.set(memoKey, result);
    return result;
  }

  const patternSegment = patternSegments[patternIndex];

  if (patternSegment === undefined) {
    memo.set(memoKey, false);
    return false;
  }

  if (patternSegment === "**") {
    if (patternIndex === patternSegments.length - 1) {
      memo.set(memoKey, true);
      return true;
    }

    for (
      let nextPathIndex = pathIndex;
      nextPathIndex <= pathSegments.length;
      nextPathIndex += 1
    ) {
      if (
        matchGlobSegments(
          patternSegments,
          pathSegments,
          patternIndex + 1,
          nextPathIndex,
          memo,
        )
      ) {
        memo.set(memoKey, true);
        return true;
      }
    }

    memo.set(memoKey, false);
    return false;
  }

  const pathSegment = pathSegments[pathIndex];

  if (
    pathSegment === undefined ||
    !matchesPatternSegment(patternSegment, pathSegment)
  ) {
    memo.set(memoKey, false);
    return false;
  }

  const result = matchGlobSegments(
    patternSegments,
    pathSegments,
    patternIndex + 1,
    pathIndex + 1,
    memo,
  );

  memo.set(memoKey, result);
  return result;
};

/**
 * Matches a workspace-relative path against a workspace-root-relative glob.
 * Supports the common `*`, `**`, and `?` glob syntax used by instruction files.
 */
export const matchesWorkspaceGlob = (
  workspacePath: string,
  pattern: string,
): boolean => {
  const patternSegments = splitGlobSegments(pattern);
  const pathSegments = splitGlobSegments(workspacePath);

  if (patternSegments.length === 0) {
    return pathSegments.length === 0;
  }

  return matchGlobSegments(
    patternSegments,
    pathSegments,
    0,
    0,
    new Map<string, boolean>(),
  );
};
