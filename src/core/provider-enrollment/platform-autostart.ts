import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mkdir, rm, stat } from "node:fs/promises";
import { writeFileAtomically } from "../_helpers/write-file-atomically.helper.js";

const quoteWindows = (value: string): string => `"${value.replaceAll('"', '""')}"`;
const quoteDesktopExec = (value: string): string => `"${value.replaceAll('"', '\\"')}"`;
const escapeXml = (value: string): string => value
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;");

export const getProviderSyncAutostartPath = (): string => {
  if (process.platform === "win32") {
    const appData = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
    return join(
      appData,
      "Microsoft",
      "Windows",
      "Start Menu",
      "Programs",
      "Startup",
      "machdoch-provider-sync.cmd",
    );
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "LaunchAgents", "com.machdoch.provider-sync.plist");
  }
  const configHome = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(configHome, "autostart", "machdoch-provider-sync.desktop");
};

const createAutostartContent = (workspaceRoot: string): string => {
  const configuredCli = process.env.MACHDOCH_CLI_PATH?.trim();
  const executable = configuredCli || process.execPath;
  const script = process.argv[1] ?? "dist/cli/main.js";
  const args = [
    ...(configuredCli ? [] : [...process.execArgv, script]),
    "provider-sync",
    "daemon",
    "--cwd",
    workspaceRoot,
  ];

  if (process.platform === "win32") {
    return `@echo off\r\nstart "" /b ${quoteWindows(executable)} ${args.map(quoteWindows).join(" ")}\r\n`;
  }
  if (process.platform === "darwin") {
    const plistArgs = [executable, ...args]
      .map((value) => `      <string>${escapeXml(value)}</string>`)
      .join("\n");
    return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n  <key>Label</key><string>com.machdoch.provider-sync</string>\n  <key>ProgramArguments</key>\n  <array>\n${plistArgs}\n  </array>\n  <key>RunAtLoad</key><true/>\n  <key>KeepAlive</key><true/>\n</dict>\n</plist>\n`;
  }
  return `[Desktop Entry]\nType=Application\nName=Machdoch Provider Sync\nExec=${[executable, ...args].map(quoteDesktopExec).join(" ")}\nTerminal=false\nX-GNOME-Autostart-enabled=true\n`;
};

export const installProviderSyncAutostart = async (
  workspaceRoot: string,
): Promise<string> => {
  const path = getProviderSyncAutostartPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFileAtomically(path, createAutostartContent(workspaceRoot));
  return path;
};

export const removeProviderSyncAutostart = async (): Promise<void> => {
  await rm(getProviderSyncAutostartPath(), { force: true });
};

export const isProviderSyncAutostartInstalled = async (): Promise<boolean> => {
  return await stat(getProviderSyncAutostartPath()).then(() => true, () => false);
};
