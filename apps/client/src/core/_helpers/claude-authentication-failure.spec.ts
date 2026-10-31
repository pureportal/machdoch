import { describe, expect, it } from "vitest";
import { isClaudeAuthenticationFailure } from "./claude-authentication-failure.js";

describe("Claude authentication failures", () => {
  it.each([
    "Failed to authenticate: OAuth session expired and could not be refreshed",
    "Not logged in · Please run /login",
    "Login expired · Please run /login",
    "Authentication required · Sign in again to continue",
    "Reading the config.\n\nFailed to authenticate: OAuth session expired and could not be refreshed\n",
  ])("recognizes terminal Claude credentials: %s", (lastMessage) => {
    expect(isClaudeAuthenticationFailure(lastMessage)).toBe(true);
  });

  it.each([
    "Failed to refresh OAuth token: another Claude Code process is refreshing it or exited mid-refresh.",
    "The error said OAuth session expired and could not be refreshed, so I am fixing it.",
    "Failed to authenticate: OAuth session expired and could not be refreshed\nFixed by signing in again.",
    "Not logged in yet.",
    "",
  ])("keeps transient errors and agent prose retryable: %s", (lastMessage) => {
    expect(isClaudeAuthenticationFailure(lastMessage)).toBe(false);
  });
});
