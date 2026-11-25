export const DEFAULT_MCP_CLIENT_NAME = "machdoch";

export interface McpClientNamePreset {
  label: string;
  clientName: string;
}

export const MCP_CLIENT_NAME_PRESETS: readonly McpClientNamePreset[] = [
  { label: "Claude Code", clientName: "Claude Code" },
  { label: "Claude Desktop", clientName: "Claude Desktop" },
  { label: "Codex", clientName: "Codex" },
  { label: "Cursor", clientName: "Cursor" },
  { label: "Visual Studio Code", clientName: "Visual Studio Code" },
  { label: "GitHub Copilot CLI", clientName: "GitHub Copilot CLI" },
  { label: "Gemini CLI", clientName: "Gemini CLI MCP Client" },
  { label: "Windsurf", clientName: "Windsurf" },
  { label: "Cline", clientName: "Cline" },
  { label: "OpenCode", clientName: "opencode" },
];

export const resolveMcpClientName = (server: { clientName?: string }): string =>
  server.clientName ?? DEFAULT_MCP_CLIENT_NAME;
