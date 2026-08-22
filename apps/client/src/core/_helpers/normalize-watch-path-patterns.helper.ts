export const normalizeWatchPathPatterns = (
  values: readonly string[] | undefined,
): string[] => {
  return Array.from(
    new Set(
      (values ?? [])
        .map((value) => value.trim().replace(/\\/gu, "/"))
        .filter((value) => value.length > 0),
    ),
  );
};
