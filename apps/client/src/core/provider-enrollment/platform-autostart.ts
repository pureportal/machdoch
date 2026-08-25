import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mkdir, rm, stat } from "node:fs/promises";
import { writeFileAtomically } from "../_helpers/write-file-atomically.helper.js";
import {
  resolveMachdochCliLaunch,
  type MachdochCliLaunch,
} from "./machdoch-cli-launch.js";

const quoteDesktopExec = (value: string): string =>
  `"${value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("`", "\\`")
    .replaceAll("$", "\\$")
    .replaceAll("%", "%%")}"`;
const escapeXml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
const escapeVbs = (value: string): string => value.replaceAll('"', '""');
const escapeDesktopValue = (value: string): string =>
  value
    .replaceAll("\\", "\\\\")
    .replaceAll("\n", "\\n")
    .replaceAll("\t", "\\t")
    .replaceAll("\r", "\\r")
    .replaceAll(" ", "\\s");

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
  launch: MachdochCliLaunch,
  args: readonly string[],
): string => {
  const commandArgs = [...launch.args, ...args];
  if (platform === "win32") {
    const command = [launch.command, ...commandArgs]
      .map(quoteWindowsArgument)
      .join(" ")
      .replaceAll('"', '""');
    return [
      "Dim shell",
      'Set shell = CreateObject("WScript.Shell")',
      `shell.CurrentDirectory = "${escapeVbs(launch.cwd)}"`,
      ...Object.entries(launch.environment).map(
        ([key, value]) =>
          `shell.Environment("Process")("${escapeVbs(key)}") = "${escapeVbs(value)}"`,
      ),
      `shell.Run "${command}", 0, False`,
      "",
    ].join("\r\n");
  }
  if (platform === "darwin") {
    const plistArgs = [launch.command, ...commandArgs]
      .map((value) => `      <string>${escapeXml(value)}</string>`)
      .join("\n");
    const plistEnvironment = Object.entries(launch.environment)
      .map(
        ([key, value]) =>
          `    <key>${escapeXml(key)}</key><string>${escapeXml(value)}</string>`,
      )
      .join("\n");
    return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n  <key>Label</key><string>com.machdoch.provider-sync</string>\n  <key>ProgramArguments</key>\n  <array>\n${plistArgs}\n  </array>\n  <key>WorkingDirectory</key><string>${escapeXml(launch.cwd)}</string>\n${plistEnvironment ? `  <key>EnvironmentVariables</key>\n  <dict>\n${plistEnvironment}\n  </dict>\n` : ""}  <key>RunAtLoad</key><true/>\n  <key>KeepAlive</key><true/>\n</dict>\n</plist>\n`;
  }
  const linuxCommand = [
    ...(Object.keys(launch.environment).length > 0
      ? [
          "env",
          ...Object.entries(launch.environment).map(
            ([key, value]) => `${key}=${value}`,
          ),
        ]
      : []),
    launch.command,
    ...commandArgs,
  ];
  return `[Desktop Entry]\nType=Application\nName=Machdoch Provider Sync\nPath=${escapeDesktopValue(launch.cwd)}\nExec=${linuxCommand.map(quoteDesktopExec).join(" ")}\nTerminal=false\nX-GNOME-Autostart-enabled=true\n`;
};

export const getProviderSyncAutostartPath = (): string => {
  if (process.platform === "win32") {
    return join(getWindowsStartupDirectory(), "machdoch-provider-sync.vbs");
  }
  if (process.platform === "darwin") {
    return join(
      homedir(),
      "Library",
      "LaunchAgents",
      "com.machdoch.provider-sync.plist",
    );
  }
  const configHome = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(configHome, "autostart", "machdoch-provider-sync.desktop");
};

const createAutostartContent = (workspaceRoot: string): string => {
  const launch = resolveMachdochCliLaunch();
  return renderProviderSyncAutostart(process.platform, launch, [
    "provider-sync",
    "daemon",
    "--cwd",
    workspaceRoot,
  ]);
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
  return await stat(getProviderSyncAutostartPath()).then(
    () => true,
    () => false,
  );
};
