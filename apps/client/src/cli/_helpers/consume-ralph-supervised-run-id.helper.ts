export const consumeRalphSupervisedRunId = (
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined => {
  const id = environment.MACHDOCH_RALPH_RUN_ID;
  if (id === undefined) return undefined;
  if (!/^desktop-\d+-\d+-\d+$/u.test(id)) {
    throw new Error("Invalid supervised RALPH run identifier.");
  }
  delete environment.MACHDOCH_RALPH_RUN_ID;
  return id;
};
