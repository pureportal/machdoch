import { describe, expect, it } from "vitest";
import { parseOAuthCallback } from "./oauth-callback.js";

describe("OAuth callback identity", () => {
  const expected = {
    expectedState: "expected",
    expectedIssuer: "https://cloud.example.test",
    requireIssuer: true,
  };
  const callback = (params: Record<string, string>) =>
    `http://127.0.0.1:43110/oauth/callback?${new URLSearchParams(params)}`;
  it("accepts the exact recorded issuer and state", () => {
    expect(
      parseOAuthCallback(
        callback({
          code: "code",
          state: "expected",
          iss: expected.expectedIssuer,
        }),
        expected,
      ),
    ).toEqual({ code: "code", stateVerified: true });
  });
  it("rejects missing state, bare codes, missing issuer, and normalized issuer variants", () => {
    for (const response of [
      "code",
      callback({ code: "code", iss: expected.expectedIssuer }),
      callback({ code: "code", state: "expected" }),
      callback({
        code: "code",
        state: "expected",
        iss: `${expected.expectedIssuer}/`,
      }),
      callback({
        code: "code",
        state: "expected",
        iss: "https://CLOUD.example.test",
      }),
    ])
      expect(() => parseOAuthCallback(response, expected)).toThrow(/mismatch/);
  });
  it("validates issuer before accepting or displaying an authorization error", () => {
    expect(() =>
      parseOAuthCallback(
        callback({
          error: "untrusted",
          state: "expected",
          iss: "https://evil.test",
        }),
        expected,
      ),
    ).toThrow("issuer mismatch");
    expect(() =>
      parseOAuthCallback(
        callback({
          error: "access_denied",
          state: "expected",
          iss: expected.expectedIssuer,
        }),
        expected,
      ),
    ).toThrow("authorization failed: access_denied");
  });
  it("rejects duplicate callback parameters", () => {
    expect(() =>
      parseOAuthCallback(
        `${callback({ code: "code", state: "expected", iss: expected.expectedIssuer })}&code=other`,
        expected,
      ),
    ).toThrow("duplicate");
  });
});
