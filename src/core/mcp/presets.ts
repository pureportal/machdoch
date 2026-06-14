import type { McpPresetDefinition } from "./types.js";

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
    id: "github-remote",
    title: "GitHub Remote",
    description:
      "GitHub's hosted MCP endpoint for repository, issue, pull request, workflow, and code context operations.",
    server: {
      id: "github",
      title: "GitHub Remote",
      description:
        "Official remote GitHub MCP endpoint. Configure a PAT in GITHUB_PAT or set auth.token directly.",
      enabled: false,
      preset: "github-remote",
      transport: {
        type: "streamable-http",
        url: "https://api.githubcopilot.com/mcp/",
        legacySseFallback: true,
      },
      auth: {
        type: "bearer",
        tokenEnv: "GITHUB_PAT",
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
        "Official GitHub MCP Docker image. Requires Docker and GITHUB_PAT.",
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
          GITHUB_PERSONAL_ACCESS_TOKEN: "${env:GITHUB_PAT}",
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
        args: ["-y", "chrome-devtools-mcp@latest"],
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
  return MCP_PRESETS.map((preset) => ({
    ...preset,
    server: {
      ...preset.server,
      transport: { ...preset.server.transport },
      ...(preset.server.auth ? { auth: { ...preset.server.auth } } : {}),
      ...(preset.server.exposure
        ? { exposure: { ...preset.server.exposure } }
        : {}),
      ...(preset.server.toolOverrides
        ? { toolOverrides: { ...preset.server.toolOverrides } }
        : {}),
    },
  }));
};
