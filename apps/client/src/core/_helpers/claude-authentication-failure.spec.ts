import { describe, expect, it } from "vitest";
import {
  createClaudeAuthenticationRecovery,
  isClaudeLoginRefreshBusy,
} from "./claude-authentication-failure.js";

describe("Claude authentication failures", () => {
  it("asks for a new sign-in when the saved login is the credential", () => {
    expect(
      createClaudeAuthenticationRecovery(
        "Failed to authenticate: OAuth session expired and could not be refreshed",
        {},
      ),
    ).toContain("claude auth login");
  });

  it.each([
    ["ANTHROPIC_AUTH_TOKEN"],
    ["ANTHROPIC_API_KEY"],
    ["CLAUDE_CODE_OAUTH_TOKEN"],
  ])("names %s instead of asking for a sign-in it would ignore", (key) => {
    const recovery = createClaudeAuthenticationRecovery("Invalid API key", {
      [key]: "configured",
    });
    expect(recovery).toContain("Invalid API key");
    expect(recovery).toContain(key);
    expect(recovery).not.toContain("claude auth login");
  });

  it("ignores a blank credential variable", () => {
    expect(
      createClaudeAuthenticationRecovery("Not logged in", {
        ANTHROPIC_API_KEY: "  ",
      }),
    ).toContain("claude auth login");
  });

  it("recognizes only the CLI's busy-refresh error", () => {
    expect(
      isClaudeLoginRefreshBusy(
        "Failed to refresh OAuth token: another Claude Code process is refreshing it or exited mid-refresh. This is usually transient; retry in a minute, and if it persists close other Claude Code processes or sign in again",
      ),
    ).toBe(true);
    expect(
      isClaudeLoginRefreshBusy(
        "Failed to authenticate: OAuth session expired and could not be refreshed",
      ),
    ).toBe(false);
    expect(
      isClaudeLoginRefreshBusy(
        "The log says Failed to refresh OAuth token: another Claude Code process is refreshing it",
      ),
    ).toBe(false);
  });
});
