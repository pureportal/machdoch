import { runDocumentSchema, type RunDocument } from "@machdoch/fleet-protocol";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const renameField = (
  object: Record<string, unknown>,
  old: string,
  current: string,
): void => {
  if (!Object.hasOwn(object, old)) return;
  if (Object.hasOwn(object, current))
    throw new Error(
      `Run configuration contains both \`${old}\` and \`${current}\`.`,
    );
  object[current] = object[old];
  delete object[old];
};

export const parseWorkspaceRunDocument = (
  input: unknown,
): { document: RunDocument; migrated: boolean } => {
  if (!isRecord(input) || input.schemaVersion !== 1)
    return { document: runDocumentSchema.parse(input), migrated: false };

  const value = structuredClone(input);
  const primaryId = value.primaryConfigurationId;
  if (
    primaryId !== undefined &&
    primaryId !== null &&
    typeof primaryId !== "string"
  )
    throw new Error("Run primaryConfigurationId must be a string or null.");
  if (!Array.isArray(value.configurations))
    throw new Error("Run configurations must be an array.");
  const configurations: unknown[] = value.configurations;
  if (
    typeof primaryId === "string" &&
    !configurations.some(
      (configuration) =>
        isRecord(configuration) && configuration.id === primaryId,
    )
  )
    throw new Error(
      `Primary run configuration \`${primaryId}\` does not exist.`,
    );

  for (const configuration of configurations) {
    if (!isRecord(configuration))
      throw new Error("Run configuration must be an object.");
    if (Object.hasOwn(configuration, "primary"))
      throw new Error("Run schemaVersion 1 cannot contain primary flags.");
    configuration.primary =
      typeof primaryId === "string" && configuration.id === primaryId;
    if (configuration.kind === "task") {
      for (const [old, current] of [
        ["working_directory", "workingDirectory"],
        ["hot_reload", "hotReload"],
        ["health_check", "healthCheck"],
        ["restart_policy", "restartPolicy"],
      ] as const)
        renameField(configuration, old, current);
      if (isRecord(configuration.healthCheck)) {
        for (const field of [
          "startupDelayMs",
          "intervalMs",
          "timeoutMs",
          "failureThreshold",
        ])
          delete configuration.healthCheck[field];
        if (!Object.hasOwn(configuration.healthCheck, "restartOnFailure"))
          configuration.healthCheck.restartOnFailure = false;
      }
    } else if (configuration.kind === "composite") {
      renameField(configuration, "start_order", "startOrder");
    } else {
      throw new Error("Run configuration kind must be task or composite.");
    }
  }
  delete value.primaryConfigurationId;
  value.schemaVersion = 2;
  return { document: runDocumentSchema.parse(value), migrated: true };
};
