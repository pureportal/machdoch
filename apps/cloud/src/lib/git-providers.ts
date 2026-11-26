export const gitProviders = ["github", "gitlab"] as const;
export type GitProvider = (typeof gitProviders)[number];

export const gitProviderLabels: Record<GitProvider, string> = {
  github: "GitHub",
  gitlab: "GitLab",
};

export const defaultGitApiUrls: Record<GitProvider, string> = {
  github: "https://api.github.com",
  gitlab: "https://gitlab.com/api/v4",
};

export function isGitProvider(value: string): value is GitProvider {
  return (gitProviders as readonly string[]).includes(value);
}

export type GitTokenPurpose = "connection" | "account";

const tokenScopes: Record<GitProvider, Record<GitTokenPurpose, string>> = {
  github: {
    connection: "repo,admin:repo_hook,read:org",
    account: "repo,workflow,read:org",
  },
  gitlab: { connection: "api", account: "api" },
};

export function gitTokenUrl(
  provider: GitProvider,
  apiUrl: string,
  purpose: GitTokenPurpose,
): string | null {
  let origin: string;
  try {
    const parsed = new URL(apiUrl);
    origin =
      parsed.host === "api.github.com" ? "https://github.com" : parsed.origin;
  } catch {
    return null;
  }
  const scopes = tokenScopes[provider][purpose];
  return provider === "github"
    ? `${origin}/settings/tokens/new?description=Machdoch&scopes=${scopes}`
    : `${origin}/-/user_settings/personal_access_tokens?name=Machdoch&scopes=${scopes}`;
}
