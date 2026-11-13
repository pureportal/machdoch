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
