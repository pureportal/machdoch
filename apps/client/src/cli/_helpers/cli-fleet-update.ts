import type { HostResponse } from "@machdoch/fleet-protocol";
import { getProductVersion } from "../../helpers/product-version.js";
import {
  installRelease,
  prepareReleaseInstallation,
} from "../../update/install-release.js";
import { checkLatestRelease } from "../../update/release.js";

export class FleetCliUpdater {
  private busy = false;

  constructor(
    private readonly options: {
      onInstalled: (version: string) => void;
      onFailed: (error: unknown) => void;
    },
  ) {}

  async request(): Promise<HostResponse> {
    if (this.busy)
      return {
        type: "error",
        code: "conflict",
        message: "An update is already in progress.",
      };
    this.busy = true;
    let installing = false;
    try {
      const currentVersion = getProductVersion();
      const release = await checkLatestRelease(currentVersion);
      if (!release)
        return {
          type: "appUpdate",
          status: "current",
          version: currentVersion,
        };
      const installation = await prepareReleaseInstallation(release);
      installing = true;
      void installRelease(installation).then(
        () => this.options.onInstalled(release.version),
        (error: unknown) => {
          this.busy = false;
          this.options.onFailed(error);
        },
      );
      return {
        type: "appUpdate",
        status: "installing",
        version: release.version,
      };
    } catch (error) {
      return {
        type: "error",
        code: "unavailable",
        message:
          error instanceof Error
            ? error.message
            : "The update could not be started.",
      };
    } finally {
      if (!installing) this.busy = false;
    }
  }
}
