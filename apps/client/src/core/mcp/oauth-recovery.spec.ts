import { describe, expect, it } from "vitest";
import { getMcpOAuthRecoveryCommands } from "./oauth-recovery.js";

describe("MCP OAuth recovery commands", () => {
  it("targets the selected provider projection scope", () => {
    expect(getMcpOAuthRecoveryCommands("linear", { scope: "user" })).toEqual({
      authorize: "machdoch mcp oauth-authorize linear --scope user",
      start: "machdoch mcp oauth-start linear --scope user",
      finish:
        "machdoch mcp oauth-finish linear <callback-url-or-code> --scope user",
    });

    expect(
      getMcpOAuthRecoveryCommands("linear", {
        workspaceRoot: "C:\\Work Folder\\repo",
      }),
    ).toEqual({
      authorize:
        'machdoch mcp oauth-authorize linear --cwd "C:\\Work Folder\\repo"',
      start: 'machdoch mcp oauth-start linear --cwd "C:\\Work Folder\\repo"',
      finish:
        'machdoch mcp oauth-finish linear <callback-url-or-code> --cwd "C:\\Work Folder\\repo"',
    });
  });
});
