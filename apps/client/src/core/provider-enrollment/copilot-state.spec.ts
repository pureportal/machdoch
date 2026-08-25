import { describe, expect, it } from "vitest";
import { renderIsolatedCopilotState } from "./copilot-state.js";

describe("Copilot state isolation", () => {
  it("accepts Copilot JSONC while preserving comment markers inside strings", () => {
    const rendered = renderIsolatedCopilotState(`﻿// User settings
{
  "endpoint": "https://example.test/path//segment",
  "pattern": "/* literal */",
  "nested": { "enabled": true, },
  "values": [1, 2,],
  "installedPlugins": ["unsafe"],
}
`);

    expect(JSON.parse(rendered)).toEqual({
      endpoint: "https://example.test/path//segment",
      pattern: "/* literal */",
      nested: { enabled: true },
      values: [1, 2],
    });
  });

  it("rejects malformed or non-object state explicitly", () => {
    expect(() => renderIsolatedCopilotState("{/* unterminated")).toThrow(
      "valid JSON-with-comments object",
    );
    expect(() => renderIsolatedCopilotState("[]")).toThrow(
      "valid JSON-with-comments object",
    );
  });
});
