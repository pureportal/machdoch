export const getFilePreviewTargetLineIndex = (
  targetLine: number | null | undefined,
  lineCount: number,
): number | null => {
  if (
    !Number.isSafeInteger(targetLine) ||
    !targetLine ||
    targetLine < 1 ||
    targetLine > lineCount
  ) {
    return null;
  }

  return targetLine - 1;
};

export const scrollFilePreviewTargetLineIntoView = (
  target: Pick<HTMLElement, "scrollIntoView"> | null,
): boolean => {
  if (!target || typeof target.scrollIntoView !== "function") {
    return false;
  }

  target.scrollIntoView({
    block: "center",
    inline: "nearest",
  });

  return true;
};
