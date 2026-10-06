import { createHash } from "node:crypto";
import type { RalphRunCheckpoint } from "../ralph.js";
import { canonicalizeRalphValue } from "./create-ralph-flow-fingerprint.helper.js";

export const createRalphCheckpointFence = (
  checkpoint: RalphRunCheckpoint | undefined,
): string | undefined => {
  if (!checkpoint) return undefined;
  const comparable = {
    ...checkpoint,
    ...(checkpoint.lease
      ? {
          lease: {
            ownerId: checkpoint.lease.ownerId,
            generation: checkpoint.lease.generation,
            acquiredAt: checkpoint.lease.acquiredAt,
            ...(checkpoint.lease.releasedAt
              ? { releasedAt: checkpoint.lease.releasedAt }
              : {}),
          },
        }
      : {}),
  };
  delete comparable.durability;
  return createHash("sha256")
    .update(JSON.stringify(canonicalizeRalphValue(comparable)))
    .digest("hex");
};
