import { z } from "zod";
import { cloudOAuthScopes } from "../../../lib/cloud-oauth-contract";
import { hashSecret } from "../../crypto";
import { CloudError } from "../access";
import type { CloudRuntime } from "../runtime";
import {
  nativeCloudClient,
  OAuthError,
  singleParameters,
  tokenSchema,
} from "./validation";

export async function handleOAuthApi(
  runtime: CloudRuntime,
  request: Request,
  address: string,
): Promise<Response> {
  try {
    const url = new URL(request.url);
    if (
      request.method === "GET" &&
      url.pathname === "/.well-known/oauth-protected-resource"
    )
      return Response.json({
        resource: `${runtime.origin}/api/v1/mcp`,
        authorization_servers: [runtime.origin],
        scopes_supported: ["cloud:read"],
        bearer_methods_supported: ["header"],
      });
    if (
      request.method === "GET" &&
      url.pathname === "/.well-known/oauth-authorization-server"
    )
      return Response.json({
        issuer: runtime.origin,
        authorization_endpoint: `${runtime.origin}/api/v1/oauth/authorize`,
        token_endpoint: `${runtime.origin}/api/v1/oauth/token`,
        revocation_endpoint: `${runtime.origin}/api/v1/oauth/revoke`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        token_endpoint_auth_methods_supported: ["none"],
        revocation_endpoint_auth_methods_supported: ["none"],
        code_challenge_methods_supported: ["S256"],
        scopes_supported: cloudOAuthScopes,
        authorization_response_iss_parameter_supported: true,
      });
    if (
      request.headers.has("origin") &&
      request.headers.get("origin") !== runtime.origin
    )
      throw new OAuthError("invalid_request", "Origin is not allowed.", 403);
    await limitOAuth(runtime, address);
    if (
      request.method === "GET" &&
      url.pathname === "/api/v1/oauth/authorize"
    ) {
      const id = await runtime.authorization.begin(url.searchParams);
      return new Response(null, {
        status: 303,
        headers: {
          Location: `${runtime.origin}/cloud/authorize?requestId=${id}`,
        },
      });
    }
    if (request.method === "POST" && url.pathname === "/api/v1/oauth/token") {
      const input = tokenSchema.safeParse(await readForm(request));
      if (!input.success)
        throw new OAuthError(
          "invalid_request",
          "The token request is invalid.",
        );
      return Response.json(await runtime.oauthTokens.exchange(input.data));
    }
    if (request.method === "POST" && url.pathname === "/api/v1/oauth/revoke") {
      const input = z
        .object({
          client_id: z.literal(nativeCloudClient.id),
          token: z.string().min(1).max(200),
        })
        .safeParse(await readForm(request));
      if (!input.success)
        throw new OAuthError(
          "invalid_request",
          "The revocation request is invalid.",
        );
      await runtime.oauthTokens.revoke(input.data.client_id, input.data.token);
      return new Response(null, { status: 200 });
    }
    throw new OAuthError(
      "invalid_request",
      "This endpoint is unavailable.",
      404,
    );
  } catch (error) {
    if (error instanceof OAuthError)
      return Response.json(
        { error: error.code, error_description: error.message },
        { status: error.status },
      );
    throw error;
  }
}

async function readForm(request: Request) {
  if (
    request.headers.get("content-type")?.split(";", 1)[0] !==
    "application/x-www-form-urlencoded"
  )
    throw new OAuthError(
      "invalid_request",
      "Use application/x-www-form-urlencoded.",
      415,
    );
  const reader = request.body?.getReader();
  if (!reader)
    throw new OAuthError("invalid_request", "Request body is missing.");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 8192) {
        await reader.cancel();
        throw new OAuthError("invalid_request", "Request is too large.", 413);
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  return singleParameters(
    new URLSearchParams(Buffer.concat(chunks).toString("utf8")),
  );
}

async function limitOAuth(runtime: CloudRuntime, address: string) {
  const allowed = await runtime.database.transaction(async (sql) => {
    let permitted = true;
    for (const [key, limit] of [
      [`oauth:address:${address}`, 60],
      ["oauth:global", 1000],
    ] as const) {
      const result = await sql.query<{ attempts: number }>(
        `INSERT INTO cloud_login_limits (key,attempts,expires_at) VALUES ($1,1,now()+interval '1 minute')
        ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN cloud_login_limits.expires_at<=now() THEN 1 ELSE cloud_login_limits.attempts+1 END,
        expires_at=CASE WHEN cloud_login_limits.expires_at<=now() THEN now()+interval '1 minute' ELSE cloud_login_limits.expires_at END RETURNING attempts`,
        [hashSecret(key)],
      );
      if (result.rows[0]!.attempts > limit) permitted = false;
    }
    return permitted;
  });
  if (!allowed)
    throw new CloudError(
      429,
      "rate_limited",
      "Too many connection requests. Try again in a minute.",
    );
}
