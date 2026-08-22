/// <reference types="vitest/globals" />

import { emitProviderStreamEvent } from "./stream-events.ts";

describe("emitProviderStreamEvent", () => {
  it("isolates throwing progress handlers from provider stream execution", () => {
    expect(() => {
      emitProviderStreamEvent(
        () => {
          throw new Error("progress sink failed");
        },
        {
          type: "status",
          provider: "openai",
          status: "in-progress",
          message: "Streaming.",
        },
      );
    }).not.toThrow();
  });
});
