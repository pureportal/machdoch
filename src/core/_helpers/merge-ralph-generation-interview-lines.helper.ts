export const mergeRalphGenerationInterviewLines = (
  current: readonly string[],
  incoming: readonly string[],
): string[] => {
  const result = [...current];
  const seen = new Set(result.map((entry) => entry.toLowerCase()));

  for (const entry of incoming) {
    const key = entry.toLowerCase();

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(entry);
  }

  return result.slice(-20);
};
