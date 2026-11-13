import { z } from "zod";
import {
  defaultGitApiUrls,
  gitProviderLabels,
  type GitProvider,
} from "../../../lib/git-providers";
import { CloudError } from "../access";
import { gitRequest } from "./git-http";

export interface OAuthApp {
  clientId: string;
  clientSecret: string;
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
}

const scopes: Record<GitProvider, string> = {
  github: "repo read:user",
  gitlab: "api",
};

const tokenSchema = z.union([
  z.object({
    access_token: z.string().min(1),
    refresh_token: z.string().min(1).optional(),
    expires_in: z.number().int().positive().optional(),
  }),
  z.object({
    error: z.string(),
    error_description: z.string().optional(),
  }),
]);

export function providerWebOrigin(
  provider: GitProvider,
  apiUrl: string,
): string {
  if (provider === "github")
    return apiUrl === defaultGitApiUrls.github
      ? "https://github.com"
      : new URL(apiUrl).origin;
  return apiUrl.replace(/\/api\/v4$/u, "");
}

function tokenUrl(provider: GitProvider, apiUrl: string): string {
  const web = providerWebOrigin(provider, apiUrl);
  return provider === "github"
    ? `${web}/login/oauth/access_token`
    : `${web}/oauth/token`;
}

export function oauthAuthorizeUrl(
  provider: GitProvider,
  apiUrl: string,
  clientId: string,
  redirectUri: string,
  state: string,
): string {
  const web = providerWebOrigin(provider, apiUrl);
  const url = new URL(
    provider === "github"
      ? `${web}/login/oauth/authorize`
      : `${web}/oauth/authorize`,
  );
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", scopes[provider]);
  url.searchParams.set("state", state);
  if (provider === "gitlab") url.searchParams.set("response_type", "code");
  return url.href;
}

async function requestTokens(
  provider: GitProvider,
  apiUrl: string,
  app: OAuthApp,
  grant: Record<string, string>,
  transport: typeof fetch,
): Promise<OAuthTokens> {
  const result = await gitRequest(
    provider,
    transport,
    tokenUrl(provider, apiUrl),
    tokenSchema,
    {
      method: "POST",
      headers: { Accept: "application/json" },
      body: {
        client_id: app.clientId,
        client_secret: app.clientSecret,
        ...grant,
      },
    },
  );
  if ("error" in result)
    throw new CloudError(
      422,
      "git_oauth",
      `${gitProviderLabels[provider]} rejected the sign-in: ${(result.error_description ?? result.error).slice(0, 200)}`,
    );
  return {
    accessToken: result.access_token,
    refreshToken: result.refresh_token ?? null,
    expiresAt: result.expires_in
      ? new Date(Date.now() + result.expires_in * 1000)
      : null,
  };
}

export function exchangeOAuthCode(
  provider: GitProvider,
  apiUrl: string,
  app: OAuthApp,
  redirectUri: string,
  code: string,
  transport: typeof fetch,
): Promise<OAuthTokens> {
  return requestTokens(
    provider,
    apiUrl,
    app,
    { grant_type: "authorization_code", code, redirect_uri: redirectUri },
    transport,
  );
}

export function refreshOAuthToken(
  provider: GitProvider,
  apiUrl: string,
  app: OAuthApp,
  redirectUri: string,
  refreshToken: string,
  transport: typeof fetch,
): Promise<OAuthTokens> {
  return requestTokens(
    provider,
    apiUrl,
    app,
    {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      redirect_uri: redirectUri,
    },
    transport,
  );
}
