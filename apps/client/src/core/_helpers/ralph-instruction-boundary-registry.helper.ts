import type {
  ConfiguredModelProvider,
  ReasoningMode,
} from "../runtime-contract.generated.js";

export interface RalphInstructionBoundaryIdentity {
  providerId: ConfiguredModelProvider;
  model: string;
  reasoning: ReasoningMode;
}

export interface RalphInstructionBoundaryRegistryEntry<Boundary> {
  identity: RalphInstructionBoundaryIdentity;
  boundary: Boundary;
}

export interface RalphInstructionEnvironmentDigest extends RalphInstructionBoundaryIdentity {
  digest: string;
}

export const isSameRalphInstructionBoundaryIdentity = (
  left: RalphInstructionBoundaryIdentity,
  right: RalphInstructionBoundaryIdentity,
): boolean =>
  left.providerId === right.providerId &&
  left.model === right.model &&
  left.reasoning === right.reasoning;

export const findRalphInstructionBoundary = <Boundary>(
  entries: readonly RalphInstructionBoundaryRegistryEntry<Boundary>[],
  identity: RalphInstructionBoundaryIdentity,
): Boundary | undefined =>
  entries.find((entry) =>
    isSameRalphInstructionBoundaryIdentity(entry.identity, identity),
  )?.boundary;

export const areRalphInstructionEnvironmentDigestsEqual = (
  left: readonly RalphInstructionEnvironmentDigest[],
  right: readonly RalphInstructionEnvironmentDigest[],
): boolean => {
  if (left.length !== right.length) {
    return false;
  }

  const unmatched = [...right];
  for (const candidate of left) {
    const matchIndex = unmatched.findIndex(
      (entry) =>
        entry.digest === candidate.digest &&
        isSameRalphInstructionBoundaryIdentity(entry, candidate),
    );
    if (matchIndex < 0) {
      return false;
    }
    unmatched.splice(matchIndex, 1);
  }

  return unmatched.length === 0;
};
