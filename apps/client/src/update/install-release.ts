import { mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { withCooperativeFileLock } from "../core/_helpers/with-cooperative-file-lock.helper.js";
import { downloadUpdate } from "./download.js";
import {
  detectUpdateInstallation,
  launchNativeInstaller,
  type UpdateInstallation,
} from "./installation.js";
import {
  installAppImageUpdate,
  installHeadlessUpdate,
} from "./headless-install.js";
import { UPDATE_PUBLIC_KEY } from "./public-key.js";
import type { UpdateArtifact, UpdateRelease } from "./release.js";

export interface ReleaseInstallation {
  release: UpdateRelease;
  installation: UpdateInstallation;
  artifact: UpdateArtifact;
}

export async function prepareReleaseInstallation(
  release: UpdateRelease,
): Promise<ReleaseInstallation> {
  const installation = await detectUpdateInstallation();
  const artifact = release.platforms[installation.target];
  if (!artifact)
    throw new Error(
      `Release ${release.version} has no package for ${installation.target}.`,
    );
  return { release, installation, artifact };
}

export async function installRelease({
  release,
  installation,
  artifact,
}: ReleaseInstallation): Promise<{ installerStarted: boolean }> {
  const identity =
    process.platform === "win32"
      ? installation.path.toLowerCase()
      : installation.path;
  const lockPath = join(
    tmpdir(),
    `machdoch-update-${createHash("sha256").update(identity).digest("hex")}`,
  );
  return await withCooperativeFileLock(
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
        return { installerStarted };
      } finally {
        if (!installerStarted)
          await rm(stage, { recursive: true, force: true });
      }
    },
    { timeoutMs: 1000, ownerDescription: "Machdoch update" },
  );
}
