export const clampRalphGenerationInterviewMaxTurns = (
  value: number | undefined,
  defaults: { defaultMaxTurns: number; maxTurns: number },
): number => {
  if (value === undefined || !Number.isInteger(value)) {
    return defaults.defaultMaxTurns;
  }

  return Math.min(Math.max(value, 1), defaults.maxTurns);
};
