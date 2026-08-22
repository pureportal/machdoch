export const normalizeStringList = (
  values: readonly string[] | undefined,
): string[] => {
  return Array.from(
    new Set(
      (values ?? [])
        .map((value) => value.trim())
        .filter((value) => value.length > 0),
    ),
  );
};
