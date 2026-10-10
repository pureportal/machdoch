import { describe, expect, it } from "vitest";
import { isCodexAuthenticationFailure } from "./codex-authentication-failure.js";

describe("Codex authentication failures", () => {
  it.each([
    "refresh_token_reused",
    "refresh_token_expired",
    "refresh_token_invalidated",
    "Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.",
    "Your access token could not be refreshed because you have since logged out or signed in to another account. Please sign in again.",
    "Not logged in. Run codex login.",
    'unexpected status 401 Unauthorized: {"error":{"code":"auth_token_missing"}}',
  ])("recognizes terminal Codex credentials: %s", (diagnostic) => {
    expect(isCodexAuthenticationFailure(diagnostic)).toBe(true);
  });

  it.each([
    "Failed to refresh token: request timed out",
    "unexpected status 503 Service Unavailable",
    "MCP server authentication failed: refresh_token_reused",
    "codex_core::mcp_connection_manager: OAuth refresh_token_expired",
    "MCP server: Not logged in",
    "Quota exceeded",
  ])("keeps unrelated and transient errors retryable: %s", (diagnostic) => {
    expect(isCodexAuthenticationFailure(diagnostic)).toBe(false);
  });
});
