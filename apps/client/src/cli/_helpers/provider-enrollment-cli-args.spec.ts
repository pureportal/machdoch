import { describe, expect, it } from "vitest";
import { parseCliArgs } from "./cli-args.js";

describe("provider enrollment CLI arguments", () => {
  it("parses provider sync and MCP broker commands", () => {
    expect(parseCliArgs(["provider-sync", "plan", "--provider", "codex-cli"], {
      currentWorkingDirectory: "/workspace",
    })).toMatchObject({
      command: "provider-sync",
      providerSync: { action: "plan", provider: "codex-cli" },
    });
    expect(parseCliArgs(["mcp", "proxy", "calendar"], {
      currentWorkingDirectory: "/workspace",
    })).toMatchObject({
      command: "mcp",
      mcp: { action: "proxy", serverId: "calendar" },
    });
    expect(parseCliArgs(["mcp", "broker"], {
      currentWorkingDirectory: "/workspace",
    })).toMatchObject({ command: "mcp", mcp: { action: "broker" } });
  });
});

it.each([
  [["fleet", "enroll", "--manager-url=", "--enrollment-key=", "--display-name="], "Expected --manager-url for `machdoch fleet enroll`."],
  [["fleet", "status", "--manager-url="], "Fleet enrollment options are only valid for `machdoch fleet enroll`."],
  [["mcp", "--manager-url=", "--mode=invalid", "--help"], "Fleet enrollment options require `machdoch fleet enroll`."],
])("preserves enrollment validation precedence for %j", (argv, message) => {
  expect(() => parseCliArgs(argv)).toThrow(message);
});
