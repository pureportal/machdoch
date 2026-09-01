import { describe, expect, it } from "vitest";
import {
  areRalphInstructionEnvironmentDigestsEqual,
  findRalphInstructionBoundary,
  type RalphInstructionBoundaryIdentity,
} from "./ralph-instruction-boundary-registry.helper.js";

const identity = (
  model: string,
  reasoning: RalphInstructionBoundaryIdentity["reasoning"] = "medium",
): RalphInstructionBoundaryIdentity => ({
  providerId: "openai",
  model,
  reasoning,
});

describe("RALPH instruction boundary registry", () => {
  it("matches boundaries by explicit identity fields", () => {
    const first = { id: "first" };
    const second = { id: "second" };
    const entries = [
      { identity: identity("model\0variant", "high"), boundary: first },
      { identity: identity("model", "high"), boundary: second },
    ];

    expect(
      findRalphInstructionBoundary(entries, identity("model\0variant", "high")),
    ).toBe(first);
    expect(
      findRalphInstructionBoundary(entries, identity("model", "high")),
    ).toBe(second);
    expect(
      findRalphInstructionBoundary(entries, identity("model", "medium")),
    ).toBeUndefined();
  });

  it("compares persisted environment digests without serialized-object equality", () => {
    const first = { ...identity("first"), digest: "digest-one" };
    const second = { ...identity("second", "high"), digest: "digest-two" };

    expect(
      areRalphInstructionEnvironmentDigestsEqual(
        [first, second],
        [second, first],
      ),
    ).toBe(true);
    expect(
      areRalphInstructionEnvironmentDigestsEqual(
        [first, second],
        [first, { ...second, digest: "changed" }],
      ),
    ).toBe(false);
  });
});
