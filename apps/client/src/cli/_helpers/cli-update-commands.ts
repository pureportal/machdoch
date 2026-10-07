import { mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { getProductVersion } from "../../helpers/product-version.js";
import { withCooperativeFileLock } from "../../core/_helpers/with-cooperative-file-lock.helper.js";
import { checkLatestRelease } from "../../update/release.js";
import { downloadUpdate } from "../../update/download.js";
import {
  detectUpdateInstallation,
  launchNativeInstaller,
} from "../../update/installation.js";
import {
  installAppImageUpdate,
  installHeadlessUpdate,
} from "../../update/headless-install.js";
import { UPDATE_PUBLIC_KEY } from "../../update/public-key.js";
import type { ParsedCliArgs } from "./cli-args-types.js";
import { writeStdoutLine } from "./cli-io.js";

export async function runUpdateCommand(args: ParsedCliArgs): Promise<void> {
  const currentVersion = getProductVersion();
  const release = await checkLatestRelease(currentVersion);
  const result: Record<string, unknown> = {
    currentVersion,
    latestVersion: release?.version ?? currentVersion,
    updateAvailable: Boolean(release),
    installed: false,
  };
  if (!release || args.update?.check) {
    writeStdoutLine(
      args.json
        ? JSON.stringify(result)
        : release
          ? `Machdoch ${release.version} is available. Run machdoch update to install it.`
          : `Machdoch ${currentVersion} is up to date.`,
    );
    return;
  }
  const installation = await detectUpdateInstallation();
  const artifact = release.platforms[installation.target];
  if (!artifact)
    throw new Error(
      `Release ${release.version} has no package for ${installation.target}.`,
    );
  const identity =
    process.platform === "win32"
      ? installation.path.toLowerCase()
      : installation.path;
  const lockPath = join(
    tmpdir(),
    `machdoch-update-${createHash("sha256").update(identity).digest("hex")}`,
  );
  await withCooperativeFileLock(
    lockPath,
    async () => {
      const parent =
        installation.kind === "appimage"
          ? dirname(installation.path)
          : tmpdir();
      const stage = await mkdtemp(join(parent, "machdoch-update-"));
      let installerStarted = false;
      try {
        const downloaded = join(
          stage,
          basename(new URL(artifact.url).pathname),
        );
        await downloadUpdate(
          artifact,
          release.version,
          UPDATE_PUBLIC_KEY,
          downloaded,
        );
        if (installation.kind === "headless")
          await installHeadlessUpdate(
            installation.path,
            downloaded,
            release.version,
          );
        else if (installation.kind === "appimage")
          await installAppImageUpdate(installation.path, downloaded);
        else {
          await launchNativeInstaller(installation, downloaded);
          installerStarted =
            installation.kind === "msi" || installation.kind === "nsis";
        }
        result.installed = !installerStarted;
        result.installerStarted = installerStarted;
        result.restartRequired = true;
        writeStdoutLine(
          args.json
            ? JSON.stringify(result)
            : installerStarted
              ? `Installing Machdoch ${release.version}.`
              : `Updated to Machdoch ${release.version}. Restart running Machdoch services to use it.`,
        );
      } finally {
        if (!installerStarted)
          await rm(stage, { recursive: true, force: true });
      }
    },
    { timeoutMs: 1000, ownerDescription: "Machdoch update" },
  );
}
