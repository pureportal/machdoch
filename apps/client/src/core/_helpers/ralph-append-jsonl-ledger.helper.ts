export interface RalphAppendJsonlStartedOperation {
  state: "started";
  priorSize: number;
  lineLength: number;
  lineSha256: string;
  startedAt: string;
}

export interface RalphAppendJsonlCompletedOperation extends Omit<
  RalphAppendJsonlStartedOperation,
  "state"
> {
  state: "completed";
  completedAt: string;
}

export type RalphAppendJsonlOperation =
  | RalphAppendJsonlStartedOperation
  | RalphAppendJsonlCompletedOperation;

export interface RalphAppendJsonlLedger {
  schemaVersion: 1;
  operations: Record<string, RalphAppendJsonlOperation>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isSha256 = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);

const parseOperation = (
  value: unknown,
): RalphAppendJsonlOperation | undefined => {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.priorSize) ||
    (value.priorSize as number) < 0 ||
    !Number.isSafeInteger(value.lineLength) ||
    (value.lineLength as number) < 1 ||
    !isSha256(value.lineSha256) ||
    typeof value.startedAt !== "string"
  ) {
    return undefined;
  }

  const operation = {
    priorSize: value.priorSize as number,
    lineLength: value.lineLength as number,
    lineSha256: value.lineSha256,
    startedAt: value.startedAt,
  };

  if (value.state === "started") {
    return { state: value.state, ...operation };
  }
  if (value.state === "completed" && typeof value.completedAt === "string") {
    return {
      state: value.state,
      ...operation,
      completedAt: value.completedAt,
    };
  }
  return undefined;
};

export const parseRalphAppendJsonlLedger = (
  value: unknown,
): RalphAppendJsonlLedger | undefined => {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !isRecord(value.operations)
  ) {
    return undefined;
  }

  const operations = Object.entries(value.operations).flatMap(
    ([operationId, candidate]): Array<[string, RalphAppendJsonlOperation]> => {
      const operation = parseOperation(candidate);
      return operation ? [[operationId, operation]] : [];
    },
  );
  return operations.length === Object.keys(value.operations).length
    ? { schemaVersion: 1, operations: Object.fromEntries(operations) }
    : undefined;
};

export const createRalphAppendJsonlLedger = (
  operations: Readonly<Record<string, RalphAppendJsonlOperation>>,
  limit = 2_000,
): RalphAppendJsonlLedger => ({
  schemaVersion: 1,
  operations: Object.fromEntries(Object.entries(operations).slice(-limit)),
});
