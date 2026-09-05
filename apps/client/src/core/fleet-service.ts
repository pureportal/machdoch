import { execFile } from "node:child_process";
import { lstat, mkdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, posix, resolve } from "node:path";
import { promisify } from "node:util";
import {
  getFleetConnectionPath,
  loadFleetConnectionConfig,
} from "./fleet-connection.js";
import { writeFileAtomically } from "./_helpers/write-file-atomically.helper.js";
import { withCooperativeFileLock } from "./_helpers/with-cooperative-file-lock.helper.js";
import {
  resolveMachdochCliLaunch,
  type MachdochCliLaunch,
} from "./provider-enrollment/machdoch-cli-launch.js";

export const FLEET_SERVICE_NAME = "machdoch-fleet.service";
const ownershipMarker = "# Managed by machdoch fleet service. Schema 1.";
const execFileAsync = promisify(execFile);

const validateValue = (value: string): string => {
  if (!value || /[\p{Cc}\p{Cf}]/u.test(value))
    throw new Error(
      "Fleet service paths and arguments must not contain control characters.",
    );
  return value;
};

// systemd has its own quoting, specifier, and environment expansion rules; no shell is involved.
const quoteUnitValue = (value: string, commandArgument = false): string =>
  `"${validateValue(value)
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("%", "%%")
    .replaceAll("$", () => (commandArgument ? "$$" : "$"))}"`;

export interface FleetServiceUnitOptions {
  launch: MachdochCliLaunch;
  workspaceRoot: string;
  configDirectory: string;
  homeDirectory: string;
  executablePath?: string;
}

export function renderFleetUserService(
  options: FleetServiceUnitOptions,
): string {
  const { launch, workspaceRoot, configDirectory, homeDirectory } = options;
  for (const path of [
    launch.command,
    workspaceRoot,
    configDirectory,
    homeDirectory,
  ]) {
    if (!isAbsolute(path))
      throw new Error("Fleet service paths must be absolute.");
    validateValue(path);
  }
  const command = [
    launch.command,
    ...launch.args,
    "fleet",
    "service",
    "run",
    "--cwd",
    workspaceRoot,
    "--json",
  ];
  // Capture only tool search paths, never the shell's provider keys or enrollment credentials.
  const path = [
    ...new Set(
      (options.executablePath ?? "/usr/local/bin:/usr/bin:/bin")
        .split(":")
        .filter((entry) => entry.startsWith("/"))
        .concat(["/usr/local/bin", "/usr/bin", "/bin"]),
    ),
  ].join(":");
  return [
    ownershipMarker,
    "[Unit]",
    "Description=Machdoch headless Fleet host",
    "StartLimitIntervalSec=300",
    "StartLimitBurst=5",
    "",
    "[Service]",
    "Type=exec",
    // Path directives take a literal path, unlike ExecStart/Environment word lists.
    // A slash preserves directory names ending in whitespace or backslash.
    `WorkingDirectory=${validateValue(workspaceRoot).replaceAll("%", "%%")}/`,
    `ExecStart=${command.map((argument) => quoteUnitValue(argument, true)).join(" ")}`,
    `Environment=${quoteUnitValue(`HOME=${homeDirectory}`)} ${quoteUnitValue(`MACHDOCH_USER_CONFIG_DIR=${configDirectory}`)} ${quoteUnitValue(`PATH=${path}`)}`,
    `EnvironmentFile=-${validateValue(posix.join(configDirectory, "fleet-service.env")).replaceAll("%", "%%")}`,
    "Restart=on-failure",
    "RestartSec=5",
    "RestartPreventExitStatus=78",
    "TimeoutStopSec=35",
    "KillMode=mixed",
    "SendSIGKILL=yes",
    "UMask=0077",
    "NoNewPrivileges=yes",
    "StandardInput=null",
    "StandardOutput=journal",
    "StandardError=journal",
    "SyslogIdentifier=machdoch-fleet",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

interface ServiceCommandResult {
  stdout: string;
}
export interface FleetServiceDependencies {
  platform: NodeJS.Platform;
  home: string;
  configHome: string;
  uid: number;
  launch: () => MachdochCliLaunch;
  configDirectory: () => string;
  enabled: () => Promise<boolean>;
  execute: (command: string, args: string[]) => Promise<ServiceCommandResult>;
}

const defaultDependencies = (): FleetServiceDependencies => ({
  platform: process.platform,
  home: homedir(),
  configHome: process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
  uid: process.getuid?.() ?? -1,
  launch: resolveMachdochCliLaunch,
  configDirectory: () => resolve(dirname(getFleetConnectionPath())),
  enabled: async () => Boolean((await loadFleetConnectionConfig())?.enabled),
  execute: async (command, args) => {
    try {
      return await execFileAsync(command, args, {
        timeout: 45_000,
        maxBuffer: 64 * 1024,
        encoding: "utf8",
        windowsHide: true,
        env: { ...process.env, SYSTEMD_PAGER: "cat", SYSTEMD_COLORS: "0" },
      });
    } catch (error) {
      const detail = (error as { stderr?: string }).stderr?.trim();
      throw new Error(
        `${command} failed${detail ? `: ${detail}` : ". Ensure systemd and the user service manager are available."}`,
        { cause: error },
      );
    }
  },
});

export type FleetServiceAction =
  | "install"
  | "uninstall"
  | "start"
  | "stop"
  | "restart"
  | "status"
  | "unit";

async function ownedUnit(path: string): Promise<string | null> {
  const metadata = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!metadata) return null;
  if (!metadata.isFile() || metadata.isSymbolicLink())
    throw new Error(`Fleet service unit is not a regular owned file: ${path}`);
  const content = await readFile(path, "utf8");
  if (!content.startsWith(`${ownershipMarker}\n`))
    throw new Error(
      `Refusing to replace or remove a service unit managed outside Machdoch: ${path}`,
    );
  return content;
}

export async function manageFleetService(
  action: FleetServiceAction,
  workspace: string,
  overrides: Partial<FleetServiceDependencies> = {},
): Promise<Record<string, unknown>> {
  const dependencies = { ...defaultDependencies(), ...overrides };
  if (dependencies.platform !== "linux")
    throw new Error(
      dependencies.platform === "win32"
        ? "Windows background use runs through the desktop tray. Enable Launch on sign-in and Start in tray in desktop settings. For a terminal-only session, use `machdoch fleet service run`."
        : "Automatic Fleet service management requires Linux with systemd. Run `machdoch fleet service run` under your process supervisor.",
    );
  if (dependencies.uid === 0 && action !== "unit")
    throw new Error(
      "Install the user service as its regular service account. For system-wide startup, use the dedicated-account systemd template in docs/fleet-background-service.md.",
    );
  if (!isAbsolute(dependencies.configHome))
    throw new Error(
      "XDG_CONFIG_HOME must be absolute for service installation.",
    );
  const unitPath = join(
    dependencies.configHome,
    "systemd",
    "user",
    FLEET_SERVICE_NAME,
  );
  const systemctl = (args: string[]) =>
    dependencies.execute("systemctl", ["--user", ...args]);
  if (action === "unit" || action === "install") {
    const workspaceRoot = await realpath(workspace);
    if (!(await stat(workspaceRoot)).isDirectory())
      throw new Error("Fleet service workspace must be a directory.");
    const unit = renderFleetUserService({
      launch: dependencies.launch(),
      workspaceRoot,
      configDirectory: dependencies.configDirectory(),
      homeDirectory: dependencies.home,
      ...(process.env.PATH ? { executablePath: process.env.PATH } : {}),
    });
    if (action === "unit") return { unitPath, unit };
    if (!(await dependencies.enabled()))
      throw new Error(
        "Enroll and enable this Fleet host before installing its service.",
      );
    await mkdir(dirname(unitPath), { recursive: true, mode: 0o700 });
    await withCooperativeFileLock(
      unitPath,
      async () => {
        const previous = await ownedUnit(unitPath);
        await systemctl(["show-environment"]);
        await writeFileAtomically(unitPath, unit, "utf8", { mode: 0o600 });
        try {
          await systemctl(["daemon-reload"]);
          await systemctl(["enable", FLEET_SERVICE_NAME]);
          await systemctl(["restart", FLEET_SERVICE_NAME]);
        } catch (error) {
          if (previous === null) {
            await systemctl(["disable", "--now", FLEET_SERVICE_NAME]).catch(
              () => undefined,
            );
            await rm(unitPath, { force: true });
          } else {
            await writeFileAtomically(unitPath, previous, "utf8", {
              mode: 0o600,
            });
          }
          await systemctl(["daemon-reload"]).catch(() => undefined);
          throw error;
        }
      },
      { ownerDescription: "Fleet service installation" },
    );
    return {
      installed: true,
      unitPath,
      service: FLEET_SERVICE_NAME,
      bootStartup:
        "Requires lingering: run loginctl enable-linger for this account to start at boot and survive logout.",
    };
  }
  if (action === "status") {
    const { stdout } = await systemctl([
      "show",
      FLEET_SERVICE_NAME,
      "--property=LoadState,ActiveState,SubState,UnitFileState,MainPID,ExecMainStatus",
      "--no-pager",
    ]);
    const properties = Object.fromEntries(
      stdout
        .trim()
        .split(/\r?\n/u)
        .filter(Boolean)
        .map((line) => {
          const index = line.indexOf("=");
          return [line.slice(0, index), line.slice(index + 1)];
        }),
    );
    let linger: string | null = null;
    try {
      linger = (
        await dependencies.execute("loginctl", [
          "show-user",
          String(dependencies.uid),
          "--property=Linger",
          "--value",
        ])
      ).stdout.trim();
    } catch {
      /* logind can be absent in containers */
    }
    return { unitPath, service: FLEET_SERVICE_NAME, ...properties, linger };
  }
  await withCooperativeFileLock(
    unitPath,
    async () => {
      const current = await ownedUnit(unitPath);
      if (current === null) {
        if (action === "uninstall") return;
        throw new Error("The Fleet user service is not installed.");
      }
      if (action === "uninstall") {
        await systemctl(["disable", "--now", FLEET_SERVICE_NAME]);
        await rm(unitPath);
        await systemctl(["daemon-reload"]);
      } else {
        await systemctl([action, FLEET_SERVICE_NAME]);
      }
    },
    { ownerDescription: "Fleet service management" },
  );
  return { service: FLEET_SERVICE_NAME, action, unitPath };
}
