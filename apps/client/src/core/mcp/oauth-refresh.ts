import {
  OAuthTokensSchema,
  type OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { withCooperativeFileLock } from "../_helpers/with-cooperative-file-lock.helper.js";

interface CoordinatedOAuthRefresh {
  lockPath: string;
  tokenEndpoint: () => string | undefined;
  readTokens: () => Promise<OAuthTokens | undefined>;
  saveTokens: (tokens: OAuthTokens) => Promise<void>;
  adoptTokens: (tokens: OAuthTokens) => void;
  fetch?: typeof fetch;
}

export function createCoordinatedOAuthFetch(
  options: CoordinatedOAuthRefresh,
): typeof fetch {
  return async (input, init) => {
    const performFetch = options.fetch ?? fetch;
    if (
      !(init?.body instanceof URLSearchParams) ||
      init.body.get("grant_type") !== "refresh_token"
    )
      return performFetch(input, init);
    const url = input instanceof Request ? input.url : String(input);
    const requestedRefresh = init.body.get("refresh_token");
    if (url !== options.tokenEndpoint())
      throw new Error(
        "OAuth token endpoint changed. Reconnect the MCP server.",
      );
    return withCooperativeFileLock(
      options.lockPath,
      async () => {
        const latest = await options.readTokens();
        if (!latest?.refresh_token)
          throw new Error(
            "OAuth credentials are unavailable. Reconnect the MCP server.",
          );
        if (latest.refresh_token !== requestedRefresh) {
          options.adoptTokens(latest);
          return Response.json(latest, {
            headers: { "Cache-Control": "no-store" },
          });
        }
        const signal = init.signal
          ? AbortSignal.any([init.signal, AbortSignal.timeout(30_000)])
          : AbortSignal.timeout(30_000);
        const response = await performFetch(input, { ...init, signal });
        if (response.ok) {
          const received = OAuthTokensSchema.parse(
            await response.clone().json(),
          );
          const tokens = {
            ...received,
            refresh_token: received.refresh_token ?? latest.refresh_token,
          };
          await options.saveTokens(tokens);
          options.adoptTokens(tokens);
        }
        return response;
      },
      {
        ...(init.signal ? { signal: init.signal } : {}),
        timeoutMs: 30_000,
        ownerDescription: "MCP OAuth refresh",
      },
    );
  };
}
