function normalize(path: string): string {
  return path.trim().replace(/^\.?\/+/u, "").replace(/\/+$/u, "");
}

function patternExpression(pattern: string): RegExp {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character === "*" && pattern[index + 1] === "*") {
      const directory = pattern[index + 2] === "/";
      source += directory ? "(?:.*/)?" : ".*";
      index += directory ? 2 : 1;
    } else if (character === "*") source += "[^/]*";
    else if (character === "?") source += "[^/]";
    else source += character.replace(/[.+^${}()|[\]\\]/gu, "\\$&");
  }
  return new RegExp(`^${source}$`, "u");
}

function candidates(path: string): string[] {
  const segments = normalize(path).split("/");
  return segments.map((_, index) => segments.slice(0, index + 1).join("/"));
}

export function pathMatcher(
  patterns: readonly string[],
): (path: string) => boolean {
  const includes: RegExp[] = [];
  const excludes: RegExp[] = [];
  for (const pattern of patterns) {
    const excluded = pattern.startsWith("!");
    const expression = patternExpression(
      normalize(excluded ? pattern.slice(1) : pattern),
    );
    (excluded ? excludes : includes).push(expression);
  }
  return (path) => {
    const paths = candidates(path);
    const included =
      includes.length === 0 ||
      includes.some((expression) =>
        paths.some((candidate) => expression.test(candidate)),
      );
    return (
      included &&
      !excludes.some((expression) =>
        paths.some((candidate) => expression.test(candidate)),
      )
    );
  };
}

export function touchesPaths(
  patterns: readonly string[],
  files: readonly string[],
): boolean {
  if (patterns.length === 0) return true;
  const matches = pathMatcher(patterns);
  return files.some(matches);
}
