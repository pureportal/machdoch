import { describe, expect, it } from "vitest";
import {
  createRalphAppendJsonlLedger,
  parseRalphAppendJsonlLedger,
  type RalphAppendJsonlOperation,
} from "./ralph-append-jsonl-ledger.helper.js";

const started: RalphAppendJsonlOperation = {
  state: "started",
  priorSize: 12,
  lineLength: 8,
  lineSha256: "a".repeat(64),
  startedAt: "2026-09-01T00:00:00.000Z",
};

describe("RALPH APPEND_JSONL ledger", () => {
  it("parses explicit started and completed operation variants", () => {
    const ledger = createRalphAppendJsonlLedger({
      first: started,
      second: {
        ...started,
        state: "completed",
        completedAt: "2026-09-01T00:00:01.000Z",
      },
    });

    expect(parseRalphAppendJsonlLedger(ledger)).toEqual({
      ledger,
      source: "current",
    });
  });

  it("normalizes the prior unversioned engine ledger", () => {
    expect(
      parseRalphAppendJsonlLedger({
        operations: {
          first: {
            ...started,
            state: "completed",
            completedAt: "2026-09-01T00:00:01.000Z",
          },
        },
      }),
    ).toEqual({
      ledger: {
        schemaVersion: 1,
        operations: {
          first: {
            ...started,
            state: "completed",
            completedAt: "2026-09-01T00:00:01.000Z",
          },
        },
      },
      source: "unversioned",
    });
  });

  it.each([
    {},
    { schemaVersion: 2, operations: {} },
    { operations: {}, unexpected: true },
    { schemaVersion: 1, operations: { first: { ...started, state: "done" } } },
    {
      schemaVersion: 1,
      operations: { first: { ...started, lineSha256: "not-a-digest" } },
    },
    {
      schemaVersion: 1,
      operations: { first: { ...started, priorSize: -1 } },
    },
  ])("rejects malformed ledger state %#", (value) => {
    expect(parseRalphAppendJsonlLedger(value)).toBeUndefined();
  });
});
