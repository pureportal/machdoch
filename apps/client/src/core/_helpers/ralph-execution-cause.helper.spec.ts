import { describe, expect, it } from "vitest";
import type { RalphBlockExecutionResult } from "../ralph.js";
import { findRalphExecutionCause } from "./ralph-execution-cause.helper.js";

const result = (
  blockId: string,
  output: string,
  data?: Record<string, unknown>,
): RalphBlockExecutionResult => ({
  blockId,
  output,
  status: output === "FAILED" ? "error" : "completed",
  summary: output,
  attempt: 1,
  durationMs: 1,
  ...(data ? { data } : {}),
});

describe("Ralph execution causes", () => {
  it("clears a repaired failure without rewriting its history", () => {
    const history = [result("verify", "FAILED"), result("verify", "SUCCESS")];
    expect(findRalphExecutionCause(history)).toBeUndefined();
    expect(history[0]?.status).toBe("error");
  });

  it("retains failures from other blocks and failed retries", () => {
    expect(
      findRalphExecutionCause([
        result("review", "FAILED"),
        result("verify", "FAILED"),
        result("verify", "SUCCESS"),
      ]),
    ).toMatchObject({ blockId: "review", output: "FAILED" });
    expect(
      findRalphExecutionCause([
        result("verify", "SUCCESS"),
        result("verify", "FAILED"),
      ]),
    ).toMatchObject({ blockId: "verify", output: "FAILED" });
  });

  it("uses the state at a journal boundary and leaves prior work behind", () => {
    const history = [
      result("verify", "FAILED"),
      result("record-invalid", "SUCCESS", { workOutcome: "INVALID" }),
      result("verify", "SUCCESS"),
    ];
    expect(findRalphExecutionCause(history, 1)).toMatchObject({
      blockId: "verify",
    });
    expect(findRalphExecutionCause(history)).toBeUndefined();
  });
});
