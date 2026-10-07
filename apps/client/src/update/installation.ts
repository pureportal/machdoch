import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { readFile, realpath } from "node:fs/promises";
import { dirname } from "node:path";

const execute = promisify(execFile);

export interface UpdateInstallation {
  kind: "headless" | "appimage" | "deb" | "rpm" | "msi" | "nsis";
  path: string;
  target: string;
}

export async function detectUpdateInstallation(): Promise<UpdateInstallation> {
  const architecture =
    process.arch === "x64"
      ? "x86_64"
      : process.arch === "arm64"
        ? "aarch64"
        : undefined;
  if (!architecture)
    throw new Error(`Updates are not published for ${process.arch}.`);
  const headless = process.env.MACHDOCH_HEADLESS_ROOT;
  if (headless && process.platform === "linux") {
    const path = await realpath(headless);
    const executable = await realpath(process.argv[1]!);
    const active = (await readFile(`${path}/current`, "utf8")).trim();
    if (executable !== `${path}/releases/${active}/machdoch-cli.cjs`)
      throw new Error(
        "The headless launcher does not match the active release.",
      );
    return { kind: "headless", path, target: "linux-headless" };
  }
  if (!process.env.MACHDOCH_NATIVE_EXECUTABLE)
    throw new Error(
      "Self-update requires an installed Machdoch release. Update a source checkout with Git.",
    );
  if (process.platform === "linux" && process.env.APPIMAGE) {
    return {
      kind: "appimage",
      path: await realpath(process.env.APPIMAGE),
      target: `linux-${architecture}-appimage`,
    };
  }
  const kind = process.env.MACHDOCH_INSTALLER_KIND;
  const path = await realpath(process.env.MACHDOCH_NATIVE_EXECUTABLE);
  if (
    (process.platform === "linux" && (kind === "deb" || kind === "rpm")) ||
    (process.platform === "win32" && (kind === "msi" || kind === "nsis"))
  ) {
    return {
      kind,
      path,
      target: `${process.platform === "win32" ? "windows" : "linux"}-${architecture}-${kind}`,
    };
  }
  throw new Error("This installation has no matching update package.");
}

export async function launchNativeInstaller(
  installation: UpdateInstallation,
  packagePath: string,
): Promise<void> {
  if (installation.kind === "deb" || installation.kind === "rpm") {
    const command =
      installation.kind === "deb" ? "/usr/bin/apt-get" : "/usr/bin/dnf";
    const args = ["install", "-y", packagePath];
    const root = process.getuid?.() === 0;
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        root ? command : "sudo",
        root ? args : ["--", command, ...args],
        {
          stdio: ["inherit", process.stderr, process.stderr],
          windowsHide: true,
        },
      );
      child.once("error", reject);
      child.once("exit", (code, signal) =>
        code === 0
          ? resolve()
          : reject(
              new Error(
                `Package installation failed (${signal ?? code}). Resolve the package manager error and run machdoch update again.`,
              ),
            ),
      );
    });
    return;
  }
  if (installation.kind !== "msi" && installation.kind !== "nsis")
    throw new Error("Invalid native installer type.");
  const script =
    installation.kind === "msi"
      ? String.raw`Start-Process -FilePath "$env:SystemRoot\System32\msiexec.exe" -ArgumentList @("/i", ([char]34 + $env:MACHDOCH_UPDATE_PACKAGE + [char]34), "/passive", "/norestart") -WindowStyle Hidden -ErrorAction Stop`
      : 'Start-Process -FilePath $env:MACHDOCH_UPDATE_PACKAGE -ArgumentList @("/P", "/UPDATE", ("/D=" + $env:MACHDOCH_UPDATE_DIRECTORY)) -WindowStyle Hidden -ErrorAction Stop';
  await execute(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    {
      timeout: 30_000,
      windowsHide: true,
      env: {
        ...process.env,
        MACHDOCH_UPDATE_PACKAGE: packagePath,
        MACHDOCH_UPDATE_DIRECTORY: dirname(installation.path),
      },
    },
  );
}
