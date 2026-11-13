import { getProductVersion } from "../../helpers/product-version.js";
import { checkLatestRelease } from "../../update/release.js";
import {
  installRelease,
  prepareReleaseInstallation,
} from "../../update/install-release.js";
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
  const { installerStarted } = await installRelease(
    await prepareReleaseInstallation(release),
  );
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
}
