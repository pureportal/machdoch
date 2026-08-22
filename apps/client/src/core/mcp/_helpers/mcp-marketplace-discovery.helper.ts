export interface McpMarketplaceDiscoveryCategory {
  id: string;
  label: string;
  description: string;
  keywords: string[];
}

export interface McpMarketplaceDiscoveryRecommendation {
  label: string;
  reason: string;
}

export interface McpMarketplaceDiscoveryServer {
  name: string;
  title?: string | undefined;
  description: string;
  repository?: {
    url?: string | undefined;
  } | undefined;
}

export const MCP_MARKETPLACE_DISCOVERY_CATEGORIES: readonly McpMarketplaceDiscoveryCategory[] = [
  {
    id: "featured",
    label: "Featured",
    description: "Useful MCPs to start with.",
    keywords: ["github", "filesystem", "browser", "search", "docs", "database"],
  },
  {
    id: "developer-tools",
    label: "Developer Tools",
    description: "Code, repositories, browsers, terminals, and local workflows.",
    keywords: [
      "github",
      "gitlab",
      "git",
      "browser",
      "chrome",
      "playwright",
      "filesystem",
      "developer",
      "code",
      "repository",
    ],
  },
  {
    id: "data-search",
    label: "Data & Search",
    description: "Search, databases, analytics, and retrieval tools.",
    keywords: [
      "search",
      "database",
      "postgres",
      "mysql",
      "sqlite",
      "analytics",
      "vector",
      "docs",
      "knowledge",
    ],
  },
  {
    id: "productivity",
    label: "Productivity",
    description: "Notes, documents, calendars, tasks, and workspace automation.",
    keywords: [
      "notion",
      "slack",
      "linear",
      "jira",
      "calendar",
      "obsidian",
      "docs",
      "task",
      "email",
    ],
  },
  {
    id: "infrastructure",
    label: "Infrastructure",
    description: "Cloud, containers, Kubernetes, CI, and operations.",
    keywords: [
      "docker",
      "kubernetes",
      "cloud",
      "aws",
      "azure",
      "gcp",
      "terraform",
      "ci",
      "deploy",
    ],
  },
] as const;

const MCP_MARKETPLACE_RECOMMENDED_SERVER_NAMES: ReadonlySet<string> = new Set([
  "app.linear/linear",
  "com.figma.mcp/mcp",
  "com.notion/mcp",
  "com.pulsemcp.mirror/modelcontextprotocol-fetch",
  "com.pulsemcp.mirror/modelcontextprotocol-filesystem",
  "com.pulsemcp.mirror/modelcontextprotocol-git",
  "com.pulsemcp.mirror/modelcontextprotocol-github",
  "com.pulsemcp.mirror/modelcontextprotocol-memory",
  "com.pulsemcp.mirror/modelcontextprotocol-postgres",
  "com.pulsemcp.mirror/modelcontextprotocol-sequential-thinking",
  "com.pulsemcp.mirror/modelcontextprotocol-sqlite",
  "com.supabase/mcp",
  "io.github.firecrawl/firecrawl-mcp-server",
  "io.github.github/github-mcp-server",
  "io.github.grafana/mcp-grafana",
  "io.github.microsoft/playwright-mcp",
  "io.github.mongodb-js/mongodb-mcp-server",
  "io.github.upstash/context7",
] as const);

const MCP_MARKETPLACE_RECOMMENDED_REPOSITORIES: ReadonlySet<string> = new Set([
  "figma/mcp-server-guide",
  "firecrawl/firecrawl-mcp-server",
  "github/github-mcp-server",
  "grafana/mcp-grafana",
  "microsoft/playwright-mcp",
  "mongodb-js/mongodb-mcp-server",
  "supabase/mcp",
  "upstash/context7",
] as const);

const escapeRegExp = (value: string): string => {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
};

const includesKeyword = (haystack: string, keyword: string): boolean => {
  return new RegExp(
    `(^|[^a-z0-9])${escapeRegExp(keyword)}([^a-z0-9]|$)`,
    "u",
  ).test(haystack);
};

const normalizeMarketplaceRecommendationValue = (value: string): string => {
  return value.trim().toLowerCase().replace(/\.git$/u, "");
};

const getGitHubRepositoryPath = (value: string | undefined): string | null => {
  if (!value) {
    return null;
  }

  try {
    const url = new URL(value);

    if (url.hostname !== "github.com") {
      return null;
    }

    const [owner, repo] = url.pathname
      .replace(/^\/+|\/+$/gu, "")
      .split("/")
      .map((part) => part.trim())
      .filter(Boolean);

    return owner && repo
      ? normalizeMarketplaceRecommendationValue(`${owner}/${repo}`)
      : null;
  } catch {
    return null;
  }
};

export const getMcpMarketplaceDiscoveryRecommendationForServer = (
  server: Pick<McpMarketplaceDiscoveryServer, "name" | "repository">,
): McpMarketplaceDiscoveryRecommendation | null => {
  const serverName = normalizeMarketplaceRecommendationValue(server.name);
  const repositoryPath = getGitHubRepositoryPath(server.repository?.url);

  if (
    MCP_MARKETPLACE_RECOMMENDED_SERVER_NAMES.has(serverName) ||
    (repositoryPath &&
      MCP_MARKETPLACE_RECOMMENDED_REPOSITORIES.has(repositoryPath))
  ) {
    return {
      label: "Recommended",
      reason: "MachDoch curated pick based on broad utility, provider trust, and marketplace popularity signals.",
    };
  }

  return null;
};

export const getMcpMarketplaceDiscoveryCategoriesForServer = (
  server: Pick<McpMarketplaceDiscoveryServer, "name" | "title" | "description">,
): string[] => {
  const haystack = `${server.name} ${server.title ?? ""} ${server.description}`.toLowerCase();

  return MCP_MARKETPLACE_DISCOVERY_CATEGORIES.filter((category) => {
    return category.keywords.some((keyword) => includesKeyword(haystack, keyword));
  }).map((category) => category.id);
};
