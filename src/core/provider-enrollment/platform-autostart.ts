import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mkdir, rm, stat } from "node:fs/promises";
import { writeFileAtomically } from "../_helpers/write-file-atomically.helper.js";

const quoteDesktopExec = (value: string): string => `"${value.replaceAll('"', '\\"')}"`;
const escapeXml = (value: string): string => value
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;");

const getWindowsStartupDirectory = (): string => {
  const appData = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
  return join(
    appData,
    "Microsoft",
    "Windows",
    "Start Menu",
    "Programs",
    "Startup",
  );
};

const quoteWindowsArgument = (value: string): string => {
  let result = '"';
  let backslashes = 0;
  for (const character of value) {
    if (character === "\\") {
      backslashes += 1;
      continue;
    }
    if (character === '"') {
      result += "\\".repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
      continue;
    }
    result += "\\".repeat(backslashes) + character;
    backslashes = 0;
  }
  return result + "\\".repeat(backslashes * 2) + '"';
};

export const renderProviderSyncAutostart = (
  platform: NodeJS.Platform,
  executable: string,
  args: readonly string[],
): string => {
  if (platform === "win32") {
    const command = [executable, ...args]
      .map(quoteWindowsArgument)
      .join(" ")
      .replaceAll('"', '""');
    // Startup .cmd files are launched by Explorer through the user's default
    // terminal. A WSH launcher starts the console executable with window style
    // 0 instead, so the long-running daemon remains genuinely background-only.
    return [
      "Dim shell",
      'Set shell = CreateObject("WScript.Shell")',
      `shell.Run "${command}", 0, False`,
      "",
    ].join("\r\n");
  }
  if (platform === "darwin") {
    const plistArgs = [executable, ...args]
      .map((value) => `      <string>${escapeXml(value)}</string>`)
      .join("\n");
    return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n  <key>Label</key><string>com.machdoch.provider-sync</string>\n  <key>ProgramArguments</key>\n  <array>\n${plistArgs}\n  </array>\n  <key>RunAtLoad</key><true/>\n  <key>KeepAlive</key><true/>\n</dict>\n</plist>\n`;
  }
  return `[Desktop Entry]\nType=Application\nName=Machdoch Provider Sync\nExec=${[executable, ...args].map(quoteDesktopExec).join(" ")}\nTerminal=false\nX-GNOME-Autostart-enabled=true\n`;
};

export const getProviderSyncAutostartPath = (): string => {
  if (process.platform === "win32") {
    return join(getWindowsStartupDirectory(), "machdoch-provider-sync.vbs");
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "LaunchAgents", "com.machdoch.provider-sync.plist");
  }
  const configHome = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(configHome, "autostart", "machdoch-provider-sync.desktop");
};

const getLegacyProviderSyncAutostartPaths = (): string[] => {
  return process.platform === "win32"
    ? [join(getWindowsStartupDirectory(), "machdoch-provider-sync.cmd")]
    : [];
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

  return renderProviderSyncAutostart(process.platform, executable, args);
};

export const installProviderSyncAutostart = async (
  workspaceRoot: string,
): Promise<string> => {
  const path = getProviderSyncAutostartPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFileAtomically(path, createAutostartContent(workspaceRoot));
  await Promise.all(
    getLegacyProviderSyncAutostartPaths().map((legacyPath) =>
      rm(legacyPath, { force: true })
    ),
  );
  return path;
};

export const removeProviderSyncAutostart = async (): Promise<void> => {
  await Promise.all([
    rm(getProviderSyncAutostartPath(), { force: true }),
    ...getLegacyProviderSyncAutostartPaths().map((path) =>
      rm(path, { force: true })
    ),
  ]);
};

export const isProviderSyncAutostartInstalled = async (): Promise<boolean> => {
  return await stat(getProviderSyncAutostartPath()).then(() => true, () => false);
};
