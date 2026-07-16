import { describe, expect, it } from "vitest";
import { parseCliArgs } from "./cli-args.js";

describe("provider enrollment CLI arguments", () => {
  it("parses provider sync and MCP compatibility commands", () => {
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
