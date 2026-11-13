import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReleaseInstallation } from "../../update/install-release.js";
import type { UpdateRelease } from "../../update/release.js";
import { FleetCliUpdater } from "./cli-fleet-update.js";

const mocks = vi.hoisted(() => ({
  checkLatestRelease: vi.fn(),
  prepareReleaseInstallation: vi.fn(),
  installRelease: vi.fn(),
}));

vi.mock("../../helpers/product-version.js", () => ({
  getProductVersion: () => "42.1.0",
}));
vi.mock("../../update/release.js", () => ({
  checkLatestRelease: mocks.checkLatestRelease,
}));
vi.mock("../../update/install-release.js", () => ({
  prepareReleaseInstallation: mocks.prepareReleaseInstallation,
  installRelease: mocks.installRelease,
}));

const release: UpdateRelease = { version: "42.2.0", notes: "", platforms: {} };
const installation = { release } as ReleaseInstallation;

const createUpdater = () => {
  const onInstalled = vi.fn();
  const onFailed = vi.fn();
  return {
    updater: new FleetCliUpdater({ onInstalled, onFailed }),
    onInstalled,
    onFailed,
  };
};

describe("FleetCliUpdater", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.checkLatestRelease.mockResolvedValue(release);
    mocks.prepareReleaseInstallation.mockResolvedValue(installation);
    mocks.installRelease.mockResolvedValue({ installerStarted: false });
  });

  it("reports the installed version when no newer release exists", async () => {
    mocks.checkLatestRelease.mockResolvedValue(null);
    const { updater } = createUpdater();

    await expect(updater.request()).resolves.toEqual({
      type: "appUpdate",
      status: "current",
      version: "42.1.0",
    });
    expect(mocks.checkLatestRelease).toHaveBeenCalledWith("42.1.0");
    expect(mocks.installRelease).not.toHaveBeenCalled();
  });

  it("responds before installation finishes and reports the installed version", async () => {
    let finish!: () => void;
    mocks.installRelease.mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    const { updater, onInstalled } = createUpdater();

    await expect(updater.request()).resolves.toEqual({
      type: "appUpdate",
      status: "installing",
      version: "42.2.0",
    });
    expect(mocks.installRelease).toHaveBeenCalledWith(installation);
    expect(onInstalled).not.toHaveBeenCalled();

    finish();
    await vi.waitFor(() => expect(onInstalled).toHaveBeenCalledWith("42.2.0"));
  });

  it("rejects overlapping requests while an installation runs", async () => {
    mocks.installRelease.mockReturnValue(new Promise(() => {}));
    const { updater } = createUpdater();

    await updater.request();

    await expect(updater.request()).resolves.toMatchObject({
      type: "error",
      code: "conflict",
    });
    expect(mocks.checkLatestRelease).toHaveBeenCalledTimes(1);
  });

  it("returns installation errors and accepts a new request afterwards", async () => {
    mocks.prepareReleaseInstallation.mockRejectedValueOnce(
      new Error("This installation has no matching update package."),
    );
    const { updater } = createUpdater();

    await expect(updater.request()).resolves.toEqual({
      type: "error",
      code: "unavailable",
      message: "This installation has no matching update package.",
    });
    await expect(updater.request()).resolves.toMatchObject({
      type: "appUpdate",
      status: "installing",
    });
  });

  it("reports failed installations and allows a retry", async () => {
    const failure = new Error("The update is incomplete or damaged.");
    mocks.installRelease.mockRejectedValueOnce(failure);
    const { updater, onFailed, onInstalled } = createUpdater();

    await updater.request();
    await vi.waitFor(() => expect(onFailed).toHaveBeenCalledWith(failure));
    expect(onInstalled).not.toHaveBeenCalled();

    await expect(updater.request()).resolves.toMatchObject({
      status: "installing",
    });
  });
});
