const TOML_BARE_KEY = /^[A-Za-z0-9_-]+$/u;

export const quoteTomlKey = (value: string): string => {
  return TOML_BARE_KEY.test(value) ? value : JSON.stringify(value);
};

const serializeTomlValue = (value: unknown): string => {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.map(serializeTomlValue).join(", ")}]`;
  if (typeof value === "object" && value !== null) {
    return `{ ${Object.entries(value as Record<string, unknown>)
      .map(([key, entry]) => `${quoteTomlKey(key)} = ${serializeTomlValue(entry)}`)
      .join(", ")} }`;
  }
  throw new Error(`Cannot serialize ${String(value)} as TOML.`);
};

export const renderCodexMcpToml = (
  mcpServers: Record<string, unknown>,
): string => {
  const sections: string[] = [];
  for (const [serverId, rawConfig] of Object.entries(mcpServers)) {
    if (typeof rawConfig !== "object" || rawConfig === null || Array.isArray(rawConfig)) {
      continue;
    }
    sections.push(`[mcp_servers.${quoteTomlKey(serverId)}]`);
    for (const [key, value] of Object.entries(rawConfig as Record<string, unknown>)) {
      if (value !== undefined) {
        sections.push(`${quoteTomlKey(key)} = ${serializeTomlValue(value)}`);
      }
    }
    sections.push("");
  }
  return sections.join("\n").trim();
};
