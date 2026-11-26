import { createPrivateKey, sign } from "node:crypto";
import { z } from "zod";
import type { GitAvailableRepository } from "../../../lib/cloud-git-contract";
import type { GitAccess } from "./git-client";
import { githubWebhookEvents } from "./github-client";
import { gitRequest } from "./git-http";
import { providerWebOrigin } from "./oauth";

export interface GitHubAppKey {
  appId: number;
  privateKey: string;
}

export interface GitHubAppRegistration extends GitHubAppKey {
  slug: string;
  clientId: string;
  clientSecret: string;
  webhookSecret: string;
}

export interface GitHubInstallationToken {
  token: string;
  expiresAt: Date;
}

export const gitHubAppPermissions = {
  actions: "read",
  administration: "read",
  checks: "read",
  contents: "write",
  deployments: "read",
  issues: "write",
  members: "read",
  metadata: "read",
  pull_requests: "write",
  statuses: "write",
  workflows: "write",
} as const;

const jwtLifetimeSeconds = 540;
const clockSkewSeconds = 60;
const maximumAppNameLength = 34;
const repositoryPageSize = 100;
const maximumRepositoryPages = 10;
const apiVersion = "2022-11-28";

function encoded(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

export function gitHubAppJwt(key: GitHubAppKey, now = Date.now()): string {
  const issuedAt = Math.floor(now / 1000) - clockSkewSeconds;
  const header = encoded(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = encoded(
    JSON.stringify({
      iat: issuedAt,
      exp: issuedAt + jwtLifetimeSeconds,
      iss: String(key.appId),
    }),
  );
  const signature = sign(
    "RSA-SHA256",
    Buffer.from(`${header}.${payload}`),
    createPrivateKey(key.privateKey),
  );
  return `${header}.${payload}.${encoded(signature)}`;
}

function appHeaders(key: GitHubAppKey): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${gitHubAppJwt(key)}`,
    "X-GitHub-Api-Version": apiVersion,
  };
}

export function gitHubAppName(organization: string): string {
  const name = `Machdoch ${organization}`.replace(/[^A-Za-z0-9 ._-]+/gu, "");
  return name.slice(0, maximumAppNameLength).trim() || "Machdoch";
}

export function gitHubAppManifest(input: {
  name: string;
  homepageUrl: string;
  webhookUrl: string;
  webhookActive: boolean;
  redirectUrl: string;
  callbackUrl: string;
  setupUrl: string;
}): Record<string, unknown> {
  return {
    name: input.name,
    url: input.homepageUrl,
    hook_attributes: { url: input.webhookUrl, active: input.webhookActive },
    redirect_url: input.redirectUrl,
    callback_urls: [input.callbackUrl],
    setup_url: input.setupUrl,
    setup_on_update: true,
    public: false,
    request_oauth_on_install: false,
    default_permissions: gitHubAppPermissions,
    default_events: githubWebhookEvents,
  };
}

export function gitHubAppCreationUrl(
  apiUrl: string,
  owner: string | null,
  state: string,
): string {
  const web = providerWebOrigin("github", apiUrl);
  const url = new URL(
    owner
      ? `${web}/organizations/${encodeURIComponent(owner)}/settings/apps/new`
      : `${web}/settings/apps/new`,
  );
  url.searchParams.set("state", state);
  return url.href;
}

export function gitHubAppInstallUrl(
  apiUrl: string,
  slug: string,
  state: string,
): string {
  const url = new URL(
    `${providerWebOrigin("github", apiUrl)}/apps/${encodeURIComponent(slug)}/installations/new`,
  );
  url.searchParams.set("state", state);
  return url.href;
}

const registrationSchema = z.object({
  id: z.number().int().positive(),
  slug: z.string().min(1).max(100),
  client_id: z.string().min(1).max(200),
  client_secret: z.string().min(1),
  webhook_secret: z.string().min(1),
  pem: z.string().min(1),
});

export async function convertGitHubAppManifest(
  apiUrl: string,
  code: string,
  transport: typeof fetch,
): Promise<GitHubAppRegistration> {
  const app = await gitRequest(
    "github",
    transport,
    `${apiUrl}/app-manifests/${encodeURIComponent(code)}/conversions`,
    registrationSchema,
    {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": apiVersion,
      },
    },
  );
  return {
    appId: app.id,
    slug: app.slug,
    clientId: app.client_id,
    clientSecret: app.client_secret,
    webhookSecret: app.webhook_secret,
    privateKey: app.pem,
  };
}

export async function gitHubInstallationAccount(
  apiUrl: string,
  key: GitHubAppKey,
  installationId: number,
  transport: typeof fetch,
): Promise<string> {
  const installation = await gitRequest(
    "github",
    transport,
    `${apiUrl}/app/installations/${installationId}`,
    z.object({ account: z.object({ login: z.string().min(1).max(100) }) }),
    { headers: appHeaders(key) },
  );
  return installation.account.login;
}

export async function gitHubInstallationToken(
  apiUrl: string,
  key: GitHubAppKey,
  installationId: number,
  transport: typeof fetch,
): Promise<GitHubInstallationToken> {
  const result = await gitRequest(
    "github",
    transport,
    `${apiUrl}/app/installations/${installationId}/access_tokens`,
    z.object({ token: z.string().min(20).max(400), expires_at: z.string() }),
    { method: "POST", headers: appHeaders(key) },
  );
  return { token: result.token, expiresAt: new Date(result.expires_at) };
}

export async function removeGitHubInstallation(
  apiUrl: string,
  key: GitHubAppKey,
  installationId: number,
  transport: typeof fetch,
): Promise<void> {
  await gitRequest(
    "github",
    transport,
    `${apiUrl}/app/installations/${installationId}`,
    z.unknown(),
    { method: "DELETE", headers: appHeaders(key) },
  );
}

const installationRepositoriesSchema = z.object({
  total_count: z.number().int().min(0),
  repositories: z.array(
    z.object({ full_name: z.string(), private: z.boolean() }),
  ),
});

export async function gitHubInstallationRepositories(
  access: GitAccess,
  transport: typeof fetch,
): Promise<GitAvailableRepository[]> {
  const repositories: GitAvailableRepository[] = [];
  for (let page = 1; page <= maximumRepositoryPages; page++) {
    const result = await gitRequest(
      "github",
      transport,
      `${access.apiUrl}/installation/repositories?per_page=${repositoryPageSize}&page=${page}`,
      installationRepositoriesSchema,
      {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${access.token}`,
          "X-GitHub-Api-Version": apiVersion,
        },
      },
    );
    repositories.push(
      ...result.repositories.map((repository) => ({
        fullName: repository.full_name,
        private: repository.private,
      })),
    );
    if (
      repositories.length >= result.total_count ||
      result.repositories.length < repositoryPageSize
    )
      break;
  }
  return repositories;
}
