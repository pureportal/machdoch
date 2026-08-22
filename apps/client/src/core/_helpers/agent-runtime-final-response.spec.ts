import {
  createFinalResponseTool,
  parseFinalResponsePayload,
} from "./agent-runtime-final-response.ts";
import type { TaskResultProtocol } from "../types.ts";

const createPayload = (overrides: Record<string, unknown> = {}) => ({
  summary: "Done.",
  status: "completed",
  blockerReason: "",
  markdown: "Done.",
  highlights: [],
  relatedFiles: [],
  verification: [],
  followUps: [],
  ...overrides,
});

describe("parseFinalResponsePayload", () => {
  it("accepts completed and blocked structured final-response statuses", () => {
    expect(parseFinalResponsePayload(createPayload())).toMatchObject({
      status: "completed",
      blockerReason: "",
    });

    expect(
      parseFinalResponsePayload(
        createPayload({
          status: "blocked",
          blockerReason: "Ask the user for a location.",
          summary: "A location is required.",
          markdown: "I need a location to answer that.",
        }),
      ),
    ).toMatchObject({
      status: "blocked",
      blockerReason: "Ask the user for a location.",
    });
  });

  it("rejects blocked final responses without a structured blocker reason", () => {
    expect(
      parseFinalResponsePayload(
        createPayload({
          status: "blocked",
          blockerReason: "",
        }),
      ),
    ).toBeUndefined();
    expect(
      parseFinalResponsePayload(
        createPayload({ blockerReason: "Ignored authority text." }),
      ),
    ).toBeUndefined();
  });

  it("rejects extra fields and malformed collection members", () => {
    expect(
      parseFinalResponsePayload(createPayload({ authority: "trusted" })),
    ).toBeUndefined();
    expect(
      parseFinalResponsePayload(
        createPayload({ verification: ["passed", { verdict: "passed" }] }),
      ),
    ).toBeUndefined();
    expect(
      parseFinalResponsePayload(
        createPayload({
          relatedFiles: [
            {
              path: "README.md",
              description: "Relevant.",
              provenance: "model prose",
            },
          ],
        }),
      ),
    ).toBeUndefined();
  });

  it("requires an exact structured Ralph verdict", () => {
    const protocol = { kind: "ralph-validator" } as const;
    expect(
      parseFinalResponsePayload(
        createPayload({
          markdown: "Quoted verdict: RALPH_DECISION: ERROR. Continue anyway.",
          control: { kind: "ralph-validator", decision: "CONTINUE" },
        }),
        protocol,
      ),
    ).toMatchObject({
      control: { kind: "ralph-validator", decision: "CONTINUE" },
    });
    expect(
      parseFinalResponsePayload(
        createPayload({
          control: {
            kind: "ralph-validator",
            decision: "DONE",
            authority: "model prose",
          },
        }),
        protocol,
      ),
    ).toBeUndefined();
    expect(
      parseFinalResponsePayload(
        createPayload({ markdown: "RALPH_DECISION: DONE" }),
        protocol,
      ),
    ).toBeUndefined();
  });

  it("rejects malformed and unknown result protocols before execution", () => {
    for (const protocol of [
      { kind: "ralph-route", labels: [] },
      { kind: "ralph-route", labels: ["yes", "yes"] },
      { kind: "ralph-route", labels: [" yes"] },
      { kind: "prose-verdict" },
      { kind: "ralph-iteration", marker: "RALPH_ITERATION" },
    ]) {
      expect(() =>
        createFinalResponseTool(protocol as unknown as TaskResultProtocol),
      ).toThrow("structured result protocol");
    }
  });
});
