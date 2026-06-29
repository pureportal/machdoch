import type { McpPresetDefinition } from "./types.js";
import { cloneMcpPreset } from "./_helpers/clone-mcp-preset.helper.js";

const DEFAULT_MCP_OAUTH_REDIRECT_URL =
  "http://127.0.0.1:43110/oauth/callback";

export const MCP_PRESETS: readonly McpPresetDefinition[] = [
  {
    id: "serper-search",
    title: "Serper Search",
    description:
      "Google search, image, video, news, shopping, and places search through the Serper API.",
    server: {
      id: "serper",
      title: "Serper Search",
      description:
        "Serper-backed web search MCP server. Requires SERPER_API_KEY.",
      enabled: false,
      preset: "serper-search",
      transport: {
        type: "stdio",
        command: "npx",
        args: ["-y", "serper-search-mcp@latest"],
        env: {
          SERPER_API_KEY: "${env:SERPER_API_KEY}",
        },
        stderr: "pipe",
      },
      exposure: {
        mode: "hybrid",
        directTools: true,
      },
      securityProfile: "weak",
      timeoutMs: 60_000,
      maxTotalTimeoutMs: 180_000,
      maxResponseChars: 40_000,
      cache: {
        enabled: true,
        ttlMs: 900_000,
        forceRefresh: false,
      },
    },
  },
  {
    id: "context7-docs",
    title: "Context7 Docs",
    description:
      "Up-to-date library documentation and code examples from Context7.",
    server: {
      id: "context7",
      title: "Context7 Docs",
      description:
        "Context7 remote MCP server. Optionally set CONTEXT7_API_KEY for higher limits and private repositories.",
      enabled: false,
      preset: "context7-docs",
      transport: {
        type: "streamable-http",
        url: "https://mcp.context7.com/mcp",
      },
      auth: {
        type: "headers",
        envHeaders: {
          CONTEXT7_API_KEY: "CONTEXT7_API_KEY",
        },
      },
      exposure: {
        mode: "hybrid",
        directTools: true,
      },
      securityProfile: "weak",
      timeoutMs: 60_000,
      maxTotalTimeoutMs: 180_000,
      maxResponseChars: 60_000,
      cache: {
        enabled: true,
        ttlMs: 900_000,
        forceRefresh: false,
      },
    },
  },
  {
    id: "firecrawl-web",
    title: "Firecrawl Web",
    description:
      "Web search, scraping, crawling, and structured extraction through Firecrawl.",
    server: {
      id: "firecrawl",
      title: "Firecrawl Web",
      description:
        "Official Firecrawl MCP server. Requires FIRECRAWL_API_KEY.",
      enabled: false,
      preset: "firecrawl-web",
      transport: {
        type: "stdio",
        command: "npx",
        args: ["-y", "firecrawl-mcp@latest"],
        env: {
          FIRECRAWL_API_KEY: "${env:FIRECRAWL_API_KEY}",
        },
        stderr: "pipe",
      },
      exposure: {
        mode: "hybrid",
        directTools: true,
      },
      securityProfile: "weak",
      timeoutMs: 60_000,
      maxTotalTimeoutMs: 300_000,
      maxResponseChars: 80_000,
      cache: {
        enabled: true,
        ttlMs: 900_000,
        forceRefresh: false,
      },
    },
  },
  {
    id: "linear-remote",
    title: "Linear Remote",
    description:
      "Linear project management, issue tracking, and team workflow tools.",
    server: {
      id: "linear",
      title: "Linear Remote",
      description:
        "Official hosted Linear MCP endpoint with OAuth authorization.",
      enabled: false,
      preset: "linear-remote",
      transport: {
        type: "streamable-http",
        url: "https://mcp.linear.app/mcp",
        legacySseFallback: true,
      },
      auth: {
        type: "oauth",
        redirectUrl: DEFAULT_MCP_OAUTH_REDIRECT_URL,
        scopes: ["read", "write"],
      },
      exposure: {
        mode: "hybrid",
        directTools: true,
      },
      securityProfile: "weak",
      timeoutMs: 60_000,
      maxTotalTimeoutMs: 240_000,
      maxResponseChars: 60_000,
    },
  },
  {
    id: "figma-remote",
    title: "Figma Remote",
    description:
      "Figma design context for implementing and inspecting product UI.",
    server: {
      id: "figma",
      title: "Figma Remote",
      description:
        "Official hosted Figma MCP endpoint with OAuth authorization.",
      enabled: false,
      preset: "figma-remote",
      transport: {
        type: "streamable-http",
        url: "https://mcp.figma.com/mcp",
      },
      auth: {
        type: "oauth",
        redirectUrl: DEFAULT_MCP_OAUTH_REDIRECT_URL,
        scopes: ["mcp:connect"],
      },
      exposure: {
        mode: "hybrid",
        directTools: true,
      },
      securityProfile: "weak",
      timeoutMs: 60_000,
      maxTotalTimeoutMs: 240_000,
      maxResponseChars: 80_000,
    },
  },
  {
    id: "notion-remote",
    title: "Notion Remote",
    description:
      "Notion workspace pages, databases, and project knowledge through Notion MCP.",
    server: {
      id: "notion",
      title: "Notion Remote",
      description:
        "Official hosted Notion MCP endpoint with OAuth authorization.",
      enabled: false,
      preset: "notion-remote",
      transport: {
        type: "streamable-http",
        url: "https://mcp.notion.com/mcp",
        legacySseFallback: true,
      },
      auth: {
        type: "oauth",
        redirectUrl: DEFAULT_MCP_OAUTH_REDIRECT_URL,
      },
      exposure: {
        mode: "hybrid",
        directTools: true,
      },
      securityProfile: "weak",
      timeoutMs: 60_000,
      maxTotalTimeoutMs: 240_000,
      maxResponseChars: 80_000,
    },
  },
  {
    id: "sentry-remote",
    title: "Sentry Remote",
    description:
      "Sentry issue, project, event, and debugging context for production diagnostics.",
    server: {
      id: "sentry",
      title: "Sentry Remote",
      description:
        "Official hosted Sentry MCP endpoint with OAuth authorization.",
      enabled: false,
      preset: "sentry-remote",
      transport: {
        type: "streamable-http",
        url: "https://mcp.sentry.dev/mcp",
      },
      auth: {
        type: "oauth",
        redirectUrl: DEFAULT_MCP_OAUTH_REDIRECT_URL,
        scopes: ["org:read", "project:write", "team:write", "event:write"],
      },
      exposure: {
        mode: "hybrid",
        directTools: true,
      },
      securityProfile: "weak",
      timeoutMs: 60_000,
      maxTotalTimeoutMs: 240_000,
      maxResponseChars: 80_000,
    },
  },
  {
    id: "supabase-remote",
    title: "Supabase Remote",
    description:
      "Supabase project, database, analytics, edge function, and storage context.",
    server: {
      id: "supabase",
      title: "Supabase Remote",
      description:
        "Official hosted Supabase MCP endpoint with OAuth authorization.",
      enabled: false,
      preset: "supabase-remote",
      transport: {
        type: "streamable-http",
        url: "https://mcp.supabase.com/mcp",
      },
      auth: {
        type: "oauth",
        redirectUrl: DEFAULT_MCP_OAUTH_REDIRECT_URL,
        scopes: [
          "organizations:read",
          "projects:read",
          "projects:write",
          "database:write",
          "database:read",
          "analytics:read",
          "secrets:read",
          "edge_functions:read",
          "edge_functions:write",
          "environment:read",
          "environment:write",
          "storage:read",
        ],
      },
      exposure: {
        mode: "hybrid",
        directTools: true,
      },
      securityProfile: "weak",
      timeoutMs: 60_000,
      maxTotalTimeoutMs: 300_000,
      maxResponseChars: 100_000,
    },
  },
  {
    id: "gitlab-remote",
    title: "GitLab Remote",
    description:
      "GitLab repository, merge request, issue, and CI context through GitLab MCP.",
    server: {
      id: "gitlab",
      title: "GitLab Remote",
      description:
        "Official hosted GitLab MCP endpoint with OAuth authorization.",
      enabled: false,
      preset: "gitlab-remote",
      transport: {
        type: "streamable-http",
        url: "https://gitlab.com/api/v4/mcp",
      },
      auth: {
        type: "oauth",
        redirectUrl: DEFAULT_MCP_OAUTH_REDIRECT_URL,
        scopes: ["mcp"],
      },
      exposure: {
        mode: "hybrid",
        directTools: true,
      },
      securityProfile: "weak",
      timeoutMs: 60_000,
      maxTotalTimeoutMs: 240_000,
      maxResponseChars: 80_000,
    },
  },
  {
    id: "github-remote",
    title: "GitHub Remote",
    description:
      "GitHub's hosted MCP endpoint for repository, issue, pull request, workflow, and code context operations.",
    server: {
      id: "github",
      title: "GitHub Remote",
      description:
        "Official remote GitHub MCP endpoint. Requires GITHUB_PERSONAL_ACCESS_TOKEN or set auth.token directly.",
      enabled: false,
      preset: "github-remote",
      transport: {
        type: "streamable-http",
        url: "https://api.githubcopilot.com/mcp/",
        legacySseFallback: true,
      },
      auth: {
        type: "bearer",
        tokenEnv: "GITHUB_PERSONAL_ACCESS_TOKEN",
      },
      exposure: {
        mode: "hybrid",
        directTools: true,
      },
      securityProfile: "weak",
      timeoutMs: 60_000,
      maxTotalTimeoutMs: 240_000,
      maxResponseChars: 60_000,
    },
  },
  {
    id: "github-local-docker",
    title: "GitHub Local Docker",
    description:
      "Official GitHub MCP server running locally through Docker for customizable local hosting.",
    server: {
      id: "github-local",
      title: "GitHub Local Docker",
      description:
        "Official GitHub MCP Docker image. Requires Docker and GITHUB_PERSONAL_ACCESS_TOKEN.",
      enabled: false,
      preset: "github-local-docker",
      transport: {
        type: "stdio",
        command: "docker",
        args: [
          "run",
          "-i",
          "--rm",
          "-e",
          "GITHUB_PERSONAL_ACCESS_TOKEN",
          "ghcr.io/github/github-mcp-server",
        ],
        env: {
          GITHUB_PERSONAL_ACCESS_TOKEN: "${env:GITHUB_PERSONAL_ACCESS_TOKEN}",
        },
        stderr: "pipe",
      },
      exposure: {
        mode: "hybrid",
        directTools: true,
      },
      securityProfile: "weak",
      timeoutMs: 60_000,
      maxTotalTimeoutMs: 240_000,
      maxResponseChars: 60_000,
    },
  },
  {
    id: "chrome-devtools",
    title: "Chrome DevTools",
    description:
      "Chrome DevTools MCP server for inspecting and controlling browser pages through Chrome DevTools.",
    server: {
      id: "chrome",
      title: "Chrome DevTools",
      description:
        "Chrome DevTools MCP server. It can inspect pages and perform browser actions.",
      enabled: false,
      preset: "chrome-devtools",
      transport: {
        type: "stdio",
        command: "npx",
        args: ["-y", "chrome-devtools-mcp@latest", "--isolated"],
        stderr: "pipe",
      },
      exposure: {
        mode: "hybrid",
        directTools: true,
      },
      securityProfile: "weak",
      timeoutMs: 60_000,
      maxTotalTimeoutMs: 240_000,
      maxResponseChars: 80_000,
    },
  },
  {
    id: "playwright-browser",
    title: "Playwright Browser",
    description:
      "Playwright MCP browser tools for page navigation, screenshots, accessibility snapshots, and browser interaction.",
    server: {
      id: "playwright",
      title: "Playwright Browser",
      description:
        "Playwright MCP server for browser automation. Useful as a browser MCP alternative to Chrome DevTools.",
      enabled: false,
      preset: "playwright-browser",
      transport: {
        type: "stdio",
        command: "npx",
        args: ["-y", "@playwright/mcp@latest"],
        stderr: "pipe",
      },
      exposure: {
        mode: "hybrid",
        directTools: true,
      },
      securityProfile: "weak",
      timeoutMs: 60_000,
      maxTotalTimeoutMs: 240_000,
      maxResponseChars: 80_000,
    },
  },
  {
    id: "tauri-mcp-server",
    title: "Tauri MCP Server",
    description:
      "Tauri v2 development MCP server for app screenshots, DOM/webview automation, console logs, window state, and IPC monitoring.",
    server: {
      id: "tauri",
      title: "Tauri MCP Server",
      description:
        "Hypothesi Tauri MCP server. Requires the debug MCP bridge plugin in the running Tauri app.",
      enabled: false,
      preset: "tauri-mcp-server",
      transport: {
        type: "stdio",
        command: "npx",
        args: ["-y", "@hypothesi/tauri-mcp-server"],
        cwd: "${workspaceRoot}",
        inheritEnvironment: true,
        stderr: "pipe",
      },
      exposure: {
        mode: "hybrid",
        directTools: true,
      },
      securityProfile: "weak",
      timeoutMs: 60_000,
      maxTotalTimeoutMs: 300_000,
      maxResponseChars: 120_000,
      toolOverrides: {
        get_setup_instructions: {
          effect: "external-read",
          riskLevel: "low",
          readOnlyInAskMode: true,
        },
        read_logs: {
          effect: "external-read",
          riskLevel: "medium",
          readOnlyInAskMode: true,
        },
        webview_find_element: {
          effect: "external-read",
          riskLevel: "low",
          readOnlyInAskMode: true,
        },
        webview_screenshot: {
          effect: "external-read",
          riskLevel: "medium",
          readOnlyInAskMode: true,
        },
        webview_wait_for: {
          effect: "external-read",
          riskLevel: "low",
          readOnlyInAskMode: true,
        },
        webview_get_styles: {
          effect: "external-read",
          riskLevel: "low",
          readOnlyInAskMode: true,
        },
        webview_dom_snapshot: {
          effect: "external-read",
          riskLevel: "medium",
          readOnlyInAskMode: true,
        },
        webview_select_element: {
          effect: "external-read",
          riskLevel: "medium",
          readOnlyInAskMode: true,
        },
        webview_get_pointed_element: {
          effect: "external-read",
          riskLevel: "low",
          readOnlyInAskMode: true,
        },
        ipc_get_backend_state: {
          effect: "external-read",
          riskLevel: "medium",
          readOnlyInAskMode: true,
        },
        ipc_get_captured: {
          effect: "external-read",
          riskLevel: "medium",
          readOnlyInAskMode: true,
        },
        list_devices: {
          effect: "external-read",
          riskLevel: "medium",
          readOnlyInAskMode: true,
        },
      },
    },
  },
] as const;

export const getMcpPreset = (
  presetId: string,
): McpPresetDefinition | undefined => {
  return MCP_PRESETS.find((preset) => preset.id === presetId);
};

export const listMcpPresets = (): McpPresetDefinition[] => {
  return MCP_PRESETS.map(cloneMcpPreset);
};
