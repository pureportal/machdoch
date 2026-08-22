export const FLOW_FILE_EXTENSION = ".json";

export const FLOW_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,79}$/u;
const REVISION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/u;

export const normalizeFlowId = (value: string): string => {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80);
};

export const normalizeFlowAlias = normalizeFlowId;

export const normalizeFlowFileName = (id: string): string => {
  const normalizedId = normalizeFlowId(id);

  if (!normalizedId || !FLOW_ID_PATTERN.test(normalizedId)) {
    throw new Error(
      "Expected Ralph flow id to contain lowercase letters, numbers, and dashes.",
    );
  }

  return `${normalizedId}${FLOW_FILE_EXTENSION}`;
};

export const normalizeRevisionId = (value: string): string => {
  const revisionId = value.trim().replace(/\.json$/iu, "");

  if (!revisionId || !REVISION_ID_PATTERN.test(revisionId)) {
    throw new Error(
      "Expected Ralph revision id to contain letters, numbers, dashes, underscores, colons, or periods.",
    );
  }

  return revisionId;
};

export const normalizeRunId = (value: string): string => {
  const runId = value
    .trim()
    .replace(/\.json$/iu, "")
    .replace(/[\\/]+/gu, "-")
    .replace(/[^A-Za-z0-9_.:-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 180);

  if (!runId) {
    throw new Error("Expected a Ralph run id.");
  }

  return runId;
};
