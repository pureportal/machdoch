import type { McpOAuthConfig } from "./types.js";

export interface McpOAuthCallbackExpectation {
  expectedState?: string;
  expectedIssuer?: string;
  requireIssuer?: boolean;
}

export function oauthCallbackExpectation(
  auth: McpOAuthConfig,
): McpOAuthCallbackExpectation {
  const metadata = auth.discoveryState?.authorizationServerMetadata;
  const record =
    metadata && typeof metadata === "object"
      ? (metadata as Record<string, unknown>)
      : undefined;
  return {
    ...(auth.authorizationState
      ? { expectedState: auth.authorizationState }
      : {}),
    ...(typeof record?.issuer === "string"
      ? { expectedIssuer: record.issuer }
      : {}),
    requireIssuer:
      record?.authorization_response_iss_parameter_supported === true,
  };
}

export function validateOAuthCallback(
  parameters: URLSearchParams,
  expected: McpOAuthCallbackExpectation,
): void {
  for (const key of ["code", "state", "iss", "error", "error_description"])
    if (parameters.getAll(key).length > 1)
      throw new Error(
        "OAuth callback contains duplicate parameters. Restart authorization.",
      );
  if (
    expected.expectedState &&
    parameters.get("state") !== expected.expectedState
  )
    throw new Error(
      "MCP OAuth state mismatch. Restart the authorization flow.",
    );
  const issuer = parameters.get("iss");
  if (
    (expected.requireIssuer && issuer === null) ||
    (issuer !== null &&
      (!expected.expectedIssuer || issuer !== expected.expectedIssuer))
  )
    throw new Error(
      "MCP OAuth issuer mismatch. Restart the authorization flow.",
    );
}

export function parseOAuthCallback(
  response: string,
  expected: McpOAuthCallbackExpectation,
) {
  const value = response.trim();
  if (!value)
    throw new Error("Expected an OAuth authorization code or callback URL.");
  let parameters: URLSearchParams;
  if (value.startsWith("?")) parameters = new URLSearchParams(value.slice(1));
  else {
    let url: URL | undefined;
    try {
      url = new URL(value);
    } catch {
      url = undefined;
    }
    if (!url) {
      validateOAuthCallback(new URLSearchParams(), expected);
      return { code: value, stateVerified: undefined };
    }
    parameters = url.searchParams;
  }
  validateOAuthCallback(parameters, expected);
  if (parameters.has("error"))
    throw new Error(
      `MCP OAuth authorization failed: ${parameters.get("error")}`,
    );
  const code = parameters.get("code");
  if (!code)
    throw new Error("OAuth callback URL does not contain a code parameter.");
  return { code, stateVerified: expected.expectedState ? true : undefined };
}
