export interface SelectionModifiers {
  toggle: boolean;
  range: boolean;
}

export interface FileSelection {
  paths: ReadonlySet<string>;
  anchor: string | null;
}

export const EMPTY_FILE_SELECTION: FileSelection = {
  paths: new Set(),
  anchor: null,
};

export const selectFilePath = (
  selection: FileSelection,
  path: string,
  orderedPaths: readonly string[],
  { toggle, range }: SelectionModifiers,
): FileSelection => {
  if (range && selection.anchor) {
    const from = orderedPaths.indexOf(selection.anchor);
    const to = orderedPaths.indexOf(path);
    if (from >= 0 && to >= 0) {
      const [start, end] = from < to ? [from, to] : [to, from];
      const spanned = orderedPaths.slice(start, end + 1);
      return {
        paths: new Set(toggle ? [...selection.paths, ...spanned] : spanned),
        anchor: selection.anchor,
      };
    }
  }
  if (toggle) {
    const paths = new Set(selection.paths);
    if (paths.has(path)) paths.delete(path);
    else paths.add(path);
    return { paths, anchor: path };
  }
  return { paths: new Set([path]), anchor: path };
};

const isInside = (path: string, directory: string): boolean =>
  directory === "." || path === directory || path.startsWith(`${directory}/`);

export const topLevelPaths = (paths: Iterable<string>): string[] => {
  const sorted = [...new Set(paths)].sort(
    (left, right) => left.length - right.length,
  );
  const result: string[] = [];
  for (const path of sorted) {
    if (!result.some((parent) => path.startsWith(`${parent}/`))) {
      result.push(path);
    }
  }
  return result;
};

const parentOf = (path: string): string => {
  const separator = path.lastIndexOf("/");
  return separator < 0 ? "." : path.slice(0, separator);
};

export const canMoveInto = (
  sources: readonly string[],
  targetDirectory: string,
): boolean =>
  sources.length > 0 &&
  sources.every(
    (source) =>
      !isInside(targetDirectory, source) &&
      parentOf(source) !== targetDirectory,
  );

export const remapPathAfterMove = (
  path: string,
  source: string,
  destination: string,
): string =>
  path === source || path.startsWith(`${source}/`)
    ? `${destination}${path.slice(source.length)}`
    : path;

export const uploadTargetPath = (
  directory: string,
  fileName: string,
): string => (directory === "." ? fileName : `${directory}/${fileName}`);
