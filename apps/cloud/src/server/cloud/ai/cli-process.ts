import { spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CloudCliProvider } from "@machdoch/fleet-protocol/cloud-providers";

export interface CliCommand {
  file: string;
  prefixArgs: string[];
}

const inheritedEnvironment = [
  "PATH",
  "Path",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "SystemRoot",
  "ComSpec",
  "PATHEXT",
  "TEMP",
  "TMP",
];

const cliSettings: Record<
  CloudCliProvider,
  {
    executable: () => string;
    homeVariable: string;
    keyVariable: string;
    environment: Record<string, string>;
  }
> = {
  "claude-code-cli": {
    executable: () => process.env.MACHDOCH_CLOUD_CLAUDE_CLI ?? "claude",
    homeVariable: "CLAUDE_CONFIG_DIR",
    keyVariable: "ANTHROPIC_API_KEY",
    environment: {},
  },
  "codex-cli": {
    executable: () => process.env.MACHDOCH_CLOUD_CODEX_CLI ?? "codex",
    homeVariable: "CODEX_HOME",
    keyVariable: "CODEX_API_KEY",
    environment: {},
  },
  "copilot-cli": {
    executable: () => process.env.MACHDOCH_CLOUD_COPILOT_CLI ?? "copilot",
    homeVariable: "COPILOT_HOME",
    keyVariable: "COPILOT_GITHUB_TOKEN",
    environment: { COPILOT_PLUGIN_DIR_ONLY: "true" },
  },
};

export const codexFileCredentials = [
  "--config",
  'cli_auth_credentials_store="file"',
];

export function defaultCliCommand(provider: CloudCliProvider): CliCommand {
  return { file: cliSettings[provider].executable(), prefixArgs: [] };
}

export function cliProviderHome(
  organizationId: string,
  providerId: string,
): string {
  return join(
    process.env.MACHDOCH_CLOUD_CLI_HOME ||
      join(homedir(), ".machdoch-cloud", "cli"),
    organizationId,
    providerId,
  );
}

export async function prepareCliHome(home: string): Promise<void> {
  await mkdir(home, { recursive: true, mode: 0o700 });
}

export function cliEnvironment(
  provider: CloudCliProvider,
  home: string,
  apiKey = "",
): NodeJS.ProcessEnv {
  const settings = cliSettings[provider];
  const environment: NodeJS.ProcessEnv = { NODE_ENV: process.env.NODE_ENV };
  for (const name of inheritedEnvironment)
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  Object.assign(environment, settings.environment, {
    [settings.homeVariable]: home,
  });
  if (apiKey) environment[settings.keyVariable] = apiKey;
  return environment;
}

export function stopProcessTree(pid: number | undefined): void {
  if (pid === undefined) return;
  if (process.platform === "win32")
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
  else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
}
