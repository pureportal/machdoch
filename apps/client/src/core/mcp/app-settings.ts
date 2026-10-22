import { dirname, join } from "node:path";
import {
  readFileSync,
  mkdirSync,
  writeFileSync,
  renameSync,
  lstatSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { getUserConfigPath } from "../env.js";

const settingsPath = (): string =>
  join(dirname(getUserConfigPath()), "mcp-apps.json");

export function mcpAppsEnabled(): boolean {
  const path = settingsPath();
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1024)
      throw new Error("MCP Apps settings are invalid.");
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (
      !value ||
      typeof value !== "object" ||
      !("enabled" in value) ||
      typeof value.enabled !== "boolean"
    )
      throw new Error("MCP Apps settings are invalid.");
    return value.enabled;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

export function setMcpAppsEnabled(enabled: boolean): { enabled: boolean } {
  const path = settingsPath();
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify({ enabled }), {
    flag: "wx",
    mode: 0o600,
  });
  renameSync(temporary, path);
  return { enabled };
}
