import { parseFinalResponsePayload } from "./agent-runtime-final-response.ts";

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
  });
});
